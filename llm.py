import requests

OLLAMA_URL = "http://localhost:11434/api/generate"

def extract_invoice_with_llm(text):

    if not text or not text.strip():
        return {"error": "No text provided."}

    prompt = f"""
Extract invoice information from the text below.

Return only JSON.

Fields:
- supplier_name
- invoice_number
- invoice_date
- subtotal
- tax
- total
- currency

Invoice Text:

{text}
"""

    try:

        response = requests.post(
            OLLAMA_URL,
            json={
                "model": "llama3",
                "prompt": prompt,
                "stream": False
            },
            timeout=120
        )

        result = response.json()["response"]

        return {
            "llm_response": result
        }

    except Exception as e:
        return {
            "error": str(e)
        }