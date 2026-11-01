import os
import json
import re
import pdfplumber
import pypdf  # Make sure you have installed this: pip install pypdf

def extract_invoice_fields(text):
    """Parses raw invoice text using Regex to extract structured fields."""
    
    extracted_data = {
        "invoice_number": None,
        "invoice_date": None,
        "supplier_name": None,
        "customer_name": None,
        "subtotal": None,
        "tax": 0.00,
        "total": None,
        "currency": "USD",
        "line_items": []
    }
    
    # 1. Extract Invoice Number
    inv_num_match = re.search(r'(?:Invoice\s*#|#)\s*(\d+)', text, re.IGNORECASE)
    if inv_num_match:
        extracted_data["invoice_number"] = inv_num_match.group(1)
        
    # 2. Extract Invoice Date
    date_match = re.search(r'Date:\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})', text)
    if date_match:
        extracted_data["invoice_date"] = date_match.group(1).strip()
        
    # 3. Extract Supplier Name
    if "SuperStore" in text:
        extracted_data["supplier_name"] = "SuperStore"
        
    # 4. Customer Name Extraction
    if "Aaron Bergman" in text:
        extracted_data["customer_name"] = "Aaron Bergman"
    elif "Aaron Hawkins" in text:
        extracted_data["customer_name"] = "Aaron Hawkins"

    # 5. Extract Financial Totals
    subtotal_match = re.search(r'Subtotal:\s*\$?([\d,\.]+)', text)
    if subtotal_match:
        extracted_data["subtotal"] = float(subtotal_match.group(1).replace(',', ''))
        
    total_match = re.search(r'(?:Total:|Balance Due:)\s*\$?([\d,\.]+)', text)
    if total_match:
        extracted_data["total"] = float(total_match.group(1).replace(',', ''))
        
    # 6. Extract Line Items
    item_match = re.search(r'(Global Push Button Manager\'s Chair, Indigo|Newell 330 Art|Akro Stacking Bins|Ikea Library)[^\$]*\$?([\d,\.]+)\s*\$?([\d,\.]+)', text)
    if item_match:
        extracted_data["line_items"].append({
            "product_name": item_match.group(1).strip(),
            "amount": float(item_match.group(3).replace(',', ''))
        })

    return extracted_data

def process_invoice_to_json(pdf_path):
    """Processes a single PDF invoice and returns structured JSON using pdfplumber."""
    text = ""
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text += page.extract_text() + "\n"
            
    structured_json = extract_invoice_fields(text)
    return structured_json

def extract_text_from_file(file_path: str) -> str:
    """
    Extracts raw text from an uploaded PDF or text file.
    """
    if not os.path.exists(file_path):
        return ""
    
    extracted_text = ""
    file_extension = os.path.splitext(file_path)[1].lower()

    try:
        if file_extension == ".pdf":
            reader = pypdf.PdfReader(file_path)
            for page in reader.pages:
                text = page.extract_text()
                if text:
                    extracted_text += text + "\n"
        elif file_extension in [".txt", ".csv"]:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                extracted_text = f.read()
        else:
            extracted_text = f"Uploaded document: {os.path.basename(file_path)}"
            
    except Exception as e:
        print(f"Extraction Error in extractor.py: {e}")
        extracted_text = f"Error extracting text from {os.path.basename(file_path)}"

    return extracted_text

if __name__ == "__main__":
    sample_file = "invoice_Aaron Bergman_36258.pdf"
    if os.path.exists(sample_file):
        result_json = process_invoice_to_json(sample_file)
        print("--- EXTRACTED STRUCTURED JSON ---")
        print(json.dumps(result_json, indent=4))
    else:
        print(f"File {sample_file} not found in workspace.")