# How to Run the Project (yashfii AI Medical UI)

This file explains step-by-step how to run the full project after cloning or reopening it.

---

## 1) Start Ollama (LLM)

Make sure Ollama is installed and running.

Check available models:
```bash
ollama list
```

If the model is missing, pull it:
```bash
ollama pull qwen2.5:3b
```

Ollama runs on:
```
http://localhost:11434
```

---

## 2) Run Backend (FastAPI) — Port 8000

Open a new PowerShell window:

```powershell
cd D:\frontend\ai-medical-ui\backend
uvicorn main:app --reload --port 8000
```

Test backend:
```
http://localhost:8000/docs
```

### Important Note
We installed `python-multipart` for the correct Python version (Python 3.13) because `/analyze-audio` needs it.

If you get an error about multipart again, run:
```powershell
C:\Users\Tamoora\AppData\Local\Programs\Python\Python313\python.exe -m pip install python-multipart
```

---

## 3) Run Frontend (React) — Port 3000

Open another PowerShell window:

```powershell
cd D:\frontend\ai-medical-ui
npm install
npm start
```

Open in browser:
```
http://localhost:3000
```

---

## 4) Whisper (For Audio Upload)

Audio upload uses Whisper via a separate Python environment.

If needed, set the environment variable before running backend:

```powershell
$env:WHISPER_PY="C:\AI_Medical_Assistant\venv\Scripts\python.exe"
```

Then run backend again:
```powershell
uvicorn main:app --reload --port 8000
```

---

## 5) Project Ports Summary

- Frontend (React): http://localhost:3000
- Backend (FastAPI): http://localhost:8000
- Ollama (LLM): http://localhost:11434

---

## 6) What We Added / Configured

- Live suggested questions endpoint: `/suggest-questions-live`
- Audio upload endpoint: `/analyze-audio`
- Fixed `python-multipart` for file upload
- Frontend now:
  - Shows Suggested Questions from backend
  - If `/analyze-audio` returns empty questions, it calls `/suggest-questions-live`
- Ollama model used: `qwen2.5:3b`

---

## 7) Normal Startup Order (Every Time)

1. Start Ollama
2. Start Backend (FastAPI)
3. Start Frontend (React)
4. Open browser at http://localhost:3000

---

Good luck 🚀
