import React, { useEffect, useMemo, useRef } from "react";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";

export default function LiveMicDemo({ onTextChange, onListeningChange }) {
  const { isSupported, isListening, interim, finalText, error, start, stop, reset } =
    useSpeechRecognition({ lang: "ar-EG", continuous: true });

  // ✅ ثبّت callbacks في refs عشان ما يعملوش loop لما يتغيروا بين renders
  const onTextChangeRef = useRef(onTextChange);
  const onListeningChangeRef = useRef(onListeningChange);

  useEffect(() => {
    onTextChangeRef.current = onTextChange;
  }, [onTextChange]);

  useEffect(() => {
    onListeningChangeRef.current = onListeningChange;
  }, [onListeningChange]);

  const combinedText = useMemo(() => {
    return [finalText, interim].filter(Boolean).join(" ").trim();
  }, [finalText, interim]);

  // ✅ guard يمنع إعادة إرسال نفس النص كتير
  const lastSentTextRef = useRef("");
  useEffect(() => {
    if (combinedText === lastSentTextRef.current) return;
    lastSentTextRef.current = combinedText;
    onTextChangeRef.current?.(combinedText);
  }, [combinedText]);

  // ✅ guard يمنع إعادة إرسال نفس حالة listening
  const lastSentListeningRef = useRef(null);
  useEffect(() => {
    if (isListening === lastSentListeningRef.current) return;
    lastSentListeningRef.current = isListening;
    onListeningChangeRef.current?.(isListening);
  }, [isListening]);

  if (!isSupported) {
    return <div className="liveBox">Live مش مدعوم — جرّب Chrome/Edge.</div>;
  }

  return (
    <div className="liveBox">
      <div className="liveRow">
        {!isListening ? (
          <button className="btn live" onClick={start}>🎙️ Live</button>
        ) : (
          <button className="btn liveStop" onClick={stop}>⏹️ Stop</button>
        )}

        <button className="btn ghost" onClick={reset} disabled={isListening}>🧹 Clear</button>
        <span className="liveStatus">{isListening ? "يسمع..." : "متوقف"}</span>
      </div>

      {error ? (
        <div className="liveError">
          {error === "network"
            ? "لو على Brave غالبًا Shields مانع الخدمة. Chrome/Edge أفضل."
            : `Error: ${error}`}
        </div>
      ) : null}

      <div className="livePreview">
        <div className="mutedSmall" style={{ marginBottom: 6 }}>Live Preview:</div>
        <div>
          {finalText}
          {interim ? <span style={{ opacity: 0.5 }}> {interim}</span> : null}
        </div>
      </div>
    </div>
  );
}