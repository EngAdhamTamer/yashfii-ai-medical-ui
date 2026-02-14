import sys
import whisper

def main():
    if len(sys.argv) < 2:
        print("No audio path provided", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]

    model = whisper.load_model("base")
    result = model.transcribe(audio_path)

    text = (result.get("text") or "").strip()
    print(text)

if __name__ == "__main__":
    main()