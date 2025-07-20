    // Load environment variables from .env file
    require('dotenv').config();

    const express = require('express');
    const path = require('path');
    const WebSocket = require('ws');
    const http = require('http');
    const JSONStream = require('jsonstream');
    const admin = require('firebase-admin'); // Import Firebase Admin SDK
    const app = express();
    const PORT = process.env.PORT || 8080;

    // Retrieve API key from environment variables
    const apiKey = process.env.GEMINI_API_KEY || "";

    // --- Firebase Admin SDK Initialization ---
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH;

    console.log(`Firebase Service Account Key Path (from env): ${serviceAccountPath}`);

    if (serviceAccountPath) {
        try {
            console.log(`Attempting to load service account key from: ${serviceAccountPath}`);
            const serviceAccount = require(serviceAccountPath); // THIS LINE IS CRITICAL
            console.log('Service account key loaded successfully.'); // New log
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('Firebase Admin SDK initialized using service account key.');
        } catch (error) {
            console.error('ERROR: Failed to initialize Firebase Admin SDK with service account key. Check FIREBASE_SERVICE_ACCOUNT_KEY_PATH and file content.', error);
            process.exit(1); // Force exit to make error visible
        }
    } else {
        try {
            console.log('FIREBASE_SERVICE_ACCOUNT_KEY_PATH not set. Attempting to initialize with Application Default Credentials.');
            admin.initializeApp();
            console.log('Firebase Admin SDK initialized using Application Default Credentials (or default config).');
        } catch (error) {
            console.error('ERROR: Failed to initialize Firebase Admin SDK. No service account path provided and ADC failed.', error);
            process.exit(1); // Force exit to make error visible
        }
    }
    // --- End Firebase Admin SDK Initialization ---


    // Create an HTTP server from the Express app
    const server = http.createServer(app);

    // Create a WebSocket server instance
    const wss = new WebSocket.Server({ server });

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
                        return; // Don't close connection for missing prompt if already authenticated
                    }

                    console.log(`Received prompt from ${userId}:`, userPrompt);

                    const chatHistory = [{ role: "user", parts: [{ text: userPrompt }] }];
                    const payload = { contents: chatHistory };

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
                        return; // Don't close connection for LLM error if already authenticated
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
    