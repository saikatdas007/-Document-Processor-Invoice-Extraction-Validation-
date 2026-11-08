import os

print("Current Folder:")
print(os.getcwd())

print("\nPDF Files:")

pdf_files = []

for file in os.listdir("."):
    if file.lower().endswith(".pdf"):
        pdf_files.append(file)

print(pdf_files)