import os
import sys
from dotenv import load_dotenv
from openai import OpenAI, OpenAIError

# 1. Explicitly load .env from the current directory
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=True)

api_key = os.getenv("OPENAI_API_KEY")
print(f"OPENAI_API_KEY configured: {bool(api_key)}")

if not api_key:
    print("ERROR: OPENAI_API_KEY is missing or not found in your .env file.")
    sys.exit(1)

client = OpenAI(api_key=api_key, max_retries=0, timeout=30)

try:
    print("Sending test request to OpenAI (gpt-4o-mini)...")
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Reply with: OpenAI connection successful!"}
        ],
    )

    reply = response.choices[0].message.content
    if not reply or not reply.strip():
        print("FAILED: OpenAI returned an empty response.")
        sys.exit(1)
    if not response.model.startswith("gpt-4o-mini"):
        print(f"FAILED: Unexpected response model: {response.model}")
        sys.exit(1)

    print(f"Response model: {response.model}")
    print(f"Response: {reply.strip()}")
    print("SUCCESS: OpenAI API request completed.")

except OpenAIError as error:
    status_code = getattr(error, "status_code", None)
    print(f"FAILED: OpenAI request failed ({type(error).__name__}, HTTP {status_code}).")
    if status_code == 429:
        print("Check API project quota, billing credits, and rate limits.")
    elif status_code == 401:
        print("Check that OPENAI_API_KEY is valid and belongs to the intended project.")
    elif status_code is None:
        print("Check network access and try again.")
    sys.exit(1)