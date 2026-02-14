# yashfii --- AI Medical Assistant (Demo)

A full-stack demo for an AI medical assistant built with: **React +
FastAPI + Ollama + Whisper**.

The project supports: - 🎙️ Live microphone speech-to-text - ⚡ Live
suggested follow-up questions while the patient/doctor is speaking - 🎧
Audio upload transcription using Whisper - 🧠 AI analysis (SOAP notes,
differential diagnosis, treatment plan, etc.) - 💾 Save visit data as
JSON

------------------------------------------------------------------------

## 🧩 Architecture

-   **Frontend**: React (localhost:3000)
    -   Live mic UI
    -   Displays transcript, suggested questions, diagnoses, SOAP notes
-   **Backend**: FastAPI (localhost:8000)
    -   `/analyze` → full AI analysis
    -   `/analyze-audio` → Whisper transcription + analysis
    -   `/suggest-questions-live` → fast live suggested questions
    -   `/save-visit` → save visit JSON
-   **LLM**: Ollama (local)
    -   Model used: `qwen2.5:3b`
-   **Speech-to-Text**: Whisper (via existing Python environment)

------------------------------------------------------------------------

## ✨ Features

-   Live microphone transcription in the browser
-   Real-time suggested questions (updates while speaking)
-   Automatic language handling:
    -   Arabic → questions in Arabic
    -   English → questions in English
    -   Mixed → Arabic with medical terms in English
-   Audio file upload for transcription and analysis
-   Full AI medical analysis (SOAP, diagnosis, plan, prescription)
-   Save visit results to JSON files

------------------------------------------------------------------------

## 📦 Requirements

-   **Node.js** (for frontend)

-   **Python 3.10+** (for backend)

-   **Ollama** installed locally\
    Pull model:

    ``` bash
    ollama pull qwen2.5:3b
    ```

-   **Whisper** working in a Python environment

------------------------------------------------------------------------

## ▶️ Run Backend (FastAPI)

``` bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Open API docs:

    http://localhost:8000/docs

------------------------------------------------------------------------

## ▶️ Run Frontend (React)

``` bash
npm install
npm start
```

Open in browser:

    http://localhost:3000

------------------------------------------------------------------------

## 🔌 Environment Notes

The backend uses: - Ollama endpoint: `http://localhost:11434` - Model:
`qwen2.5:3b` - Whisper Python path can be set using environment
variable:

**PowerShell (Windows):**

``` powershell
$env:WHISPER_PY="C:\path\to\your\python.exe"
```

**CMD (Windows):**

``` cmd
set WHISPER_PY=C:\path\to\your\python.exe
```

(If not set, the backend will raise an error asking for it.)

------------------------------------------------------------------------

## 🧪 Main Endpoints

-   `POST /analyze`\
    Full analysis from text (SOAP, diagnosis, plan, etc.)

-   `POST /analyze-audio`\
    Upload audio → Whisper transcription → full analysis

-   `POST /suggest-questions-live`\
    Lightweight endpoint for **live suggested questions** while speaking

-   `POST /save-visit`\
    Save visit data to JSON file

------------------------------------------------------------------------

## 🎓 Academic Use

This project is a **demo / educational prototype** showing how to: -
Integrate speech-to-text with a web UI - Use local LLMs (Ollama) in a
medical-style assistant - Provide real-time AI assistance during a
clinical-style conversation - Structure a full-stack AI application
(React + FastAPI)

------------------------------------------------------------------------

## ⚠️ Disclaimer

This is **not** a medical device and **not** for real clinical use.\
It is a **research / educational demo** only.

------------------------------------------------------------------------

## 👤 Author

**Adham Tamer**\
AI Engineering Student\
Project: *yashfii --- AI Medical Assistant Demo*
