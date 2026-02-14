from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
import json
import os
import subprocess
import tempfile
from pathlib import Path
import re

app = FastAPI()

# السماح للـ React يكلمنا
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5:3b"

# ✅ ده الـ Python اللي عليه whisper شغال عندك (عدّل المسار لو مشروعك مختلف)
DEFAULT_WHISPER_PY = r"C:\AI_Medical_Assistant\venv\Scripts\python.exe"
WHISPER_PY = os.getenv("WHISPER_PY", DEFAULT_WHISPER_PY)

class AnalyzeReq(BaseModel):
    ar: str = ""
    en: str = ""

class LiveSuggestReq(BaseModel):
    text: str
    max_questions: int = 5

def call_ollama(prompt: str, options: dict | None = None) -> str:
    payload = {
        "model": MODEL,
        "prompt": prompt,
        "stream": False,
    }
    if options:
        payload["options"] = options

    r = requests.post(
        OLLAMA_URL,
        json=payload,
        timeout=300
    )
    r.raise_for_status()
    return r.json()["response"]

def transcribe_with_whisper(audio_path: str) -> str:
    """
    Uses your existing Whisper environment (C:\\AI_Medical_Assistant\\venv)
    to transcribe the uploaded audio file.
    """
    runner = str(Path(__file__).parent / "whisper_runner.py")

    if not Path(WHISPER_PY).exists():
        raise RuntimeError(
            f"WHISPER_PY not found: {WHISPER_PY}\n"
            f"Set env var WHISPER_PY to your whisper venv python.exe"
        )

    proc = subprocess.run(
        [WHISPER_PY, runner, audio_path],
        capture_output=True,
        text=True
    )

    if proc.returncode != 0:
        raise RuntimeError(f"Whisper failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")

    return proc.stdout.strip()

def analyze_text(ar: str, en: str):
    prompt = f"""
Return ONLY valid JSON with this schema:
{{
  "transcript": "string",
  "suggested_questions": ["..."],
  "differential_diagnosis": [{{"name":"", "probability":0.0}}],
  "soap_notes": {{"subjective":"", "objective":"", "assessment":"", "plan":""}},
  "treatment_plan": "string",
  "prescription": ["..."]
}}

Arabic:
{ar}

English:
{en}
"""
    raw = call_ollama(prompt).strip()
    return json.loads(raw)

@app.post("/analyze")
def analyze(req: AnalyzeReq):
    return analyze_text(req.ar, req.en)

@app.post("/analyze-audio")
async def analyze_audio(file: UploadFile = File(...)):
    # Save uploaded file to temp
    suffix = Path(file.filename).suffix if file.filename else ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = tmp.name
        content = await file.read()
        tmp.write(content)

    try:
        transcript_en = transcribe_with_whisper(tmp_path)
        result = analyze_text("", transcript_en)

        # Ensure transcript shown in UI is the transcription
        result["transcript"] = transcript_en
        return result
    finally:
        try:
            os.remove(tmp_path)
        except:
            pass

@app.post("/save-visit")
def save_visit(payload: dict):
    import time
    filename = f"saved_visit_{int(time.time())}.json"
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return {"ok": True, "file": filename}

# ----------------------------
# ✅ Live Suggested Questions
# ----------------------------

def detect_language(text: str) -> str:
    ar = len(re.findall(r'[\u0600-\u06FF]', text))
    en = len(re.findall(r'[A-Za-z]', text))
    if ar > 0 and en > 0:
        return "mixed"
    if ar > en:
        return "ar"
    return "en"

def build_live_questions_prompt(snippet: str, lang: str, n: int) -> str:
    if lang == "ar":
        instr = (
            "أنت مساعد طبي. اقترح أسئلة متابعة قصيرة وواضحة باللغة العربية فقط. "
            "بدون شرح. اكتب كل سؤال في سطر منفصل."
        )
    elif lang == "en":
        instr = (
            "You are a medical assistant. Suggest short, clear follow-up questions in English only. "
            "No explanations. One question per line."
        )
    else:
        instr = (
            "أنت مساعد طبي. المريض يتكلم عربي مع مصطلحات طبية إنجليزية. "
            "اكتب الأسئلة بالعربية مع الحفاظ على المصطلحات الطبية بالإنجليزية كما ظهرت. "
            "بدون شرح. كل سؤال في سطر منفصل."
        )

    return f"""{instr}

Conversation snippet:
{snippet}

Return exactly {n} questions.
"""

def parse_questions_lines(text: str, n: int):
    lines = [ln.strip("•- \t") for ln in (text or "").splitlines()]
    lines = [ln for ln in lines if ln]
    return lines[:n]

@app.post("/suggest-questions-live")
def suggest_questions_live(req: LiveSuggestReq):
    snippet = (req.text or "").strip()
    if len(snippet) < 10:
        return {"language": "unknown", "suggested_questions": []}

    lang = detect_language(snippet)
    prompt = build_live_questions_prompt(snippet, lang, req.max_questions) + "\nIMPORTANT: Output questions only. No extra text."

    try:
        # إعدادات أسرع للـ live
        raw = call_ollama(
    prompt,
    options={
        "temperature": 0.1,
        "num_predict": 80,
        "top_p": 0.8,
        "num_ctx": 1024
    }
)
        questions = parse_questions_lines(raw, req.max_questions)
        return {"language": lang, "suggested_questions": questions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Live suggest failed: {e}")