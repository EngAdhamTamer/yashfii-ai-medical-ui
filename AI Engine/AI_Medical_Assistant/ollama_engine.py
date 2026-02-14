import json
import requests
import re
from typing import Any, Dict

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL_NAME = "qwen2.5:3b"

SYSTEM_PROMPT = """
You are a medical AI assistant.
You must return ONLY valid JSON and nothing else.

If the transcript is NOT medical, return this exact schema:
{
  "transcript": {"ar": "", "en": "<original text>"},
  "suggested_questions": [],
  "suggested_diagnoses": [],
  "soap": {"subjective": "", "objective": "", "assessment": "", "plan": ""},
  "prescription": {"text": "", "medications": []},
  "safety_flags": {"red_flags": ["non_medical_transcript"], "needs_urgent_referral": false}
}

If the transcript IS medical, return this schema:
{
  "transcript": {"ar": "", "en": "<cleaned medical dialogue>"},
  "suggested_questions": [ "..."],
  "suggested_diagnoses": [
    {"name": "...", "probability": 0.0, "rationale": "..."}
  ],
  "soap": {
    "subjective": "...",
    "objective": "...",
    "assessment": "...",
    "plan": "..."
  },
  "prescription": {
    "text": "",
    "medications": [
      {"name": "", "dose": "", "route": "", "frequency": "", "duration": "", "notes": ""}
    ]
  },
  "safety_flags": {
    "red_flags": [],
    "needs_urgent_referral": false
  }
}

Rules:
- Output MUST be valid JSON.
- Do NOT add explanations.
- Do NOT add markdown.
- Probabilities must be between 0 and 1.
- If unsure it's medical, mark as non_medical_transcript.
"""

def call_ollama(prompt: str) -> str:
    payload = {
        "model": MODEL_NAME,
        "prompt": prompt,
        "system": SYSTEM_PROMPT,
        "stream": False
    }

    resp = requests.post(OLLAMA_URL, json=payload, timeout=300)
    resp.raise_for_status()
    data = resp.json()
    return data.get("response", "")

def extract_json(text: str) -> Dict[str, Any]:
    """
    Tries to extract JSON object from model output safely.
    """
    # Remove any leading/trailing junk
    text = text.strip()

    # Try direct load
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try to find JSON block inside text
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        json_text = match.group(0)
        return json.loads(json_text)

    raise ValueError("No valid JSON found in model output")

def process_transcript(transcript_text: str) -> Dict[str, Any]:
    user_prompt = f"""
Transcript:
\"\"\"
{transcript_text}
\"\"\"

Analyze and return JSON in the specified format.
"""

    raw_output = call_ollama(user_prompt)

    print("===== RAW OUTPUT =====")
    print(raw_output)

    parsed = extract_json(raw_output)

    return parsed

def main():
    # مثال: هنا بتحط النص اللي جاي من Whisper
    try:
        with open("transcript.json", "r", encoding="utf-8") as f:
            data = json.load(f)
            transcript_text = data.get("text") or data.get("en") or ""
    except FileNotFoundError:
        print("transcript.json not found. Using sample text.")
        transcript_text = "For two days I have chest pain and shortness of breath especially when walking."

    if not transcript_text.strip():
        print("Empty transcript!")
        return

    try:
        result = process_transcript(transcript_text)

        # Simple validation
        if "safety_flags" in result and "red_flags" in result["safety_flags"]:
            if "non_medical_transcript" in result["safety_flags"]["red_flags"]:
                print("===== PARSED JSON OK (NOT_MEDICAL) =====")
            else:
                print("===== PARSED JSON OK =====")
        else:
            print("===== PARSED JSON OK =====")

        print(json.dumps(result, indent=2, ensure_ascii=False))

        # Save output
        with open("ai_result.json", "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)

        print("Saved result to ai_result.json")

    except Exception as e:
        print("ERROR:", str(e))

if __name__ == "__main__":
    main()