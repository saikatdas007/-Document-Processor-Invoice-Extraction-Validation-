import os
from dotenv import load_dotenv
from openai import OpenAI

# 1. Explicitly load .env from the current directory
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=True)

api_key = os.getenv("OPENAI_API_KEY")
print(f"Loaded API Key: {bool(api_key)}")

if not api_key:
    print("ERROR: OPENAI_API_KEY is missing or not found in your .env file.")
    exit(1)

# 2. Initialize the OpenAI client
client = OpenAI(api_key=api_key)

try:
    print("Sending test request to OpenAI (gpt-4o-mini)...")
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Say 'OpenAI connection successful!' and confirm the model name."}
        ]
    )
    
    reply = response.choices[0].message.content
    print("\n--- Response from OpenAI ---")
    print(reply)
    print("----------------------------")
    print("SUCCESS: Your OpenAI LLM integration is working perfectly!")

except Exception as e:
    print(f"\nFAILED: An error occurred while communicating with OpenAI: {e}")