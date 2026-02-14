import whisper

audio_path = "Leave_her_Johnn.mp3"

model = whisper.load_model("base")  # سريع ومناسب للتجربة
result = model.transcribe(audio_path)

print("\n===== TRANSCRIPT =====\n")
print(result["text"])