from processor import process_pdf
from chat import ask_document

pdf_file = "invoice_Aaron Bergman_36258.pdf"

document_text = process_pdf(pdf_file)

while True:

    question = input("\nAsk a question (or type exit): ")

    if question.lower() == "exit":
        break

    answer = ask_document(
        question,
        document_text
    )

    print("\nAnswer:")
    print(answer)