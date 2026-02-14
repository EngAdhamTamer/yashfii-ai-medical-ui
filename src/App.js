import React, { useEffect, useMemo, useRef, useState } from "react";
import LiveMicDemo from "./components/LiveMicDemo";
import "./App.css";

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

  // Suggested Questions (live)
  const [suggested, setSuggested] = useState([]);

  // Theme
  const [theme, setTheme] = useState("dark"); // dark | light

  const fileInputRef = useRef(null);

  // live analyze controls
  const inflightRef = useRef(null); // AbortController
  const lastTickRef = useRef(0);
  const lastSentSnippetRef = useRef("");

  // asked questions tracking
  const askedSetRef = useRef(new Set());
  const lastCapturedQRef = useRef("");

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // -------- Helpers: similarity + question capture --------
  function normalizeQ(s) {
    return (s || "")
      .toLowerCase()
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
    return ratio >= 0.6;
  }

  function extractLatestSpokenQuestion(text) {
    const t = (text || "").trim();
    if (!t) return null;

    const tail = t.slice(-350);

    const parts = tail
      .split(/[\n\.!\u061B؛]+/g)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!parts.length) return null;

    const last = parts[parts.length - 1];

    const isQ =
      /[؟?]/.test(last) ||
      /^(هل|متى|إمتى|فين|أين|كام|كيف|ليه|لماذا|هل يوجد|هل في|هل عندك|عندك)\b/.test(last);

    if (!isQ) return null;

    const cleaned = last.replace(/[؟?]+/g, "").trim();
    if (cleaned.length < 6) return null;

    return cleaned;
  }

  // لو الدكتور قال سؤال في اللايف → نشيله من Suggested فورًا
  useEffect(() => {
    const q = extractLatestSpokenQuestion(liveText);
    if (!q) return;

    if (q === lastCapturedQRef.current) return; // avoid repeats بسبب interim
    lastCapturedQRef.current = q;

    askedSetRef.current.add(q);

    setSuggested((prev) => prev.filter((s) => !isSimilarQuestion(s, q)));
  }, [liveText]);

  // -------- Existing endpoints (manual) --------
  const analyze = async () => {
    try {
      setStatus("analyzing");

      const payload = { ar: "", en: mock.transcript };

      const res = await fetch("http://localhost:8000/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error("Backend error");

      const result = await res.json();
      setData(result);
      setStatus("ready");
      showToast("AI analysis complete (text)");
    } catch (err) {
      console.log(err);
      setStatus("idle");
      showToast("Backend not responding");
    }
  };

  const analyzeAudio = async () => {
    if (!selectedAudio) {
      showToast("Choose an audio file first");
      return;
    }

    try {
      setStatus("analyzing");

      const formData = new FormData();
      formData.append("file", selectedAudio);

      const res = await fetch("http://localhost:8000/analyze-audio", {
        method: "POST",
        body: formData
      });

      if (!res.ok) throw new Error("Backend error");

      const result = await res.json();
      setData(result);
      setStatus("ready");
      showToast("AI analysis complete (audio)");
    } catch (err) {
      console.log(err);
      setStatus("idle");
      showToast("Backend not responding");
    }
  };

  const saveVisit = async () => {
    if (!data) {
      showToast("No visit data to save");
      return;
    }

    try {
      const res = await fetch("http://localhost:8000/save-visit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });

      if (!res.ok) throw new Error();

      const json = await res.json();
      showToast(`Visit saved: ${json.file}`);
    } catch (err) {
      showToast("Backend not responding");
    }
  };

  const onPickAudio = (e) => {
    const f = e.target.files?.[0] || null;
    setSelectedAudio(f);
    if (f) showToast(`Selected: ${f.name}`);
  };

  // ✅ Live Suggested Questions: يعمل وهو بيتكلم (throttle + abort + send last chars)
  useEffect(() => {
    if (!isLiveListening) return;

    const tick = () => {
      const full = (liveText || "").trim();
      if (full.length < 20) return;

      // ابعت آخر جزء فقط (أسرع)
      const snippet = full.slice(-420);

      // لو مفيش تغيير حقيقي، متبعتش
      if (snippet === lastSentSnippetRef.current) return;

      // throttle: كل 1200ms
      const now = Date.now();
      if (now - lastTickRef.current < 1200) return;
      lastTickRef.current = now;

      // cancel old request
      try {
        inflightRef.current?.abort?.();
      } catch {}

      const controller = new AbortController();
      inflightRef.current = controller;

      (async () => {
        try {
          setStatus("analyzing");

          const res = await fetch("http://localhost:8000/suggest-questions-live", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: snippet, max_questions: 5 }),
            signal: controller.signal
          });

          if (!res.ok) throw new Error("Backend error");

          const result = await res.json();

          // ✅ دمج + فلترة الأسئلة اللي اتسألت
          setSuggested((prev) => {
            const asked = askedSetRef.current;

            const incoming = (result.suggested_questions || []).filter((q) => {
              for (const a of asked) {
                if (isSimilarQuestion(q, a)) return false;
              }
              return true;
            });

            const merged = [...prev];
            for (const q of incoming) {
              if (!merged.some((x) => isSimilarQuestion(x, q))) merged.push(q);
            }
            return merged.slice(0, 5);
          });

          setStatus("ready");
          lastSentSnippetRef.current = snippet;
        } catch (e) {
          if (e?.name === "AbortError") return; // طبيعي في live
          console.log(e);
          setStatus("idle");
        }
      })();
    };

    const id = setInterval(tick, 300);

    return () => {
      clearInterval(id);
      try {
        inflightRef.current?.abort?.();
      } catch {}
    };
  }, [isLiveListening, liveText]);

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
          {/* Optional manual buttons */}
          <button className="btn primary" onClick={analyze} disabled={status === "analyzing"}>
            Analyze (Text)
          </button>

          <button
            className="btn primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={status === "analyzing"}
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

          <button
            className="btn ghost"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
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

          <LiveMicDemo
            onTextChange={setLiveText}
            onListeningChange={(v) => {
              setIsLiveListening(v);

              if (v) {
                // reset trackers on start
                lastTickRef.current = 0;
                lastSentSnippetRef.current = "";
                lastCapturedQRef.current = "";
                askedSetRef.current = new Set();
                setSuggested([]);
              } else {
                // stop inflight request on stop
                try {
                  inflightRef.current?.abort?.();
                } catch {}
              }
            }}
          />

          <pre className="transcript" style={{ marginTop: 12 }}>
            {liveText || data?.transcript || "No transcript yet"}
          </pre>

          <div className="mutedSmall" style={{ marginTop: 8 }}>
            {selectedAudio ? `Audio: ${selectedAudio.name}` : "No audio selected"}
          </div>
        </div>

        <div className="card">
          <h2>Suggested Questions</h2>
          <input className="search" placeholder="Search…" disabled />

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

          {/* زر اختياري لتفريغ الأسئلة لو حبيت */}
          <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
            <button
              className="btn ghost"
              onClick={() => {
                askedSetRef.current = new Set();
                setSuggested([]);
              }}
            >
              Reset Suggestions
            </button>
          </div>
        </div>

        <div className="card">
          <h2>Diagnoses</h2>
          {(data?.differential_diagnosis || []).length ? (
            data.differential_diagnosis.map((d, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div className="itemRow">
                  {d.name}
                  <span className="badge">{Math.round(d.probability * 100)}%</span>
                </div>

                <div className="bar">
                  <div className="barFill" style={{ width: `${d.probability * 100}%` }} />
                </div>
              </div>
            ))
          ) : (
            <div className="itemRow" style={{ opacity: 0.6 }}>
              —
            </div>
          )}
        </div>

        <div className="card span2">
          <h2>SOAP Notes</h2>

          <div className="soapGrid">
            <div className="soapBox">
              <div className="soapHead">Subjective</div>
              <textarea
                className="soapInput"
                value={data?.soap_notes?.subjective || ""}
                onChange={(e) =>
                  setData({
                    ...data,
                    soap_notes: { ...data.soap_notes, subjective: e.target.value }
                  })
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
                  setData({
                    ...data,
                    soap_notes: { ...data.soap_notes, objective: e.target.value }
                  })
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
                  setData({
                    ...data,
                    soap_notes: { ...data.soap_notes, assessment: e.target.value }
                  })
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
                  setData({
                    ...data,
                    soap_notes: { ...data.soap_notes, plan: e.target.value }
                  })
                }
                disabled={!data}
              />
            </div>
          </div>
        </div>

        <div className="card span2">
          <h2>Treatment Plan</h2>
          <p style={{ marginTop: 0 }}>{data?.treatment_plan || "—"}</p>

          <button className="btn primary" onClick={saveVisit} disabled={!data}>
            Save Visit
          </button>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}