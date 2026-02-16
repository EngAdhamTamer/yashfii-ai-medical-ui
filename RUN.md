# Run Guide (React + FastAPI + Ollama)

## Requirements
- Node.js (v18+ recommended)
- Python 3.10+
- Ollama installed and running
- Model installed: `qwen2.5:7b-instruct`

---

## 1) Start Ollama
### Check Ollama is running
```bash
ollama --version
```

### Check model exists
```bash
ollama list
```

If you don't have the model:
```bash
ollama pull qwen2.5:7b-instruct
```

---

## 2) Run Backend (FastAPI)

### Create venv (recommended)
Windows:
```bash
python -m venv .venv
.venv\Scripts\activate
```

Mac/Linux:
```bash
python3 -m venv .venv
source .venv/bin/activate
```

### Install dependencies
```bash
pip install fastapi uvicorn httpx
```

> If you already have a `requirements.txt`, use:
```bash
pip install -r requirements.txt
```

### Run server
```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Backend:
- http://127.0.0.1:8000
- Docs: http://127.0.0.1:8000/docs

---

## 3) Run Frontend (React)

```bash
npm install
npm start
```

Frontend:
- http://localhost:3000

---

## 4) Quick Test
- Start recording → Suggested Questions update live
- Diagnosis + SOAP update during recording
- Prescription appears after analysis

---

## 5) Ports
- Ollama: 127.0.0.1:11434
- Backend: 127.0.0.1:8000
- Frontend: localhost:3000
