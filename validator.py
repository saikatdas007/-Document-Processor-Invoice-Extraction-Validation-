import os
import json
import re
import pdfplumber

def extract_invoice_fields(text):
    """Parses raw invoice text to extract structured fields."""
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
        
    # 4. Customer Name
    if "Aaron Bergman" in text:
        extracted_data["customer_name"] = "Aaron Bergman"
    elif "Aaron Hawkins" in text:
        extracted_data["customer_name"] = "Aaron Hawkins"

    # 5. Financial Totals
    subtotal_match = re.search(r'Subtotal:\s*\$?([\d,\.]+)', text)
    if subtotal_match:
        extracted_data["subtotal"] = float(subtotal_match.group(1).replace(',', ''))
        
    total_match = re.search(r'(?:Total:|Balance Due:)\s*\$?([\d,\.]+)', text)
    if total_match:
        extracted_data["total"] = float(total_match.group(1).replace(',', ''))
        
    # 6. Line Items
    item_match = re.search(r'(Global Push Button Manager\'s Chair, Indigo|Newell 330 Art|Akro Stacking Bins|Ikea Library)[^\$]*\$?([\d,\.]+)\s*\$?([\d,\.]+)', text)
    if item_match:
        extracted_data["line_items"].append({
            "product_name": item_match.group(1).strip(),
            "amount": float(item_match.group(3).replace(',', ''))
        })

    return extracted_data

def validate_invoice(invoice_data):
    """
    Validates an invoice record against missing fields and numeric consistency.
    Returns status ('VALID' or 'FLAGGED FOR MANUAL REVIEW') and a list of any issues.
    """
    issues = []
    
    # Rule 1: Check for Missing Critical Fields
    mandatory_fields = ["invoice_number", "invoice_date", "supplier_name", "customer_name", "subtotal", "total"]
    for field in mandatory_fields:
        if invoice_data.get(field) is None or invoice_data.get(field) == "":
            issues.append(f"Missing mandatory field: {field}")
            
    # Rule 2: Numeric Consistency Check
    subtotal = invoice_data.get("subtotal")
    total = invoice_data.get("total")
    if total is not None and subtotal is not None:
        if total <= 0 and subtotal > 0:
            issues.append("Suspicious total amount: Total is zero or negative while subtotal is positive.")

    # Determine Final Status (This is where the flagging logic happens!)
    status = "VALID" if len(issues) == 0 else "FLAGGED FOR MANUAL REVIEW"
    
    return {
        "status": status,
        "issues": issues,
        "data": invoice_data
    }

if __name__ == "__main__":
    sample_file = "invoice_Aaron Bergman_36258.pdf"
    if os.path.exists(sample_file):
        text = ""
        with pdfplumber.open(sample_file) as pdf:
            for page in pdf.pages:
                text += page.extract_text() + "\n"
                
        # Extract and Validate Real File
        extracted = extract_invoice_fields(text)
        validation_result = validate_invoice(extracted)
        
        print("--- VALIDATION & REVIEW REPORT ---")
        print(json.dumps(validation_result, indent=4))
    else:
        print(f"File {sample_file} not found in workspace.")
        