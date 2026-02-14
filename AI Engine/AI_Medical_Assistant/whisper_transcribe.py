import whisper
import json

AUDIO_PATH = "Leave_her_Johnn.mp3"
MODEL_SIZE = "base"

model = whisper.load_model(MODEL_SIZE)

# whisper هيرجع text واحد، هنخزنه كـ en مؤقتًا
result = model.transcribe(AUDIO_PATH)

out = {
    "ar": "",              # هنظبط العربي بعدين
    "en": result["text"]   # مؤقتًا
}

with open("transcript.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

print("Saved transcript to transcript.json")