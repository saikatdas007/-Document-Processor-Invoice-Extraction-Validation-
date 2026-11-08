from processor import process_pdf
from llm import extract_invoice_with_llm
import os

pdf_files = [
    f for f in os.listdir(".")
    if f.lower().endswith(".pdf")
]

pdf_file = pdf_files[0]

print(f"Using PDF: {pdf_file}")

text = process_pdf(pdf_file)

print("\nTEXT LENGTH:")
print(len(text))

result = extract_invoice_with_llm(text)

print("\nLLM RESULT:\n")
print(result)