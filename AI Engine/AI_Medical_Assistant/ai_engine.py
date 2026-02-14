import json
from openai import OpenAI

client = OpenAI()

# اقرأ transcript من ملف (مؤقتًا هنحطه يدوي)
transcript_text = """
Patient: I have been having chest pain and shortness of breath for two days.
Doctor: Does the pain get worse with exertion?
Patient: Yes, especially when walking.
"""

system_prompt = f"""
You are a medical clinical assistant.
Given the following transcript, generate a JSON output strictly following this schema:

{open("schema.json", "r", encoding="utf-8").read()}

Rules:
- Output must be valid JSON only.
- Do not add any extra text.
- Fill as much as possible based on the transcript.
"""

response = client.chat.completions.create(
    model="gpt-4.1-mini",
    messages=[
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": transcript_text}
    ],
    temperature=0.2
)

raw_output = response.choices[0].message.content

print("===== RAW AI OUTPUT =====")
print(raw_output)

# حاول نعمل parse للـ JSON
try:
    data = json.loads(raw_output)
    print("\n===== PARSED JSON OK =====")
    print(json.dumps(data, indent=2))
except Exception as e:
    print("\nJSON PARSE ERROR:", e)