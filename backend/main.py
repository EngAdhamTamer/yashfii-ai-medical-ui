from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import requests
import json
import os
import subprocess
import tempfile
from pathlib import Path
import re
import httpx

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
    suffix = Path(file.filename).suffix if file.filename else ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = tmp.name
        content = await file.read()
        tmp.write(content)

    try:
        transcript_en = transcribe_with_whisper(tmp_path)
        result = analyze_text("", transcript_en)
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

AR_RE = re.compile(r'[\u0600-\u06FF]')
EN_RE = re.compile(r'[A-Za-z]')

def detect_language(text: str) -> str:
    ar = len(AR_RE.findall(text or ""))
    en = len(EN_RE.findall(text or ""))
    if ar > 0 and en > 0:
        return "mixed"
    if ar > en:
        return "ar"
    return "en"


def _strip_spaces(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def extract_patient_text(snippet: str, max_chars: int = 320) -> str:
    """
    ✅ عايزين لغة "المريض" تحديداً.
    - لو فيه Patient:/Doctor: tags → ناخد آخر سطور Patient
    - غير كده → ناخد آخر جملة/جملتين "مش سؤال" (غالباً ده كلام المريض)
    """
    s = _strip_spaces(snippet)
    if not s:
        return ""

    # لو transcript متوسم
    if re.search(r"\bPatient\s*:", s, flags=re.IGNORECASE):
        lines = re.split(r"[\n\r]+", snippet)
        patient_lines = []
        for ln in lines:
            if re.match(r"\s*Patient\s*:", ln, flags=re.IGNORECASE):
                patient_lines.append(re.sub(r"^\s*Patient\s*:\s*", "", ln, flags=re.IGNORECASE))
        tail = " ".join(patient_lines[-3:]).strip()
        return tail[-max_chars:]

    # heuristic: آخر جملتين مش سؤال
    # نقسم لجمل
    parts = re.split(r"[\n\.!\u061B؛]+", snippet)
    parts = [p.strip() for p in parts if p.strip()]
    if not parts:
        return s[-max_chars:]

    def is_question(x: str) -> bool:
        x0 = x.strip()
        return ("?" in x0) or ("؟" in x0) or bool(re.match(r"^(هل|متى|إمتى|فين|أين|كام|كيف|إزاي|ليه|لماذا|عندك|فيه)\b", x0))

    non_q = [p for p in parts if not is_question(p)]
    take = " ".join(non_q[-2:]) if non_q else parts[-1]
    take = _strip_spaces(take)
    return take[-max_chars:]


def build_live_questions_prompt(patient_text: str, lang: str, n: int) -> str:
    """
    ✅ لغة الأسئلة حسب لغة المريض:
    - ar: مصري (مش فصحى)
    - en: English
    - mixed: نفس ستايل المريض (مصري + كلمات/مصطلحات English)
    """
    if lang == "en":
        instr = (
            "You are assisting a doctor during a live visit. "
            "Write short, practical follow-up questions in ENGLISH only. "
            "No explanations. One question per line. "
            "Keep each question under 10 words."
        )
    elif lang == "mixed":
        instr = (
            "You are assisting a doctor during a live visit. "
            "The patient speaks Arabic (Egyptian) mixed with English medical terms. "
            "Write follow-up questions in a MIXED style: Egyptian Arabic + keep English medical terms in English. "
            "No explanations. One question per line. "
            "Keep questions short."
        )
    else:
        instr = (
            "إنت مساعد للدكتور أثناء كشف لايف. "
            "اكتب أسئلة متابعة باللهجة المصرية (مش فصحى). "
            "ممنوع الشرح. كل سؤال في سطر لوحده. "
            "خلي السؤال قصير ومباشر."
        )

    return f"""{instr}

Patient latest info:
{patient_text}

Return up to {n} questions ONLY.
""".strip()


def parse_questions_lines(text: str, n: int):
    lines = [ln.strip("•- \t0123456789).") for ln in (text or "").splitlines()]
    lines = [ln for ln in lines if ln]
    return lines[:n]


# إعدادات أسرع للـ live
FAST_LIVE_OPTIONS = {
    "temperature": 0.2,
    "top_p": 0.9,
    "num_predict": 80,    # أقل = أسرع
    "num_ctx": 768,       # أقل = أسرع
    "repeat_penalty": 1.12
}

FAST_STREAM_OPTIONS = {
    "temperature": 0.2,
    "top_p": 0.9,
    "num_predict": 90,
    "num_ctx": 768,
    "repeat_penalty": 1.12
}


@app.post("/suggest-questions-live")
def suggest_questions_live(req: LiveSuggestReq):
    snippet = (req.text or "").strip()
    if len(snippet) < 10:
        return {"language": "unknown", "patient_language": "unknown", "suggested_questions": []}

    patient_text = extract_patient_text(snippet, max_chars=320)
    patient_lang = detect_language(patient_text or snippet)

    prompt = build_live_questions_prompt(patient_text, patient_lang, req.max_questions) + "\nIMPORTANT: Output questions only."

    try:
        raw = call_ollama(prompt, options=FAST_LIVE_OPTIONS)
        questions = parse_questions_lines(raw, req.max_questions)
        return {"language": patient_lang, "patient_language": patient_lang, "suggested_questions": questions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Live suggest failed: {e}")


# ----------------------------
# ✅ Streaming (SSE): Suggested Questions one-by-one
# ----------------------------

QUESTION_END_RE = re.compile(r"(.+?[؟\?])")

@app.get("/suggest-questions-live-stream")
async def suggest_questions_live_stream(text: str, max_questions: int = 5):
    snippet = (text or "").strip()
    if len(snippet) < 10:
        async def empty():
            yield "event: done\ndata: {}\n\n"
        return StreamingResponse(
            empty(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
        )

    patient_text = extract_patient_text(snippet, max_chars=320)
    patient_lang = detect_language(patient_text or snippet)

    prompt = build_live_questions_prompt(patient_text, patient_lang, max_questions) + "\nIMPORTANT: Output questions only."

    async def event_gen():
        payload = {
            "model": MODEL,
            "prompt": prompt,
            "stream": True,
            "options": FAST_STREAM_OPTIONS
        }

        buf = ""
        sent = 0

        try:
            # limits تساعد تقلل overhead
            limits = httpx.Limits(max_keepalive_connections=10, max_connections=10)
            async with httpx.AsyncClient(timeout=None, limits=limits) as client:
                async with client.stream("POST", OLLAMA_URL, json=payload) as r:
                    r.raise_for_status()
                    async for line in r.aiter_lines():
                        if not line:
                            continue

                        obj = json.loads(line)
                        chunk = obj.get("response", "")
                        if chunk:
                            buf += chunk

                            # ✅ ابعت أول ما يكتمل سؤال بعلامة ؟ أو ?
                            while sent < max_questions:
                                m = QUESTION_END_RE.search(buf)
                                if not m:
                                    break
                                one = m.group(1)
                                buf = buf[m.end():]

                                q = one.strip("•- \t").strip()
                                if len(q) >= 6:
                                    sent += 1
                                    yield f"event: q\ndata: {json.dumps({'q': q, 'language': patient_lang})}\n\n"

                        if obj.get("done"):
                            break
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'detail': str(e)})}\n\n"
        finally:
            yield "event: done\ndata: {}\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        },
    )