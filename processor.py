import os
import cv2
import numpy as np
import pandas as pd
import pdfplumber
import pytesseract

from PIL import Image

# =====================================================
# Tesseract Configuration
# =====================================================

pytesseract.pytesseract.tesseract_cmd = (
    r"C:\Program Files\Tesseract-OCR\tesseract.exe"
)

# =====================================================
# PDF PROCESSING
# =====================================================

def process_pdf(file_path):

    """
    Extract text from PDF.
    Uses OCR when no text layer exists.
    """

    extracted_text = ""

    try:

        with pdfplumber.open(file_path) as pdf:

            print(f"Pages Found: {len(pdf.pages)}")

            for page_num, page in enumerate(pdf.pages):

                print(f"\nReading Page {page_num + 1}")

                text = page.extract_text()

                # PDF already contains text
                if text and text.strip():

                    print("✅ Text layer found")

                    extracted_text += (
                        f"\n--- PAGE {page_num + 1} ---\n"
                    )

                    extracted_text += text

                # Scanned PDF
                else:

                    print("⚠ No text layer. Running OCR...")

                    image = page.to_image(
                        resolution=300
                    ).original

                    # PIL -> NumPy
                    img = np.array(image)

                    # Convert to grayscale
                    gray = cv2.cvtColor(
                        img,
                        cv2.COLOR_RGB2GRAY
                    )

                    # Noise reduction
                    blurred = cv2.GaussianBlur(
                        gray,
                        (5, 5),
                        0
                    )

                    # OTSU Threshold
                    threshold = cv2.threshold(
                        blurred,
                        0,
                        255,
                        cv2.THRESH_BINARY + cv2.THRESH_OTSU
                    )[1]

                    # OCR
                    ocr_text = pytesseract.image_to_string(
                        threshold,
                        config="--oem 3 --psm 6 -l eng"
                    )

                    extracted_text += (
                        f"\n--- PAGE {page_num + 1} OCR ---\n"
                    )

                    extracted_text += ocr_text

    except Exception as e:

        print(f"PDF Error: {e}")

    return extracted_text


# =====================================================
# IMAGE PROCESSING
# =====================================================

def process_image(file_path):

    """
    OCR for JPG, PNG, JPEG, TIFF files.
    """

    try:

        image = cv2.imread(file_path)

        if image is None:

            raise FileNotFoundError(
                f"Cannot load image: {file_path}"
            )

        # Grayscale
        gray = cv2.cvtColor(
            image,
            cv2.COLOR_BGR2GRAY
        )

        # Noise reduction
        blurred = cv2.GaussianBlur(
            gray,
            (5, 5),
            0
        )

        # OTSU Threshold
        threshold = cv2.threshold(
            blurred,
            0,
            255,
            cv2.THRESH_BINARY + cv2.THRESH_OTSU
        )[1]

        # OCR
        text = pytesseract.image_to_string(
            threshold,
            config="--oem 3 --psm 6 -l eng"
        )

        return text

    except Exception as e:

        print(f"Image Error: {e}")

        return ""


# =====================================================
# SPREADSHEET PROCESSING
# =====================================================

def process_spreadsheet(file_path):

    """
    Process CSV, XLS, XLSX files.
    """

    try:

        extension = os.path.splitext(
            file_path
        )[1].lower()

        if extension == ".csv":

            df = pd.read_csv(file_path)

            return {
                "Sheet1": df
            }

        return pd.read_excel(
            file_path,
            sheet_name=None
        )

    except Exception as e:

        print(f"Spreadsheet Error: {e}")

        return {}


# =====================================================
# FILE ROUTER
# =====================================================

def process_file(file_path):

    """
    Detect file type automatically.
    """

    extension = os.path.splitext(
        file_path
    )[1].lower()

    if extension == ".pdf":

        return process_pdf(
            file_path
        )

    elif extension in [
        ".jpg",
        ".jpeg",
        ".png",
        ".tiff"
    ]:

        return process_image(
            file_path
        )

    elif extension in [
        ".csv",
        ".xls",
        ".xlsx"
    ]:

        return process_spreadsheet(
            file_path
        )

    else:

        raise ValueError(
            f"Unsupported file type: {extension}"
        )


# =====================================================
# TEST
# =====================================================

if __name__ == "__main__":

    file_path = "invoice_Aaron Bergman_36258.pdf"

    text = process_file(file_path)

    print("\n" + "=" * 60)
    print("EXTRACTED TEXT")
    print("=" * 60)

    print(text[:5000])