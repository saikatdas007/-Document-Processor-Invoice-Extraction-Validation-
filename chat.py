# chat.py

import requests

OLLAMA_URL = "http://localhost:11434/api/generate"

def ask_document(question, document_text):

    prompt = f"""
You are an invoice assistant.

Answer the question using ONLY the information
available in the document.

DOCUMENT:

{document_text}

QUESTION:

{question}

ANSWER:
"""

    response = requests.post(
        OLLAMA_URL,
        json={
            "model": "llama3",
            "prompt": prompt,
            "stream": False
        }
    )

    return response.json()["response"]