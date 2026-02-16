import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const API = "http://127.0.0.1:8000";

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

  // Live transcript
  const [liveText, setLiveText] = useState("");
  const [isLiveListening, setIsLiveListening] = useState(false);

  // Suggested Questions
  const [suggested, setSuggested] = useState([]);

  // Theme
  const [theme, setTheme] = useState("dark");

  const fileInputRef = useRef(null);

  // Streaming controller
  const sseAbortRef = useRef(null);
  const suggestInFlightRef = useRef(false);

  const lastTickRef = useRef(0);
  const lastSentKeyRef = useRef("");
  const lastSuggestedAtRef = useRef(0);
  const suggestedLenRef = useRef(0);

  // asked questions tracking
  const askedSetRef = useRef(new Set());
  const lastCapturedQRef = useRef("");

  useEffect(() => {
    suggestedLenRef.current = suggested.length;
  }, [suggested]);

  // Live analysis throttling (diagnosis + soap + rx)
  const analyzeTimerRef = useRef(null);
  const lastLiveAnalyzeAtRef = useRef(0);
  const lastLiveAnalyzeKeyRef = useRef("");
  const liveAnalyzeInFlightRef = useRef(false);

  // Web Speech
  const recognitionRef = useRef(null);
  const finalTextRef = useRef("");
  const interimRef = useRef("");

  // guard ref
  const isLiveListeningRef = useRef(false);
  useEffect(() => {
    isLiveListeningRef.current = isLiveListening;
  }, [isLiveListening]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // -----------------------------
  // Text helpers
  // -----------------------------
  function normalizeArabic(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[ًٌٍَُِّْـ]/g, "")
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
      .replace(/[^\p{L}\p{N}\s]/gu, "")
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
    return ratio >= 0.55;
  }

  function lastSentences(text, maxChars = 220) {
    const t = (text || "").trim();
    if (!t) return "";
    const tail = t.slice(-1200);
    const parts = tail
      .split(/[\n\r]+/g)
      .join(" ")
      .split(/[\.!\u061B؛]+/g)
      .map((x) => x.trim())
      .filter(Boolean);

    const last2 = parts.slice(-2).join(" . ");
    return last2.slice(-maxChars).trim();
  }

  // -----------------------------
  // Speaker detection (Doctor/Patient)
  // -----------------------------
  function guessSpeaker(sentence) {
    const s0 = (sentence || "").trim();
    const s = normalizeArabic(s0);

    const doctorSignals =
      /\b(عندك|بتحس|بتحسي|فيه|هل|امتى|فين|كام|قد ايه|ممكن|قولي|خدت|بتاخد|ضغط|سكر|حراره|سخونيه|نهجان|وجع صدر)\b/.test(
        s
      );

    const patientSignals =
      /\b(انا|عندي|حاسس|حاسه|تعبان|موجوع|واجعني|بتوجعني|كحه|بلغم|زوري|حلق|سخونيه|حراره|صداع|دوخه|ترجيع|اسهال|نهجان)\b/.test(
        s
      );

    const looksQuestion = /[؟?]/.test(s0) || /^\s*(هل|امتى|فين|كام|ازاي|ليه|عندك|فيه)\b/.test(s);

    if (looksQuestion && !patientSignals) return "doctor";
    if (patientSignals && !doctorSignals) return "patient";
    if (looksQuestion) return "doctor";
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
    return parts.length ? parts[parts.length - 1] : null;
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

  // remove asked question only if Doctor
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
  // Web Speech init
  // -----------------------------
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const rec = new SR();
    rec.lang = "ar-EG";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setIsLiveListening(true);
      setStatus("idle");
    };

    rec.onend = () => {
      setIsLiveListening(false);
      interimRef.current = "";
    };

    rec.onerror = () => {
      setIsLiveListening(false);
    };

    rec.onresult = (event) => {
      let interimChunk = "";
      let finalChunk = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0]?.transcript ?? "";
        if (res.isFinal) finalChunk += txt;
        else interimChunk += txt;
      }

      if (finalChunk) {
        finalTextRef.current = (finalTextRef.current ? finalTextRef.current + " " : "") + finalChunk.trim();
      }
      interimRef.current = interimChunk.trim();

      const combined = [finalTextRef.current, interimRef.current].filter(Boolean).join(" ").trim();
      setLiveText(combined);
    };

    recognitionRef.current = rec;

    return () => {
      try {
        rec.onresult = null;
        rec.onstart = null;
        rec.onend = null;
        rec.onerror = null;
        rec.stop();
      } catch {}
    };
  }, []);

  const startLive = useCallback(async () => {
    const rec = recognitionRef.current;
    if (!rec) {
      showToast("Speech Recognition not supported. Use Chrome/Edge.");
      return;
    }

    lastTickRef.current = 0;
    lastSentKeyRef.current = "";
    lastCapturedQRef.current = "";
    askedSetRef.current = new Set();
    setSuggested([]);
    setData(null);
    setStatus("idle");
    finalTextRef.current = "";
    interimRef.current = "";
    setLiveText("");

    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      showToast("Mic permission denied");
      return;
    }

    try {
      rec.start();
    } catch {}
  }, [showToast]);

  const stopLive = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {}
  }, []);

  // -----------------------------
  // Suggested Questions Streaming (POST SSE via fetch)
  // -----------------------------
  function stopSuggestionStream() {
    const ctrl = sseAbortRef.current;
    if (ctrl) {
      try {
        ctrl.abort();
      } catch {}
      sseAbortRef.current = null;
    }
  }

  function isAbortError(err) {
    const msg = String(err?.message || err || "");
    return err?.name === "AbortError" || msg.includes("aborted") || msg.includes("AbortError");
  }

  async function startSuggestionStreamPOST(snippet) {
    if (suggestInFlightRef.current) return;
    suggestInFlightRef.current = true;

    stopSuggestionStream();

    const controller = new AbortController();
    sseAbortRef.current = controller;

    // with backend pings, we can safely keep it higher
    const watchdogMs = 30000;
    let watchdog = setTimeout(() => {
      try {
        controller.abort();
      } catch {}
    }, watchdogMs);

    try {
      const res = await fetch(`${API}/suggest-questions-live-stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body: JSON.stringify({ text: snippet, max_questions: 2 }),
        signal: controller.signal
      });

      if (!res.ok || !res.body) {
        clearTimeout(watchdog);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      setStatus("analyzing");

      while (true) {
        let read;
        try {
          read = await reader.read();
        } catch (e) {
          if (isAbortError(e)) break;
          throw e;
        }

        const { value, done } = read;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (buffer.includes("\n\n")) {
          const rawEvent = buffer.slice(0, buffer.indexOf("\n\n"));
          buffer = buffer.slice(buffer.indexOf("\n\n") + 2);

          const lines = rawEvent.split("\n");
          let eventName = "message";
          let dataLine = "";

          for (const ln of lines) {
            if (ln.startsWith("event:")) eventName = ln.slice(6).trim();
            if (ln.startsWith("data:")) dataLine += ln.slice(5).trim();
          }

          // reset watchdog on any event (ping or q)
          clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            try {
              controller.abort();
            } catch {}
          }, watchdogMs);

          if (eventName === "ping") continue;

          if (eventName === "q") {
            try {
              const payload = JSON.parse(dataLine || "{}");
              const q = String(payload.q || "").trim();
              if (!q) continue;

              setSuggested((prev) => {
                const asked = askedSetRef.current;

                for (const a of asked) if (isSimilarQuestion(q, a)) return prev;
                if (prev.some((x) => isSimilarQuestion(x, q))) return prev;

                const next = [...prev, q];
                while (next.length > 3) next.shift();
                return next;
              });

              lastSuggestedAtRef.current = Date.now();
              setStatus("ready");
            } catch {}
          }

          if (eventName === "done") {
            setStatus("ready");
            try {
              controller.abort();
            } catch {}
          }

          if (eventName === "error") {
            setStatus("idle");
            try {
              controller.abort();
            } catch {}
          }
        }
      }
    } catch (e) {
      clearTimeout(watchdog);
      if (!isAbortError(e)) {
        console.log("suggest stream error", e);
        setStatus("idle");
      }
    } finally {
      clearTimeout(watchdog);
      if (sseAbortRef.current === controller) sseAbortRef.current = null;
      suggestInFlightRef.current = false;
    }
  }

  // -----------------------------
  // Live suggestions tick
  // -----------------------------
  useEffect(() => {
    if (!isLiveListening) return;

    const tick = () => {
      const full = (liveText || "").trim();
      if (full.length < 15) return;

      const snippet = lastSentences(full, 240);
      if (snippet.length < 10) return;

      const key = normalizeArabic(snippet);
      if (key === lastSentKeyRef.current) return;

      const now = Date.now();
      if (now - lastTickRef.current < 900) return;
      lastTickRef.current = now;

      // prevent spam if we already have 3 suggestions very recently
      if (suggestedLenRef.current >= 3 && now - lastSuggestedAtRef.current < 1800) {
        lastSentKeyRef.current = key;
        return;
      }

      lastSentKeyRef.current = key;
      startSuggestionStreamPOST(snippet);
    };

    const id = setInterval(tick, 900);

    return () => {
      clearInterval(id);
      stopSuggestionStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLiveListening, liveText]);

  // -----------------------------
  // Live mid analyze (Diagnosis + SOAP + Prescription)
  // -----------------------------
  async function runLiveMidAnalyze() {
    const full = (liveText || "").trim();

    // أسرع: من 140 -> 80
    if (full.length < 80) return;

    const payloadText = full.slice(-1800);
    const key = normalizeArabic(payloadText).slice(-700);
    if (key === lastLiveAnalyzeKeyRef.current) return;

    const now = Date.now();

    // أسرع: من 25s -> 10s
    if (now - lastLiveAnalyzeAtRef.current < 10000) return;

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

      setData((prev) => {
        const next = { ...(prev || {}) };
        if (result?.differential_diagnosis) next.differential_diagnosis = result.differential_diagnosis;
        if (result?.soap_notes) next.soap_notes = result.soap_notes;
        if (result?.prescription) next.prescription = result.prescription;
        // keep transcript preview
        next.transcript = full;
        return next;
      });

      setStatus("ready");
    } catch (e) {
      console.log("live analyze error", e);
    } finally {
      liveAnalyzeInFlightRef.current = false;
    }
  }

  useEffect(() => {
    if (!isLiveListening) return;

    if (analyzeTimerRef.current) clearTimeout(analyzeTimerRef.current);
    analyzeTimerRef.current = setTimeout(() => {
      runLiveMidAnalyze();
    }, 1200);

    return () => {
      if (analyzeTimerRef.current) clearTimeout(analyzeTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveText, isLiveListening]);

  // Final analyze on Stop
  async function runFinalAnalyzeOnStop(finalTranscript) {
    const full = (finalTranscript || "").trim();
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
  // Upload Audio analyze
  // -----------------------------
  const onPickAudio = useCallback(
    (e) => {
      const f = e.target.files?.[0] || null;
      setSelectedAudio(f);
      if (f) showToast(`Selected: ${f.name}`);
    },
    [showToast]
  );

  const analyzeUploadedAudio = useCallback(async () => {
    if (!selectedAudio) return showToast("Choose an audio file first");

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
    } catch (e) {
      console.log(e);
      setStatus("idle");
      showToast("Backend not responding");
    }
  }, [selectedAudio, showToast]);

  // -----------------------------
  // Prescription (meds only)
  // -----------------------------
  function formatPrescriptionItem(item) {
    const s = String(item || "").trim();
    if (!s) return null;

    let clean = s.split("\n")[0].trim();
    clean = clean
      .replace(/(follow up|follow-up|consult|visit|as directed|take as directed|treatment plan|plan|advice)/gi, "")
      .trim();

    if (clean.length > 140) return null;
    return clean || null;
  }

  const prescriptionList = useMemo(() => {
    const arr = Array.isArray(data?.prescription) ? data.prescription : [];
    const cleaned = arr.map(formatPrescriptionItem).filter(Boolean);
    const out = [];
    for (const x of cleaned) if (!out.includes(x)) out.push(x);
    return out;
  }, [data]);

  const recordBtnText = isLiveListening ? "Stop Recording" : "Record Audio";

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <div className="logo">AI</div>
          <div>
            <h1 style={{ margin: 0 }}>AI Doctor Friend</h1>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <button
            className="btn primary"
            onClick={() => {
              if (isLiveListeningRef.current) {
                stopLive();
                stopSuggestionStream();
                setTimeout(() => runFinalAnalyzeOnStop(finalTextRef.current), 150);
              } else {
                startLive();
              }
            }}
            disabled={status === "analyzing" && !isLiveListening}
          >
            {recordBtnText}
          </button>

          <button className="btn primary" onClick={() => fileInputRef.current?.click()} disabled={status === "analyzing"}>
            Upload Audio
          </button>

          <input ref={fileInputRef} type="file" accept="audio/*" onChange={onPickAudio} style={{ display: "none" }} />

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
        {/* Transcript */}
        <div className="card span2">
          <div className="cardHeader">
            <h2 style={{ margin: 0 }}>Transcript</h2>
            <div className="mutedSmall">{isLiveListening ? "Recording..." : "Mic"}</div>
          </div>

          <pre className="transcript" style={{ marginTop: 12 }}>
            {liveText || data?.transcript || "No transcript yet"}
          </pre>

          <div className="mutedSmall" style={{ marginTop: 8 }}>
            {selectedAudio ? `Audio: ${selectedAudio.name}` : "No audio selected"}
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              className="btn primary"
              onClick={analyzeUploadedAudio}
              disabled={status === "analyzing" || !selectedAudio}
            >
              Analyze Uploaded Audio
            </button>
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
            {isLiveListening ? "بتتحدث أثناء التسجيل…" : "ابدأ Record عشان تظهر"}
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
        </div>

        {/* SOAP */}
        <div className="card span2">
          <h2>SOAP Notes</h2>
          <div className="soapGrid">
            <div className="soapBox">
              <div className="soapHead">Subjective</div>
              <textarea className="soapInput" value={data?.soap_notes?.subjective || ""} readOnly />
            </div>
            <div className="soapBox">
              <div className="soapHead">Objective</div>
              <textarea className="soapInput" value={data?.soap_notes?.objective || ""} readOnly />
            </div>
            <div className="soapBox">
              <div className="soapHead">Assessment</div>
              <textarea className="soapInput" value={data?.soap_notes?.assessment || ""} readOnly />
            </div>
            <div className="soapBox">
              <div className="soapHead">Plan</div>
              <textarea className="soapInput" value={data?.soap_notes?.plan || ""} readOnly />
            </div>
          </div>
        </div>

        {/* Prescription */}
        <div className="card span2">
          <h2>Prescription</h2>

          {prescriptionList.length ? (
            <div className="list">
              {prescriptionList.map((p, i) => (
                <div key={i} className="itemRow">
                  {p}
                </div>
              ))}
            </div>
          ) : (
            <div className="itemRow" style={{ opacity: 0.6 }}>
              —
            </div>
          )}

          <button
            className="btn primary"
            style={{ marginTop: 12 }}
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