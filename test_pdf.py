from processor import process_pdf
import os

print("=" * 50)
print("PDF EXTRACTION TEST")
print("=" * 50)

# Find all PDFs automatically
pdf_files = [
    f for f in os.listdir(".")
    if f.lower().endswith(".pdf")
]

if not pdf_files:
    print("No PDF files found.")
    exit()

print("\nPDF Files Found:")
for pdf in pdf_files:
    print(f" - {pdf}")

pdf_file = pdf_files[0]

print(f"\nUsing PDF: {pdf_file}")

# Extract text
text = process_pdf(pdf_file)

print("\n" + "=" * 50)
print("EXTRACTION RESULTS")
print("=" * 50)

print(f"\nText Length: {len(text)}")

if not text.strip():
    print("\nERROR: No text extracted from PDF")
else:
    print("\nSUCCESS: Text extracted")

    print("\nFIRST 1000 CHARACTERS:\n")
    print(text[:1000])

    print("\n" + "=" * 50)
    print("FULL TEXT")
    print("=" * 50)

    print(text)