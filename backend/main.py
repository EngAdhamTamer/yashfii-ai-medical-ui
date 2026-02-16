import json
import asyncio
import re
from typing import AsyncGenerator, List, Optional

import httpx
from fastapi import FastAPI, Body, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse

app = FastAPI()

# =======================
# CORS
# =======================
ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =======================
# Ollama
# =======================
OLLAMA_GENERATE_URL = "http://127.0.0.1:11434/api/generate"
MODEL_NAME = "qwen2.5:7b-instruct"

# =======================
# Helpers
# =======================
def detect_language(text: str) -> str:
    t = (text or "")
    arabic = sum(1 for c in t if "\u0600" <= c <= "\u06FF")
    latin = sum(1 for c in t.lower() if "a" <= c <= "z")
    if arabic > 12 and latin < 4:
        return "ar"
    if arabic > 6 and latin > 6:
        return "mixed"
    return "en"


FUSHA = ["هل", "لماذا", "متى", "أين", "كيف", "يرجى", "من فضلك", "برجاء", "حضرتك"]
BAD_TOKENS = ["سكوكيشة", "هههه", "😂", "🤔", "؟؟", "??", "ياااه", "مش عارف", "اكيد"]

MEDICAL_HINTS_AR = [
    "قد ايه", "امتى", "من امتى", "بقال", "سخونية", "حرارة", "كحة", "بلغم",
    "نهجان", "ضيق نفس", "وجع", "صداع", "زكام", "رشح", "حلق", "صدر",
    "بيزيد", "بيخف", "حساسية", "دواء", "أدوية", "ضغط", "سكر", "قيء", "اسهال"
]

def looks_medical_ar(q: str) -> bool:
    qq = (q or "").strip()
    if any(t in qq for t in BAD_TOKENS):
        return False
    return any(h in qq for h in MEDICAL_HINTS_AR)


def is_bad_question(q: str, patient_lang: str) -> bool:
    q = (q or "").strip()
    if not q:
        return True

    if not (q.endswith("؟") or q.endswith("?")):
        return True

    if len(q) > 90 or len(q.split()) > 16:
        return True

    if patient_lang in ("ar", "mixed"):
        if any(w in q for w in FUSHA):
            return True

    if re.search(r"(.)\1\1", q):
        return True

    if any(t in q for t in BAD_TOKENS):
        return True

    if patient_lang in ("ar", "mixed"):
        if not looks_medical_ar(q):
            return True

    return False


def extract_questions_from_text(text: str) -> List[str]:
    t = (text or "").strip()
    if not t:
        return []

    candidates: List[str] = []

    # lines
    for line in t.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.endswith("؟") or line.endswith("?"):
            candidates.append(line)
            continue
        qs = re.findall(r"([^\n\r]{6,140}[؟?])", line)
        candidates.extend([x.strip() for x in qs if x.strip()])

    if not candidates:
        candidates = [x.strip() for x in re.findall(r"([^\n\r]{6,140}[؟?])", t) if x.strip()]

    out: List[str] = []
    seen = set()
    for q in candidates:
        q2 = re.sub(r"\s+", " ", q).strip()
        if q2 not in seen:
            seen.add(q2)
            out.append(q2)
    return out


def fallback_questions(text: str, patient_lang: str, max_questions: int) -> List[str]:
    t = text or ""
    bank_ar: List[str] = []

    if "كحة" in t or "كح" in t:
        bank_ar.append("الكحة ناشفة ولا ببلغم؟")
        bank_ar.append("لون البلغم ايه؟")
    if "سخونية" in t or "حرارة" in t:
        bank_ar.append("السخونية قد ايه ووصلت كام؟")
    if "نهجان" in t or "ضيق" in t:
        bank_ar.append("النهجان بيحصل مع مجهود ولا حتى وانت قاعد؟")

    bank_ar += [
        "الأعراض بقالها قد ايه؟",
        "فيه وجع صدر؟",
        "خدت أي أدوية قبل كده؟",
        "عندك حساسية من أدوية؟",
        "عندك سكر أو ضغط أو ربو؟",
    ]

    bank_en = [
        "How long have symptoms lasted?",
        "Any fever? What was the highest temperature?",
        "Is the cough dry or productive?",
        "Any shortness of breath?",
        "Any chest pain?",
        "Any medications taken so far?",
        "Any drug allergies?",
        "Any chronic diseases?",
    ]

    out = bank_en if patient_lang == "en" else bank_ar

    uniq: List[str] = []
    for q in out:
        if not (q.endswith("؟") or q.endswith("?")):
            q = q + ("?" if patient_lang == "en" else "؟")
        if q not in uniq:
            uniq.append(q)
        if len(uniq) >= max_questions:
            break
    return uniq


def _extract_json_object(raw: str) -> Optional[dict]:
    """
    يحاول يطلع JSON object حتى لو الموديل رجّع نص حوالينه
    """
    if not raw:
        return None
    raw = raw.strip()

    # direct
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            return obj
    except:
        pass

    # find first {...} block
    m = re.search(r"\{.*\}", raw, flags=re.DOTALL)
    if not m:
        return None
    chunk = m.group(0).strip()
    try:
        obj = json.loads(chunk)
        if isinstance(obj, dict):
            return obj
    except:
        return None
    return None


async def ollama_generate_full(prompt: str, timeout_s: int = 120, force_json: bool = False) -> str:
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        payload = {
            "model": MODEL_NAME,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": 0.2,
                "top_p": 0.9,
                "num_predict": 600,
            },
        }
        if force_json:
            payload["format"] = "json"

        r = await client.post(OLLAMA_GENERATE_URL, json=payload)
        r.raise_for_status()
        data = r.json()
        return data.get("response", "") or ""


async def ollama_stream(prompt: str, timeout_s: int = 120) -> AsyncGenerator[str, None]:
    """
    Streaming chunks from Ollama (each line is JSON).
    Yields token chunks as strings.
    """
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        async with client.stream(
            "POST",
            OLLAMA_GENERATE_URL,
            json={
                "model": MODEL_NAME,
                "prompt": prompt,
                "stream": True,
                "options": {
                    "temperature": 0.2,
                    "top_p": 0.9,
                    "num_predict": 260,
                },
            },
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except:
                    continue
                chunk = obj.get("response", "") or ""
                if chunk:
                    yield chunk
                if obj.get("done") is True:
                    break


def sse(event: str, data_obj) -> str:
    if isinstance(data_obj, str):
        data = data_obj
    else:
        data = json.dumps(data_obj, ensure_ascii=False)
    return f"event: {event}\ndata: {data}\n\n"


# =======================
# Suggested Questions - TRUE Live SSE
# =======================
@app.post("/suggest-questions-live-stream")
async def suggest_questions_live_stream(payload: dict = Body(...)):
    text = str(payload.get("text", "") or "")
    max_questions = int(payload.get("max_questions", 2) or 2)
    max_questions = max(1, min(5, max_questions))

    patient_lang = detect_language(text)

    if patient_lang == "ar":
        lang_instr = "باللهجة المصرية فقط (ممنوع فصحى)."
        example = "مثال: السخونية قد ايه؟"
    elif patient_lang == "mixed":
        lang_instr = "خليط عربي مصري + انجليزي بسيط."
        example = "Example: فيه shortness of breath؟"
    else:
        lang_instr = "Simple medical English."
        example = "Example: Any shortness of breath?"

    prompt = f"""
انت مساعد دكتور.

عايز {max_questions} اسئلة متابعة للمريض.

قواعد صارمة:
- {lang_instr}
- سؤال واحد في السطر.
- كل سؤال ينتهي بـ ؟ أو ?
- ممنوع أي شرح/مقدمات/نصايح/ضحك/إيموجي.
- لو مش متأكد، اختار من بنك الأسئلة فقط.

بنك أسئلة:
1) الأعراض بقالها قد ايه؟
2) السخونية قد ايه ووصلت كام؟
3) الكحة ناشفة ولا ببلغم؟
4) لون البلغم ايه؟
5) فيه نهجان أو ضيق نفس؟
6) فيه وجع صدر؟
7) خدت أي أدوية قبل كده؟
8) عندك حساسية من أدوية؟
9) عندك أمراض مزمنة زي سكر/ضغط/ربو؟
10) حد في البيت عنده نفس الأعراض؟

{example}

كلام المريض:
{text}
""".strip()

    async def event_gen() -> AsyncGenerator[str, None]:
        # important headers for proxies/buffers:
        # (FastAPI/uvicorn usually ok, but keep pings frequent)
        yield sse("ping", {"stage": "connected"})

        queue: asyncio.Queue = asyncio.Queue()

        async def pinger():
            try:
                while True:
                    await asyncio.sleep(2)
                    await queue.put(("ping", {}))
            except asyncio.CancelledError:
                return

        async def producer():
            """
            Streams from Ollama and emits questions as soon as they are detected.
            """
            emitted: List[str] = []
            acc = ""

            try:
                async for chunk in ollama_stream(prompt, timeout_s=120):
                    acc += chunk

                    # detect questions progressively
                    qs = extract_questions_from_text(acc)
                    for q in qs:
                        if len(emitted) >= max_questions:
                            break
                        qq = q.strip()
                        if not (qq.endswith("؟") or qq.endswith("?")):
                            continue
                        if is_bad_question(qq, patient_lang):
                            continue
                        if qq in emitted:
                            continue

                        emitted.append(qq)
                        await queue.put(("q", {"q": qq, "language": patient_lang}))

                    if len(emitted) >= max_questions:
                        break

                if len(emitted) < max_questions:
                    for qq in fallback_questions(text, patient_lang, max_questions):
                        if len(emitted) >= max_questions:
                            break
                        if qq not in emitted:
                            emitted.append(qq)
                            await queue.put(("q", {"q": qq, "language": patient_lang}))

                await queue.put(("done", {}))
            except Exception as e:
                await queue.put(("error", {"error": str(e)}))

        ping_task = asyncio.create_task(pinger())
        prod_task = asyncio.create_task(producer())

        try:
            while True:
                ev, data = await queue.get()
                yield sse(ev, data)
                if ev in ("done", "error"):
                    break
        finally:
            ping_task.cancel()
            prod_task.cancel()
            try:
                await ping_task
            except:
                pass
            try:
                await prod_task
            except:
                pass

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        # some reverse proxies buffer without this:
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_gen(), media_type="text/event-stream", headers=headers)


# =======================
# Analyze (Diagnosis + SOAP + Prescription)
# =======================
@app.post("/analyze")
async def analyze(payload: dict = Body(...)):
    try:
        ar = str(payload.get("ar", "") or "")
        en = str(payload.get("en", "") or "")
        text = (ar.strip() + "\n" + en.strip()).strip()

        if not text:
            return JSONResponse(
                {
                    "differential_diagnosis": [],
                    "soap_notes": {"subjective": "", "objective": "", "assessment": "", "plan": ""},
                    "prescription": [],
                }
            )

        prompt = f"""
You are a medical documentation assistant.

Return STRICT JSON object with EXACT keys:
- differential_diagnosis: array of objects {{ "name": string, "probability": number 0..1 }}
- soap_notes: {{ "subjective": string, "objective": string, "assessment": string, "plan": string }}
- prescription: array of strings in format: "Drug - Dose - Frequency"

Rules:
- JSON ONLY. No markdown. No extra keys.
- prescription: ONLY medications (no advice, no treatment plan).

Conversation:
{text}
""".strip()

        # try forced json first
        raw = await ollama_generate_full(prompt, timeout_s=180, force_json=True)
        obj = _extract_json_object(raw)

        # fallback without force_json (some models might ignore)
        if not obj:
            raw2 = await ollama_generate_full(prompt, timeout_s=180, force_json=False)
            obj = _extract_json_object(raw2) or {}

        dd = obj.get("differential_diagnosis") or []
        soap = obj.get("soap_notes") or {}
        rx = obj.get("prescription") or []

        norm_dd = []
        if isinstance(dd, list):
            for item in dd[:6]:
                if not isinstance(item, dict):
                    continue
                name = str(item.get("name", "")).strip()
                p = item.get("probability", 0)
                try:
                    p = float(p)
                except:
                    p = 0.0
                p = max(0.0, min(1.0, p))
                if name:
                    norm_dd.append({"name": name, "probability": p})

        norm_soap = {
            "subjective": str(soap.get("subjective", "") or ""),
            "objective": str(soap.get("objective", "") or ""),
            "assessment": str(soap.get("assessment", "") or ""),
            "plan": str(soap.get("plan", "") or ""),
        }

        norm_rx = []
        if isinstance(rx, list):
            for x in rx:
                s = str(x or "").strip()
                if not s:
                    continue
                s = s.split("\n")[0].strip()
                if s and s not in norm_rx:
                    norm_rx.append(s)

        return JSONResponse(
            {
                "differential_diagnosis": norm_dd,
                "soap_notes": norm_soap,
                "prescription": norm_rx,
            }
        )

    except Exception as e:
        return JSONResponse(
            {
                "differential_diagnosis": [],
                "soap_notes": {"subjective": "", "objective": "", "assessment": "", "plan": ""},
                "prescription": [],
                "error": str(e),
            },
            status_code=200,
        )


# =======================
# Analyze Audio (placeholder)
# =======================
@app.post("/analyze-audio")
async def analyze_audio(file: UploadFile = File(...)):
    return JSONResponse(
        {
            "transcript": "(audio received) — wire Whisper here",
            "suggested_questions": [],
            "differential_diagnosis": [],
            "soap_notes": {"subjective": "", "objective": "", "assessment": "", "plan": ""},
            "prescription": [],
        }
    )


# =======================
# Save Visit (placeholder)
# =======================
@app.post("/save-visit")
async def save_visit(payload: dict = Body(...)):
    return JSONResponse({"ok": True, "file": "visit.json"})