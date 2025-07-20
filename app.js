// Load environment variables from .env file (for local development)
// In Cloud Run, environment variables are set directly and .env is not used.
require('dotenv').config();

const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');
const JSONStream = require('jsonstream');
const admin = require('firebase-admin'); // Import Firebase Admin SDK
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager'); // Import Secret Manager Client

// Initialize Secret Manager client
const secretManagerClient = new SecretManagerServiceClient();

// --- Function to fetch secret from Secret Manager ---
async function getSecret(projectId, secretId) {
    // Use the correct resource name format for Secret Manager API
    const name = `projects/${projectId}/secrets/${secretId}/versions/latest`;
    try {
        const [version] = await secretManagerClient.accessSecretVersion({ name });
        // The payload data is a Buffer, convert it to a string
        return version.payload.data.toString('utf8');
    } catch (error) {
        console.error(`ERROR: Failed to access secret "${secretId}" in project "${projectId}":`, error.message);
        throw new Error(`Could not fetch secret: ${secretId}. Ensure Cloud Run service account has 'Secret Manager Secret Accessor' role.`);
    }
}

const app = express();
const PORT = process.env.PORT || 8080;

// Retrieve API key from environment variables (set directly in Cloud Run)
const apiKey = process.env.GEMINI_API_KEY; // Removed || "" - ensure it's set in Cloud Run

if (!apiKey) {
    console.error("ERROR: GEMINI_API_KEY environment variable is not set. Exiting.");
    process.exit(1);
}

// --- Firebase Admin SDK Initialization (ASYNC PROCESS) ---
async function initializeFirebase() {
    const projectId = process.env.GCP_PROJECT_ID;
    const secretId = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_ID;

    if (!projectId || !secretId) {
        console.error('ERROR: Missing environment variables for Firebase Secret Manager access.');
        console.error('Ensure GCP_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_KEY_ID are set in Cloud Run environment variables.');
        process.exit(1); // Cannot proceed without crucial config
    }

    try {
        console.log(`Attempting to fetch Firebase service account key from Secret Manager: Project '${projectId}', Secret ID '${secretId}'`);
        const secretString = await getSecret(projectId, secretId);
        const serviceAccount = JSON.parse(secretString);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('Firebase Admin SDK initialized successfully via Secret Manager.');
    } catch (error) {
        console.error('CRITICAL ERROR: Failed to initialize Firebase Admin SDK using Secret Manager. Application cannot start.', error);
        process.exit(1); // Force exit if Firebase fails to init
    }
}
// --- End Firebase Admin SDK Initialization ---


// Create an HTTP server from the Express app
const server = http.createServer(app);

// Create a WebSocket server instance
const wss = new WebSocket.Server({ server });

// --- Start the Application AFTER Firebase is initialized ---
initializeFirebase().then(() => {
    console.log('All critical services (Firebase) initialized. Starting application...');

    // Middleware to parse JSON request bodies
    app.use(express.json());

    // Serve static files from the 'public' directory
    app.use(express.static(path.join(__dirname, 'public')));

    // Explicitly serve index.html for the root path
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // WebSocket connection handling
    wss.on('connection', (ws) => {
        console.log('Client connected via WebSocket. Awaiting authentication...');
        let isAuthenticated = false;
        let userId = 'unauthenticated'; // Default user ID

        // Listen for the first message to be an authentication token
        ws.once('message', async (message) => {
            try {
                const authData = JSON.parse(message);

                if (authData.type === 'auth' && authData.token) {
                    try {
                        const decodedToken = await admin.auth().verifyIdToken(authData.token);
                        userId = decodedToken.uid;
                        isAuthenticated = true;
                        console.log(`Client authenticated: User ID ${userId}`);
                        ws.send(JSON.stringify({ status: 'authenticated', userId: userId })); // Confirm auth to client
                    } catch (error) {
                        console.error('Firebase ID token verification failed:', error.message);
                        ws.send(JSON.stringify({ error: 'Authentication failed: Invalid token.' }));
                        ws.close(1008, 'Authentication failed'); // Close with protocol error
                        return;
                    }
                } else {
                    console.warn('First message was not an authentication request or missing token.');
                    ws.send(JSON.stringify({ error: 'Authentication required. Send token as first message.' }));
                    ws.close(1008, 'Authentication required');
                    return;
                }
            } catch (error) {
                console.error('Error parsing authentication message:', error);
                ws.send(JSON.stringify({ error: 'Invalid authentication message format.' }));
                ws.close(1008, 'Invalid auth format');
                return;
            }

            // Now that the client is authenticated, set up the regular message listener
            ws.on('message', async (message) => {
                if (!isAuthenticated) {
                    ws.send(JSON.stringify({ error: 'Not authenticated. Please reconnect and authenticate.' }));
                    ws.close(1008, 'Not authenticated');
                    return;
                }

                try {
                    const data = JSON.parse(message);
                    const userPrompt = data.prompt; // Expecting prompt in subsequent messages

                    if (!userPrompt) {
                        ws.send(JSON.stringify({ error: 'Prompt is required.' }));
                        return;
                    }

                    console.log(`Received prompt from ${userId}:`, userPrompt);

                    const chatHistory = [{ role: "user", parts: [{ text: userPrompt }] }];
                    const payload = { contents: chatHistory };

                    // Ensure apiKey is available here
                    if (!apiKey) {
                        console.error("GEMINI_API_KEY is missing. Cannot make LLM API call.");
                        ws.send(JSON.stringify({ error: 'Server configuration error: Gemini API key missing.' }));
                        return;
                    }
                    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?key=${apiKey}`;

                    console.log('Making LLM API call to:', apiUrl);
                    console.log('LLM Request Payload:', JSON.stringify(payload, null, 2));

                    const llmResponse = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });

                    if (!llmResponse.ok) {
                        const errorBody = await llmResponse.text();
                        console.error('LLM API HTTP Error:', llmResponse.status, errorBody);
                        ws.send(`Error from AI service: ${llmResponse.status} - ${errorBody}`);
                        return;
                    }

                    let receivedContent = false;
                    const parser = JSONStream.parse('*');

                    llmResponse.body
                        .pipeThrough(new TextDecoderStream())
                        .pipeThrough(new TransformStream({
                            transform(chunk, controller) {
                                controller.enqueue(chunk);
                            }
                        }))
                        .pipeTo(new WritableStream({
                            write(chunk) {
                                parser.write(chunk);
                            },
                            close() {
                                parser.end();
                            },
                            abort(err) {
                                parser.emit('error', err);
                            }
                        }));

                    parser.on('data', (parsedChunk) => {
                        console.log('Parsed LLM object:', JSON.stringify(parsedChunk, null, 2));

                        if (parsedChunk.candidates && parsedChunk.candidates.length > 0 &&
                            parsedChunk.candidates[0].content && parsedChunk.candidates[0].content.parts &&
                            parsedChunk.candidates[0].content.parts.length > 0) {
                            const streamedText = parsedChunk.candidates[0].content.parts[0].text;
                            if (streamedText && ws.readyState === WebSocket.OPEN) {
                                ws.send(streamedText);
                                receivedContent = true;
                            }
                        } else if (parsedChunk.error) {
                            console.error('LLM Stream Error within parsed object:', parsedChunk.error);
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(`Error during AI streaming: ${parsedChunk.error.message}`);
                            }
                        }
                    });

                    parser.on('end', () => {
                        console.log('JSONStream parser ended.');
                        if (!receivedContent) {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send('No content generated by AI for the given prompt.');
                            }
                        }
                        if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'stream_end' }));
                            }
                    });

                    parser.on('error', (err) => {
                        console.error('JSONStream parsing error:', err);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(`Error parsing AI response stream: ${err.message}`);
                        }
                    });

                } catch (error) {
                    console.error('WebSocket message processing error (after auth):', error);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(`Error processing prompt: ${error.message}`);
                    }
                }
            });
        });

        ws.on('close', () => {
            console.log(`Client disconnected from WebSocket (User ID: ${userId})`);
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    });

    // Start the HTTP server (which also serves WebSockets)
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });

}).catch(error => {
    console.error("CRITICAL ERROR: Application failed to start due to initialization errors.", error);
    process.exit(1); // Ensure the process exits if async initialization fails
});