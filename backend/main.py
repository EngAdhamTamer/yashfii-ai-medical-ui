import json
import asyncio
import re
from typing import AsyncGenerator, List

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
OLLAMA_URL = "http://127.0.0.1:11434/api/generate"

# ✅ مهم: على 16GB الأفضل موديل 7B instruct
# MODEL_NAME = "gemma2:9b"
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

    # لازم سؤال
    if not (q.endswith("؟") or q.endswith("?")):
        return True

    # طول
    if len(q) > 90 or len(q.split()) > 16:
        return True

    # ممنوع فصحى لو عربي
    if patient_lang in ("ar", "mixed"):
        if any(w in q for w in FUSHA):
            return True

    # تكرار غريب
    if re.search(r"(.)\1\1", q):
        return True

    # nonsense
    if any(t in q for t in BAD_TOKENS):
        return True

    # لازم يبقى “طبي” لو عربي/ميكس
    if patient_lang in ("ar", "mixed"):
        if not looks_medical_ar(q):
            return True

    return False


def extract_questions_from_text(text: str) -> List[str]:
    """
    يلقط أي جملة تنتهي بـ ؟ أو ? من النص
    """
    t = (text or "").strip()
    if not t:
        return []

    candidates = []
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

    out = []
    seen = set()
    for q in candidates:
        q2 = re.sub(r"\s+", " ", q).strip()
        if q2 not in seen:
            seen.add(q2)
            out.append(q2)
    return out


async def ollama_generate(prompt: str, timeout_s: int = 60) -> str:
    """
    ✅ أضفنا options لتقليل الهلاوس + منع الإطالة
    """
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        r = await client.post(
            OLLAMA_URL,
            json={
                "model": MODEL_NAME,
                "prompt": prompt,
                "stream": False,
                "options": {
                    "temperature": 0.2,
                    "top_p": 0.9,
                    "num_predict": 220,
                },
            },
        )
        r.raise_for_status()
        data = r.json()
        return data.get("response", "") or ""


def fallback_questions(text: str, patient_lang: str, max_questions: int) -> List[str]:
    """
    ✅ بنك أسئلة دكتور لو الموديل هبد
    """
    t = text or ""
    bank_ar = []

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

    if patient_lang == "en":
        out = bank_en
    else:
        out = bank_ar

    # unique + slice
    uniq = []
    for q in out:
        q = q if (q.endswith("؟") or q.endswith("?")) else (q + "؟")
        if q not in uniq:
            uniq.append(q)
        if len(uniq) >= max_questions:
            break
    return uniq


# =======================
# Suggested Questions - Stable SSE
# =======================
@app.post("/suggest-questions-live-stream")
async def suggest_questions_live_stream(payload: dict = Body(...)):
    text = str(payload.get("text", "") or "")
    max_questions = int(payload.get("max_questions", 2) or 2)

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

    # ✅ prompt أقوى + يمنع الهبد + يفضل الاختيار من بنك
    prompt = f"""
انت مساعد دكتور.

عايز {max_questions} اسئلة متابعة للمريض.

قواعد صارمة:
- {lang_instr}
- سؤال واحد في السطر.
- كل سؤال ينتهي بـ ؟
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
        yield "event: ping\ndata: {\"stage\":\"connected\"}\n\n"

        async def ping_task(queue: asyncio.Queue):
            try:
                while True:
                    await asyncio.sleep(2)
                    await queue.put(("ping", "{}"))
            except asyncio.CancelledError:
                return

        q: asyncio.Queue = asyncio.Queue()
        pinger = asyncio.create_task(ping_task(q))

        try:
            try:
                raw = await ollama_generate(prompt, timeout_s=60)
            except Exception as e:
                await q.put(("error", json.dumps({"error": str(e)})))
                raw = ""

            questions = extract_questions_from_text(raw)

            clean = []
            for item in questions:
                qq = item.strip()
                if not (qq.endswith("؟") or qq.endswith("?")):
                    qq = qq.rstrip() + "؟"

                if is_bad_question(qq, patient_lang):
                    continue

                clean.append(qq)
                if len(clean) >= max_questions:
                    break

            # ✅ fallback قوي لو الموديل طلع كلام غريب أو مفيش أسئلة
            if len(clean) < max_questions:
                clean = fallback_questions(text, patient_lang, max_questions)

            for qq in clean[:max_questions]:
                await q.put(("q", json.dumps({"q": qq, "language": patient_lang}, ensure_ascii=False)))

            await q.put(("done", "{}"))

            while True:
                ev, data = await q.get()
                yield f"event: {ev}\ndata: {data}\n\n"
                if ev in ("done", "error"):
                    break

        finally:
            pinger.cancel()
            try:
                await pinger
            except:
                pass

    return StreamingResponse(event_gen(), media_type="text/event-stream")


# =======================
# Analyze
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

Return STRICT JSON with:
- differential_diagnosis: array of objects {{ "name": "...", "probability": 0.0-1.0 }}
- soap_notes: {{ "subjective": "...", "objective": "...", "assessment": "...", "plan": "..." }}
- prescription: array of strings in format: "Drug - Dose - Frequency"

Rules:
- prescription: ONLY medications (no treatment plan, no advice).
- JSON only (no markdown).

Conversation:
{text}
""".strip()

        raw = await ollama_generate(prompt, timeout_s=180)

        try:
            obj = json.loads(raw)
        except:
            obj = {}

        dd = obj.get("differential_diagnosis") or []
        soap = obj.get("soap_notes") or obj.get("soap") or {}
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