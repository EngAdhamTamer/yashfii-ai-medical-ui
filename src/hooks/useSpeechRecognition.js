import { useCallback, useEffect, useRef, useState } from "react";

export function useSpeechRecognition({ lang = "ar-EG", continuous = true } = {}) {
  const recognitionRef = useRef(null);
  const [isSupported, setIsSupported] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [finalText, setFinalText] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setIsSupported(false);
      return;
    }

    const rec = new SR();
    rec.lang = lang;
    rec.continuous = continuous;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setError("");
      setIsListening(true);
    };

    rec.onend = () => {
      setIsListening(false);
      setInterim("");
    };

    rec.onerror = (e) => {
      setError(e?.error || "speech_error");
      setIsListening(false);
    };

    rec.onresult = (event) => {
      let interimChunk = "";
      let finalChunk = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0]?.transcript ?? "";
        if (res.isFinal) finalChunk += text;
        else interimChunk += text;
      }

      if (finalChunk) setFinalText((prev) => (prev ? prev + " " : "") + finalChunk.trim());
      setInterim(interimChunk.trim());
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
  }, [lang, continuous]);

  const start = useCallback(async () => {
    setError("");
    if (!recognitionRef.current) return;

    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("mic_permission_denied");
      return;
    }

    try {
      recognitionRef.current.start();
    } catch {
      setError("start_failed");
    }
  }, []);

  const stop = useCallback(() => {
    setError("");
    try {
      recognitionRef.current?.stop();
    } catch {}
  }, []);

  const reset = useCallback(() => {
    setFinalText("");
    setInterim("");
    setError("");
  }, []);

  return { isSupported, isListening, interim, finalText, error, start, stop, reset };
}