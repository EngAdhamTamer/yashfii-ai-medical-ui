import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LiveMicDemo from "./components/LiveMicDemo";
import "./App.css";

const API = "http://localhost:8000";

export default function App() {
  const mock = useMemo(
    () => ({
      transcript:
        "Doctor: What brings you today?\nPatient: Fever and cough for 3 days.\nDoctor: Any shortness of breath?\nPatient: Mild sometimes."
    }),
    []
  );

  const [data, setData] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | analyzing | ready
  const [toast, setToast] = useState(null);
  const [selectedAudio, setSelectedAudio] = useState(null);

  // Live mic transcript
  const [liveText, setLiveText] = useState("");
  const [isLiveListening, setIsLiveListening] = useState(false);

  // Suggested Questions
  const [suggested, setSuggested] = useState([]);

  // Theme
  const [theme, setTheme] = useState("dark"); // dark | light

  const fileInputRef = useRef(null);

  // SSE + throttling
  const sseRef = useRef(null);
  const lastTickRef = useRef(0);
  const lastSentKeyRef = useRef(""); // key يمثل "آخر مدخل مهم"
  const lastSuggestedAtRef = useRef(0);

  // asked questions tracking
  const askedSetRef = useRef(new Set());
  const lastCapturedQRef = useRef("");

  // listening loop guard
  const isLiveListeningRef = useRef(false);
  useEffect(() => {
    isLiveListeningRef.current = isLiveListening;
  }, [isLiveListening]);

  // Live analysis throttling (diagnosis + soap)
  const analyzeTimerRef = useRef(null);
  const lastLiveAnalyzeAtRef = useRef(0);
  const lastLiveAnalyzeKeyRef = useRef("");
  const liveAnalyzeInFlightRef = useRef(false);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // -----------------------------
  // Text helpers
  // -----------------------------
  function normalizeArabic(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[ًٌٍَُِّْـ]/g, "") // تشكيل
      .replace(/[إأآ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeQ(s) {
    return normalizeArabic(s)
      .replace(/[^\p{L}\p{N}\s]/gu, "") // شيل رموز
      .replace(/\s+/g, " ")
      .trim();
  }

  function isSimilarQuestion(a, b) {
    const A = normalizeQ(a);
    const B = normalizeQ(b);
    if (!A || !B) return false;

    if (A.includes(B) || B.includes(A)) return true;

    const aw = new Set(A.split(" "));
    const bw = new Set(B.split(" "));
    let common = 0;
    for (const w of aw) if (bw.has(w)) common++;

    const ratio = common / Math.max(aw.size, bw.size);
    return ratio >= 0.55; // أهدى شوية عشان العربي
  }

  // خُد آخر جملة/جملتين بس عشان السرعة
  function lastSentences(text, maxChars = 220) {
    const t = (text || "").trim();
    if (!t) return "";
    const tail = t.slice(-1200); // مساحة بسيطة
    const parts = tail
      .split(/[\n\r]+/g)
      .join(" ")
      .split(/[\.!\u061B؛]+/g)
      .map((x) => x.trim())
      .filter(Boolean);

    const last2 = parts.slice(-2).join(" . ");
    const clipped = last2.slice(-maxChars);
    return clipped.trim();
  }

  // -----------------------------
  // Speaker detection (Doctor/Patient)
  // -----------------------------
  function guessSpeaker(sentence) {
    const s0 = (sentence || "").trim();
    const s = normalizeArabic(s0);

    // لو فيها صياغات طبيب/استجواب
    const doctorSignals =
      /\b(عندك|بتحس|بتحسي|بتحسّ|فيه|هل|امتى|فين|كام|قد ايه|يعني|ممكن|قولي|قلّي|عايز|خدت|بتاخد|بتشرب|بتدخن|ضغط|سكر|حراره|سخونيه|نهجان|وجع صدر)\b/.test(
        s
      );

    // مؤشرات مريض (شكوى/ضمير متكلم/أعراض)
    const patientSignals =
      /\b(انا|عندي|حاسس|حاسه|حسيت|تعبان|تعبانه|موجوع|موجوعه|واجعني|بتوجعني|كحه|بلغم|زوري|حلق|سخونيه|حراره|صداع|دوخه|ترجيع|اسهال|نهجان)\b/.test(
        s
      );

    // علامة سؤال + استجواب → غالبًا دكتور
    const looksQuestion = /[؟?]/.test(s0) || /^\s*(هل|امتى|فين|كام|ازاي|ليه|عندك|فيه)\b/.test(s);

    // لو هو سؤال ومفيش مؤشرات "أنا/عندي" يبقى دكتور
    if (looksQuestion && !patientSignals) return "doctor";

    // لو في "أنا/عندي" غالبًا مريض
    if (patientSignals && !doctorSignals) return "patient";

    // لو الاثنين موجودين، رجّح حسب السؤال
    if (looksQuestion) return "doctor";

    // default
    return "patient";
  }

  function extractLatestSentence(text) {
    const t = (text || "").trim();
    if (!t) return null;

    const tail = t.slice(-500);
    const parts = tail
      .split(/[\n\.!\u061B؛]+/g)
      .map((x) => x.trim())
      .filter(Boolean);

    if (!parts.length) return null;
    return parts[parts.length - 1];
  }

  function extractLatestSpokenQuestionWithSpeaker(text) {
    const last = extractLatestSentence(text);
    if (!last) return null;

    const isQ =
      /[؟?]/.test(last) ||
      /^(هل|متى|إمتى|فين|أين|كام|كيف|إزاي|ليه|لماذا|هل يوجد|هل في|هل عندك|عندك|فيه)\b/.test(
        normalizeArabic(last)
      );

    if (!isQ) return null;

    const speaker = guessSpeaker(last);
    const cleaned = last.replace(/[؟?]+/g, "").trim();
    if (cleaned.length < 6) return null;

    return { speaker, question: cleaned };
  }

  // ✅ حذف السؤال من Suggested فقط لو Doctor
  useEffect(() => {
    const hit = extractLatestSpokenQuestionWithSpeaker(liveText);
    if (!hit) return;

    const { speaker, question } = hit;
    if (speaker !== "doctor") return;

    if (question === lastCapturedQRef.current) return;
    lastCapturedQRef.current = question;

    askedSetRef.current.add(question);
    setSuggested((prev) => prev.filter((s) => !isSimilarQuestion(s, question)));
  }, [liveText]);

  // -----------------------------
  // Audio analyze (manual)
  // -----------------------------
  const analyzeAudio = useCallback(async () => {
    if (!selectedAudio) {
      showToast("Choose an audio file first");
      return;
    }

    try {
      setStatus("analyzing");

      const formData = new FormData();
      formData.append("file", selectedAudio);

      const res = await fetch(`${API}/analyze-audio`, {
        method: "POST",
        body: formData
      });

      if (!res.ok) throw new Error("Backend error");

      const result = await res.json();
      setData(result);

      setSuggested((result.suggested_questions || []).slice(0, 3));

      setStatus("ready");
      showToast("AI analysis complete (audio)");
    } catch (err) {
      console.log(err);
      setStatus("idle");
      showToast("Backend not responding");
    }
  }, [selectedAudio, showToast]);

  const onPickAudio = useCallback(
    (e) => {
      const f = e.target.files?.[0] || null;
      setSelectedAudio(f);
      if (f) showToast(`Selected: ${f.name}`);
    },
    [showToast]
  );

  // -----------------------------
  // ✅ Live Suggested Questions (SSE) — أسرع + أقل payload
  // -----------------------------
  useEffect(() => {
    if (!isLiveListening) return;

    const tick = () => {
      const full = (liveText || "").trim();
      if (full.length < 15) return;

      // ✅ ابعت آخر جملة/جملتين بس
      const snippet = lastSentences(full, 240);
      if (snippet.length < 10) return;

      // key يمنع إعادة نفس الطلب (normalize)
      const key = normalizeArabic(snippet);
      if (key === lastSentKeyRef.current) return;

      // throttle: كل 900ms (أسرع شوية)
      const now = Date.now();
      if (now - lastTickRef.current < 900) return;
      lastTickRef.current = now;

      // لو لسه عندك 3 أسئلة وعايز تخفف ضغط، قلل طلبات الـ SSE
      if (suggested.length >= 3 && now - lastSuggestedAtRef.current < 1800) {
        // عندك اكتفاء مؤقت
        lastSentKeyRef.current = key;
        return;
      }

      lastSentKeyRef.current = key;

      // اقفل أي SSE قديم
      try {
        sseRef.current?.close?.();
      } catch {}

      setStatus("analyzing");

      const url =
        `${API}/suggest-questions-live-stream?` +
        `text=${encodeURIComponent(snippet)}&max_questions=2`;

      const es = new EventSource(url);
      sseRef.current = es;

      es.addEventListener("q", (ev) => {
        try {
          const payload = JSON.parse(ev.data || "{}");
          const q = String(payload.q || "").trim();
          if (!q) return;

          setSuggested((prev) => {
            const asked = askedSetRef.current;

            for (const a of asked) {
              if (isSimilarQuestion(q, a)) return prev;
            }
            if (prev.some((x) => isSimilarQuestion(x, q))) return prev;

            // ✅ حافظ على 3 ثابتين: لو زادوا، شيل الأقدم
            const next = [...prev, q];
            while (next.length > 3) next.shift();
            return next;
          });

          lastSuggestedAtRef.current = Date.now();
          setStatus("ready");
        } catch {
          // ignore
        }
      });

      es.addEventListener("done", () => {
        try {
          es.close();
        } catch {}
      });

      es.onerror = () => {
        try {
          es.close();
        } catch {}
        setStatus("idle");
      };
    };

    const id = setInterval(tick, 250);

    return () => {
      clearInterval(id);
      try {
        sseRef.current?.close?.();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLiveListening, liveText, suggested.length]);

  // -----------------------------
  // ✅ Live mid-conversation: Diagnosis + SOAP
  // -----------------------------
  async function runLiveMidAnalyze(reason = "live") {
    const full = (liveText || "").trim();
    if (full.length < 120) return; // بدري قوي

    // ابعت جزء أكبر شوية للتشخيص/soap (بس مش كله عشان السرعة)
    const payloadText = full.slice(-1600);

    // key يمنع تكرار نفس التحليل
    const key = normalizeArabic(payloadText).slice(-600);
    if (key === lastLiveAnalyzeKeyRef.current) return;

    const now = Date.now();
    // rate limit: مرة كل 12 ثانية
    if (now - lastLiveAnalyzeAtRef.current < 12000) return;

    if (liveAnalyzeInFlightRef.current) return;
    liveAnalyzeInFlightRef.current = true;

    try {
      lastLiveAnalyzeAtRef.current = now;
      lastLiveAnalyzeKeyRef.current = key;

      const res = await fetch(`${API}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ar: payloadText, en: "" })
      });

      if (!res.ok) throw new Error("analyze failed");
      const result = await res.json();

      // ✅ أثناء اللايف: نحدّث diagnosis + soap فقط
      setData((prev) => {
        const next = { ...(prev || {}) };

        if (result?.differential_diagnosis) next.differential_diagnosis = result.differential_diagnosis;
        if (result?.soap_notes) next.soap_notes = result.soap_notes;

        // ممنوع نعرض treatment_plan أثناء اللايف
        // هنسيبه يتحدث فقط بعد stop
        return next;
      });
    } catch (e) {
      // ما نزعّجش المستخدم هنا
      console.log("live analyze error", e);
    } finally {
      liveAnalyzeInFlightRef.current = false;
    }
  }

  // debounce للـ mid-analyze (بعد ما الكلام يثبت شوية)
  useEffect(() => {
    if (!isLiveListening) return;

    if (analyzeTimerRef.current) clearTimeout(analyzeTimerRef.current);

    analyzeTimerRef.current = setTimeout(() => {
      runLiveMidAnalyze("debounced");
    }, 1800);

    return () => {
      if (analyzeTimerRef.current) clearTimeout(analyzeTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveText, isLiveListening]);

  // ✅ عند Stop: اعمل Analyze كامل واعرض treatment plan كآخر خطوة
  async function runFinalAnalyzeOnStop() {
    const full = (liveText || "").trim();
    if (full.length < 30) return;

    try {
      setStatus("analyzing");

      const res = await fetch(`${API}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ar: full.slice(-4000), en: "" })
      });

      if (!res.ok) throw new Error("final analyze failed");
      const result = await res.json();

      // ✅ بعد stop: حدّث كل حاجة (بما فيها treatment plan)
      setData((prev) => ({
        ...(prev || {}),
        ...result,
        transcript: full
      }));

      setStatus("ready");
    } catch (e) {
      console.log(e);
      setStatus("idle");
      showToast("Final analysis failed");
    }
  }

  // -----------------------------
  // LiveMic callbacks (stable)
  // -----------------------------
  const handleTextChange = useCallback((t) => {
    setLiveText(t);
  }, []);

  const handleListeningChange = useCallback((v) => {
    if (isLiveListeningRef.current === v) return;

    setIsLiveListening(v);

    if (v) {
      // start session reset
      lastTickRef.current = 0;
      lastSentKeyRef.current = "";
      lastCapturedQRef.current = "";
      askedSetRef.current = new Set();
      setSuggested([]);
      setData(null);
      setStatus("idle");
    } else {
      // stop session
      try {
        sseRef.current?.close?.();
      } catch {}
      setStatus("idle");

      // ✅ اعمل التحليل النهائي بعد ما يقف
      runFinalAnalyzeOnStop();
    }
  }, []);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <div className="logo">y</div>
          <div>
            <h1 style={{ margin: 0 }}>yashfii</h1>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: -2 }}>demo</div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {/* ✅ سيب Analyze Audio فقط */}
          <button
            className="btn primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={status === "analyzing"}
            title="Select audio file"
          >
            Choose Audio
          </button>

          <button className="btn primary" onClick={analyzeAudio} disabled={status === "analyzing"}>
            Analyze Audio
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            onChange={onPickAudio}
            style={{ display: "none" }}
          />

          <button className="btn ghost" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
            {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
          </button>

          <div className="status">
            {status === "idle" && "Idle"}
            {status === "analyzing" && "⚡ Live analyzing..."}
            {status === "ready" && "✅ Updated"}
          </div>
        </div>
      </div>

      <div className="content grid">
        {/* Transcript + Live Mic */}
        <div className="card span2">
          <div className="cardHeader">
            <h2 style={{ margin: 0 }}>Transcript</h2>
            <div className="mutedSmall">{isLiveListening ? "Live (listening)" : "Live (Mic)"}</div>
          </div>

          <LiveMicDemo onTextChange={handleTextChange} onListeningChange={handleListeningChange} />

          <pre className="transcript" style={{ marginTop: 12 }}>
            {liveText || data?.transcript || "No transcript yet"}
          </pre>

          <div className="mutedSmall" style={{ marginTop: 8 }}>
            {selectedAudio ? `Audio: ${selectedAudio.name}` : "No audio selected"}
          </div>
        </div>

        {/* Suggested */}
        <div className="card">
          <h2>Suggested Questions</h2>
          <div className="list">
            {suggested.length ? (
              suggested.map((q, i) => (
                <div key={i} className="itemRow">
                  {q}
                </div>
              ))
            ) : (
              <div className="itemRow" style={{ opacity: 0.6 }}>
                —
              </div>
            )}
          </div>
          <div className="mutedSmall" style={{ marginTop: 8 }}>
            {isLiveListening ? "بتتحدث لايف…" : "هتتحدث مع المايك"}
          </div>
        </div>

        {/* Diagnosis */}
        <div className="card">
          <h2>Diagnoses</h2>
          {(data?.differential_diagnosis || []).length ? (
            data.differential_diagnosis.map((d, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div className="itemRow">
                  {d.name}
                  <span className="badge">{Math.round((d.probability || 0) * 100)}%</span>
                </div>
                <div className="bar">
                  <div className="barFill" style={{ width: `${(d.probability || 0) * 100}%` }} />
                </div>
              </div>
            ))
          ) : (
            <div className="itemRow" style={{ opacity: 0.6 }}>
              —
            </div>
          )}
          <div className="mutedSmall" style={{ marginTop: 8 }}>
            {isLiveListening ? "بيظهر تدريجيًا بعد ما يجمع معلومات كفاية" : "—"}
          </div>
        </div>

        {/* SOAP */}
        <div className="card span2">
          <h2>SOAP Notes</h2>

          <div className="soapGrid">
            <div className="soapBox">
              <div className="soapHead">Subjective</div>
              <textarea
                className="soapInput"
                value={data?.soap_notes?.subjective || ""}
                onChange={(e) =>
                  setData((prev) => ({
                    ...(prev || {}),
                    soap_notes: { ...(prev?.soap_notes || {}), subjective: e.target.value }
                  }))
                }
                disabled={!data}
              />
            </div>

            <div className="soapBox">
              <div className="soapHead">Objective</div>
              <textarea
                className="soapInput"
                value={data?.soap_notes?.objective || ""}
                onChange={(e) =>
                  setData((prev) => ({
                    ...(prev || {}),
                    soap_notes: { ...(prev?.soap_notes || {}), objective: e.target.value }
                  }))
                }
                disabled={!data}
              />
            </div>

            <div className="soapBox">
              <div className="soapHead">Assessment</div>
              <textarea
                className="soapInput"
                value={data?.soap_notes?.assessment || ""}
                onChange={(e) =>
                  setData((prev) => ({
                    ...(prev || {}),
                    soap_notes: { ...(prev?.soap_notes || {}), assessment: e.target.value }
                  }))
                }
                disabled={!data}
              />
            </div>

            <div className="soapBox">
              <div className="soapHead">Plan</div>
              <textarea
                className="soapInput"
                value={data?.soap_notes?.plan || ""}
                onChange={(e) =>
                  setData((prev) => ({
                    ...(prev || {}),
                    soap_notes: { ...(prev?.soap_notes || {}), plan: e.target.value }
                  }))
                }
                disabled={!data}
              />
            </div>
          </div>

          <div className="mutedSmall" style={{ marginTop: 8 }}>
            {isLiveListening ? "بيظهر تدريجيًا أثناء المحادثة" : "—"}
          </div>
        </div>

        {/* Treatment Plan — يظهر بعد Stop */}
        <div className="card span2">
          <h2>Treatment Plan</h2>
          {isLiveListening ? (
            <div className="itemRow" style={{ opacity: 0.6 }}>
              — (هيظهر بعد ما Stop)
            </div>
          ) : (
            <p style={{ marginTop: 0 }}>{data?.treatment_plan || "—"}</p>
          )}

          <button
            className="btn primary"
            onClick={async () => {
              if (!data) return showToast("No visit data to save");
              try {
                const res = await fetch(`${API}/save-visit`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(data)
                });
                if (!res.ok) throw new Error();
                const json = await res.json();
                showToast(`Visit saved: ${json.file}`);
              } catch {
                showToast("Backend not responding");
              }
            }}
            disabled={!data}
          >
            Save Visit
          </button>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}