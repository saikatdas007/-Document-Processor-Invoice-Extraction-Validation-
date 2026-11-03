import os
import re
import pandas as pd
import pdfplumber
from PIL import Image
import pytesseract
from validator import extract_invoice_fields

def extract_document_data(text):
    """Extract structured invoice fields from text without requiring an API."""
    if not isinstance(text, str) or not text.strip():
        return {"error": "Document text is empty."}

    extracted_data = extract_invoice_fields(text)
    if extracted_data.get("total") is None:
        total_match = re.search(
            r"(?:grand\s+total|total|balance\s+due)\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)",
            text,
            re.IGNORECASE,
        )
        if total_match:
            extracted_data["total"] = float(total_match.group(1).replace(",", ""))

    if extracted_data.get("total") is None:
        return {"error": "Could not extract an invoice total."}

    return extracted_data

def process_pdf(file_path):
    """Extracts text from digital PDFs, falls back to OCR if text is empty."""
    extracted_text = ""
    try:
        with pdfplumber.open(file_path) as pdf:
            for page_idx, page in enumerate(pdf.pages):
                text = page.extract_text()
                if text and text.strip():
                    extracted_text += f"\n--- Page {page_idx + 1} ---\n" + text
                else:
                    # Fallback to OCR if the PDF page is an image/scanned
                    pil_image = page.to_image(resolution=300).original
                    ocr_text = pytesseract.image_to_string(pil_image)
                    extracted_text += f"\n--- Page {page_idx + 1} (OCR) ---\n" + ocr_text
    except Exception as e:
        print(f"Error reading PDF {file_path}: {e}")
    return extracted_text

def process_image(file_path):
    """Performs OCR on standalone image files (JPG, PNG, TIFF)."""
    try:
        image = Image.open(file_path)
        return pytesseract.image_to_string(image)
    except Exception as e:
        print(f"Error reading image {file_path}: {e}")
        return ""

def process_spreadsheet(file_path):
    """Parses structured spreadsheet data (XLSX, XLS, CSV) across all sheets."""
    try:
        if os.path.splitext(file_path)[1].lower() == '.csv':
            df = pd.read_csv(file_path)
            return {"Sheet1": df}
        else:
            return pd.read_excel(file_path, sheet_name=None)
    except Exception as e:
        print(f"Error parsing spreadsheet {file_path}: {e}")
        return {}

def batch_process_folder(folder_path):
    """Scans a folder and automatically processes all supported invoice files."""
    if not os.path.exists(folder_path):
        print(f"Folder not found: {folder_path}")
        return

    print(f"Scanning folder: {folder_path}\n" + "="*45)
    
    files = os.listdir(folder_path)
    success_count = 0

    for filename in files:
        file_path = os.path.join(folder_path, filename)
        
        # Skip subdirectories
        if os.path.isdir(file_path):
            continue
            
        ext = filename.lower().split('.')[-1]
        
        if ext in ['pdf', 'jpg', 'jpeg', 'png', 'tiff', 'xlsx', 'xls', 'csv']:
            print(f"\n[Processing] {filename}")
            
            if ext == 'pdf':
                data = process_pdf(file_path)
            elif ext in ['jpg', 'jpeg', 'png', 'tiff']:
                data = process_image(file_path)
            else:
                data = process_spreadsheet(file_path)
                
            if isinstance(data, dict):
                has_data = any(not sheet.empty for sheet in data.values())
            else:
                has_data = isinstance(data, str) and bool(data.strip())

            # Verification & Display: Check if data was extracted and print preview
            if has_data:
                print(f" -> Success! Extracted data from {filename}")
                print(f"--- PREVIEW OF {filename} ---")
                
                if isinstance(data, dict):
                    # For spreadsheets (CSV/Excel dictionaries containing DataFrames)
                    for sheet_name, df in data.items():
                        print(f"Sheet: {sheet_name}")
                        print(df.head(3)) # Prints first 3 rows of the dataframe
                else:
                    # For PDFs and Images (plain text strings)
                    print(str(data)[:400] + "...\n[Content truncated for display]")
                
                print("-" * 45)
                success_count += 1
            else:
                print(f" -> Warning: No data extracted or file is empty.")
        else:
            continue

    print("\n" + "="*45)
    print(f"Batch processing complete. Successfully processed {success_count} files.")

if __name__ == "__main__":
    # Target folder set to current workspace directory "."
    target_folder = "." 
    batch_process_folder(target_folder)