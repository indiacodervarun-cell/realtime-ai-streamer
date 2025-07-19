const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 8080;

// Create an HTTP server from the Express app
const server = http.createServer(app);

// Create a WebSocket server instance
const wss = new WebSocket.Server({ server });

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('Client connected via WebSocket');

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const userPrompt = data.prompt;

            if (!userPrompt) {
                ws.send(JSON.stringify({ error: 'Prompt is required.' }));
                ws.close(1008, 'Prompt required'); // Close with protocol error code
                return;
            }

            console.log('Received prompt:', userPrompt);

            // Prepare the payload for the Gemini API call with streaming enabled
            const chatHistory = [{ role: "user", parts: [{ text: userPrompt }] }];

            const payload = {
                contents: chatHistory,
                // No generationConfig for streaming, as we want raw text stream
            };

            // For Canvas environment, apiKey is automatically provided.
            // In a real GCP deployment, you'd manage this via Secret Manager or environment variables
            // and ensure the Cloud Run service account has the 'Vertex AI User' role.
            const apiKey = process.env.apiKey; // Leave as empty string for Canvas auto-injection
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?key=${apiKey}`; // Note: streamGenerateContent

            // Make a fetch call to the LLM with streaming
            const llmResponse = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!llmResponse.ok) {
                const errorBody = await llmResponse.text();
                console.error('LLM API HTTP Error:', llmResponse.status, errorBody);
                ws.send(`Error from AI service: ${llmResponse.status} - ${errorBody}`);
                ws.close(1011, 'LLM API Error'); // Internal error
                return;
            }

            // Read the response body as a stream
            const reader = llmResponse.body.getReader();
            let result;
            while (!(result = await reader.read()).done) {
                const chunk = new TextDecoder().decode(result.value);
                // The Gemini API streams JSON objects. We need to parse each one.
                // It might send multiple JSON objects in one chunk, or partial ones.
                // A simple approach for this example is to assume one complete JSON per chunk
                // or handle robust parsing of concatenated JSONs.
                // For simplicity, we'll try to parse and extract text.
                try {
                    const parsedChunk = JSON.parse(chunk);
                    if (parsedChunk.candidates && parsedChunk.candidates.length > 0 &&
                        parsedChunk.candidates[0].content && parsedChunk.candidates[0].content.parts &&
                        parsedChunk.candidates[0].content.parts.length > 0) {
                        const streamedText = parsedChunk.candidates[0].content.parts[0].text;
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(streamedText); // Send each text chunk to the client
                        }
                    } else if (parsedChunk.error) {
                        console.error('LLM Stream Error within chunk:', parsedChunk.error);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(`Error during AI streaming: ${parsedChunk.error.message}`);
                        }
                        break; // Stop streaming on error
                    }
                } catch (parseError) {
                    console.warn('Could not parse JSON chunk (might be partial):', chunk, parseError);
                    // If it's not a valid JSON, it might be a partial chunk or just text.
                    // For robust streaming, you'd need a JSON stream parser.
                    // For this basic example, we'll just log and continue.
                }
            }
            console.log('LLM stream finished.');
            ws.close(); // Close WebSocket connection after stream ends
        } catch (error) {
            console.error('WebSocket message processing error:', error);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(`Error processing prompt: ${error.message}`);
            }
            ws.close(1011, 'Internal server error');
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected from WebSocket');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
