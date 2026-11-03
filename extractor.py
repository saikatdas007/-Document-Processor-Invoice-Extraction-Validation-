import os
import json
import re
import shutil
import pdfplumber
import pytesseract
import pandas as pd
from PIL import Image, ImageOps

_tesseract_cmd = os.environ.get("TESSERACT_CMD") or shutil.which("tesseract")
_windows_tesseract = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
if not _tesseract_cmd and os.path.isfile(_windows_tesseract):
    _tesseract_cmd = _windows_tesseract
if _tesseract_cmd:
    pytesseract.pytesseract.tesseract_cmd = _tesseract_cmd


class ImageOCRUnavailableError(RuntimeError):
    pass


class ImageOCRFailedError(RuntimeError):
    pass


def _ocr_image(image: Image.Image) -> str:
    prepared = ImageOps.autocontrast(ImageOps.grayscale(image))
    longest_edge = max(prepared.size)
    if longest_edge < 1200:
        scale = min(4, 1200 / longest_edge)
        prepared = prepared.resize(
            (round(prepared.width * scale), round(prepared.height * scale)),
            Image.Resampling.LANCZOS,
        )
    return pytesseract.image_to_string(prepared, config="--psm 6")


def _find_labeled_value(text, labels):
    match = re.search(
        rf"^\s*(?:{labels})\s*:?\s*(.*)$",
        text,
        re.IGNORECASE | re.MULTILINE,
    )
    if not match:
        return None

    value = re.split(r"\s+Ship To\s*:", match.group(1), maxsplit=1, flags=re.IGNORECASE)[0].strip()
    if value and value.casefold().rstrip(":").strip() not in {"ship to", "bill to"}:
        return value

    for line in text[match.end():].splitlines():
        value = line.strip()
        if value and ":" not in value and not re.match(
            r"^(?:Ship To|Bill To)\b", value, re.IGNORECASE
        ):
            return value
    return None


def _extract_pdf_text(pdf_path):
    page_texts = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            if text.strip():
                customer_name = _extract_pdf_customer_name(page)
                if customer_name:
                    text += f"\nCustomer Name: {customer_name}"
                page_texts.append(text)
                continue

            try:
                image = page.to_image(resolution=300).original
                text = pytesseract.image_to_string(image)
            except pytesseract.TesseractNotFoundError as exc:
                raise RuntimeError(
                    "Tesseract OCR must be installed to extract scanned PDFs."
                ) from exc

            if text and text.strip():
                page_texts.append(text)

    return "\n".join(page_texts)


def _extract_pdf_customer_name(page):
    extract_words = getattr(page, "extract_words", None)
    if extract_words is None:
        return None

    words = extract_words()

    def is_word(word, value):
        return word["text"].rstrip(":").casefold() == value.casefold()

    bill_words = [word for word in words if is_word(word, "Bill")]
    ship_words = [word for word in words if is_word(word, "Ship")]
    item_words = [word for word in words if is_word(word, "Item")]

    for bill_word in bill_words:
        bill_to_words = [
            word
            for word in words
            if is_word(word, "To")
            and abs(word["top"] - bill_word["top"]) < 3
            and word["x0"] >= bill_word["x1"]
        ]
        if not bill_to_words:
            continue

        bill_to_word = min(bill_to_words, key=lambda word: word["x0"])
        ship_headers = [
            word
            for word in ship_words
            if word["top"] > bill_word["top"] - 3
            and word["top"] < bill_word["top"] + 15
            and word["x0"] > bill_to_word["x1"]
        ]
        if not ship_headers:
            continue

        column_right = min(word["x0"] for word in ship_headers)
        item_headers = [
            word for word in item_words if word["top"] > bill_word["top"] + 10
        ]
        section_bottom = min(
            (word["top"] for word in item_headers),
            default=getattr(page, "height", float("inf")),
        )
        customer_words = [
            word
            for word in words
            if word["x0"] < column_right
            and bill_word["top"] + 5 < word["top"] < section_bottom
        ]
        customer_words.sort(key=lambda word: (word["top"], word["x0"]))

        lines = []
        for word in customer_words:
            if not lines or abs(lines[-1][0]["top"] - word["top"]) > 3:
                lines.append([word])
            else:
                lines[-1].append(word)
        customer_name = " ".join(
            " ".join(word["text"] for word in line) for line in lines
        ).strip()
        if customer_name:
            return customer_name

    return None


def extract_invoice_fields(text):
    """Extract common invoice fields from labeled text and simple item rows."""
    
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
    
    inv_num_match = re.search(
        r"\b(?:invoice|inv\.?)\s*(?:number|no\.?|#|id)\s*[:#-]?\s*([A-Z0-9]+(?:[-/][A-Z0-9]+)*)",
        text,
        re.IGNORECASE,
    )
    if not inv_num_match:
        inv_num_match = re.search(
            r"^\s*#\s*([A-Z0-9]+(?:[-/][A-Z0-9]+)*)", text, re.MULTILINE
        )
    if inv_num_match:
        extracted_data["invoice_number"] = inv_num_match.group(1)

    date_match = re.search(
        r"\b(?:invoice\s+)?date\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})",
        text,
        re.IGNORECASE,
    )
    if date_match:
        extracted_data["invoice_date"] = date_match.group(1).strip()

    supplier_name = _find_labeled_value(text, r"(?:supplier|vendor|seller|from)")
    if not supplier_name:
        header = text
        bill_to_match = re.search(r"^\s*Bill\s*To\b", text, re.IGNORECASE | re.MULTILINE)
        if bill_to_match:
            header = text[:bill_to_match.start()]
        for line in header.splitlines():
            candidate = re.sub(r"\bINVOICE\b", "", line, flags=re.IGNORECASE).strip(" #:")
            if not candidate or re.match(r"(?:date|invoice|order|ship\s+to)\b", candidate, re.IGNORECASE):
                continue
            if re.fullmatch(r"#?\s*\d+(?:[-/]\d+)*", candidate):
                continue
            supplier_name = candidate
            break
    extracted_data["supplier_name"] = supplier_name

    customer_name_match = re.search(
        r"^\s*Customer\s+Name:\s*(.+?)\s*$", text, re.IGNORECASE | re.MULTILINE
    )
    customer_name = (
        customer_name_match.group(1).strip()
        if customer_name_match
        else _find_labeled_value(
            text, r"(?:bill\s*to|billed\s*to|customer|invoice\s*to)"
        )
    )
    if customer_name:
        customer_name = re.split(r"\s+\d{5}(?:-\d{4})?\b", customer_name, maxsplit=1)[0]
        customer_name = customer_name.strip(" ,")
        is_invoice_label = re.match(
            r"^(?:ship\s*to|bill\s*to|balance\s+due|subtotal|grand\s+total|total)\s*:",
            customer_name,
            re.IGNORECASE,
        )
        if (
            customer_name.casefold() not in {"ship to", "bill to", "balance due"}
            and not is_invoice_label
        ):
            extracted_data["customer_name"] = customer_name or None

    amount = r"\$?\s*(-?[\d,]+(?:\.\d{1,2})?)"
    subtotal_match = re.search(rf"\bsubtotal\b\s*:?\s*{amount}", text, re.IGNORECASE)
    if subtotal_match:
        extracted_data["subtotal"] = float(subtotal_match.group(1).replace(',', ''))

    total_match = re.search(
        rf"\b(?:grand\s+total|balance\s+due|total)\b\s*:?\s*{amount}",
        text,
        re.IGNORECASE,
    )
    if total_match:
        extracted_data["total"] = float(total_match.group(1).replace(',', ''))

    item_pattern = re.compile(
        r"^\s*(?P<product>.+?)\s+\d+(?:\.\d+)?\s+\$?(?P<rate>[\d,]+(?:\.\d{1,2})?)\s+\$?(?P<amount>[\d,]+(?:\.\d{1,2})?)\s*$",
        re.MULTILINE,
    )
    for item_match in item_pattern.finditer(text):
        extracted_data["line_items"].append({
            "product_name": item_match.group("product").strip(),
            "amount": float(item_match.group("amount").replace(',', '')),
        })

    return extracted_data

def process_invoice_to_json(pdf_path):
    """Processes a single PDF invoice and returns its extracted fields."""
    return extract_invoice_fields(_extract_pdf_text(pdf_path))

def extract_text_from_file(file_path: str) -> str:
    """
    Extracts text from uploaded documents, spreadsheets, and images.
    """
    if not os.path.exists(file_path):
        return ""
    
    extracted_text = ""
    file_extension = os.path.splitext(file_path)[1].lower()

    try:
        if file_extension == ".pdf":
            extracted_text = _extract_pdf_text(file_path)
        elif file_extension in [".txt", ".csv"]:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                extracted_text = f.read()
        elif file_extension in [".xls", ".xlsx"]:
            sheets = pd.read_excel(file_path, sheet_name=None)
            extracted_text = "\n".join(
                f"Sheet: {sheet_name}\n{sheet.to_csv(index=False)}"
                for sheet_name, sheet in sheets.items()
            )
        elif file_extension in [".png", ".jpg", ".jpeg"]:
            try:
                with Image.open(file_path) as image:
                    extracted_text = _ocr_image(image)
            except pytesseract.TesseractNotFoundError as exc:
                raise ImageOCRUnavailableError(
                    "Tesseract OCR must be installed to extract text from images."
                ) from exc
            except pytesseract.TesseractError as exc:
                raise ImageOCRFailedError(
                    f"Tesseract OCR failed to process image {os.path.basename(file_path)}."
                ) from exc
            except (OSError, ValueError) as exc:
                raise ImageOCRFailedError(
                    f"Unable to read image {os.path.basename(file_path)}."
                ) from exc
        else:
            extracted_text = f"Uploaded document: {os.path.basename(file_path)}"
            
    except RuntimeError:
        raise
    except Exception as e:
        if file_extension in {".png", ".jpg", ".jpeg"}:
            raise
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