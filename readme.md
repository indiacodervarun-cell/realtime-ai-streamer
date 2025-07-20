# Real-time AI Content Streamer

A full-stack, real-time web application leveraging Google Cloud to stream AI-generated content. Users log in via Firebase Authentication, submit prompts, and receive responses from Google's Gemini 2.0 Flash model streamed character-by-character via WebSockets.

## 💡 Use Cases

* **Interactive AI Assistants:** Dynamic, engaging conversational experience.

* **Live Content Generation:** Real-time creative writing, reports, or interactive storytelling.

* **Educational Tools:** Incremental AI-generated explanations.

* **Enhanced User Experience:** Reduces perceived latency with immediate AI progress.

## ✨ Features

* **User Authentication:** Secure login/logout using Firebase Authentication (Email/Password).

* **Real-time Streaming:** Live AI responses via WebSockets.

* **Google AI Integration:** Uses `gemini-2.0-flash` LLM.

* **Serverless Backend:** Deployed on Google Cloud Run for scalability.

* **Containerized Application:** Docker image for consistent deployment.

* **Secure API Key Handling:** Utilizes environment variables.

## ☁️ Google Cloud Services Used

* **Cloud Run:** Serverless backend hosting.

* **Firebase Authentication:** User identity management.

* **Generative Language API (Gemini 2.0 Flash):** AI model.

* **Cloud Build:** Automated CI/CD.

* **Google Container Registry (GCR):** Docker image storage.

* **Secret Manager (Recommended for Production):** Secure credential storage.

* **IAM:** Permission management.

## 🚀 Local Setup & Run

Run the application locally using Docker.

### Prerequisites

* Node.js (v18+), npm, Docker Desktop.

* Google Cloud Project with billing enabled; **Generative Language, Cloud Run, Cloud Build APIs** enabled.

* **Firebase Project** linked to GCP, **Authentication** enabled (Email/Password).

* **Firebase Service Account Key** (JSON) downloaded as `serviceAccountKey.json` in project root. **(DO NOT COMMIT TO GIT!)**

* **Google Cloud API Key** for Generative Language API.

### 1. Clone the Repository

```bash
git clone [https://github.com/Varun-Mahajan-GitHub/realtime-ai-app.git](https://github.com/Varun-Mahajan-GitHub/realtime-ai-app.git)
cd realtime-ai-app