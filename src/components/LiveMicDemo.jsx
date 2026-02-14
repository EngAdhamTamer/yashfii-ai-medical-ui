import React, { useEffect, useMemo } from "react";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";

export default function LiveMicDemo({ onTextChange, onListeningChange }) {
  const { isSupported, isListening, interim, finalText, error, start, stop, reset } =
    useSpeechRecognition({ lang: "ar-EG", continuous: true });

  const combinedText = useMemo(() => {
    return [finalText, interim].filter(Boolean).join(" ").trim();
  }, [finalText, interim]);

  useEffect(() => {
    onTextChange?.(combinedText);
  }, [combinedText, onTextChange]);

  useEffect(() => {
    onListeningChange?.(isListening);
  }, [isListening, onListeningChange]);

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