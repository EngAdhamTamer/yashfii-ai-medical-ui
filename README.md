# AI Doctor Friend (React + FastAPI + Ollama)

A demo medical assistant that:
- Records speech in browser
- Generates Live Suggested Questions (SSE streaming)
- Generates Diagnosis + SOAP + Prescription using Ollama

Model:
- qwen2.5:7b-instruct

---

## Features
- Live Suggested Questions (SSE)
- Live mid-analysis (Diagnosis + SOAP + Prescription)
- Final analysis on stop
- Upload audio endpoint placeholder
- Save visit endpoint placeholder

---

## Tech Stack
- Frontend: React
- Backend: FastAPI
- LLM: Ollama

---

## Main Endpoints

### POST /suggest-questions-live-stream
SSE stream:
- ping
- q -> { "q": "..." }
- done

### POST /analyze
Returns:
- differential_diagnosis
- soap_notes
- prescription

---

## Run
See **run.md** for full instructions.

Quick start:

```bash
ollama pull qwen2.5:7b-instruct
uvicorn main:app --reload --host 127.0.0.1 --port 8000
npm install
npm start
```

---

## Notes
This is a demo project, not medical advice.
