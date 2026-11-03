# Document Processing Pipelines

This document describes the current implementation and verification status of each supported file-type pipeline.

## PDF

- The API upload flow uses `extract_text_from_file` in `extractor.py`.
- Text-based PDFs are read with `pdfplumber`.
- Scanned pages with no extractable text use Tesseract OCR.
- The local evaluation script was run against the 1,007 PDFs in `1000+ PDF_Invoice_Folder`; see [evaluation-report.md](evaluation-report.md) for measured results and limitations.

## CSV

- The API extraction path reads CSV file contents as text before invoice-field extraction.
- The standalone `processor.py` helper can also parse CSV rows into a pandas DataFrame.
- CSV processing is covered by backend tests.

## Excel (XLS/XLSX)

- The API extraction path reads workbook sheets with pandas and converts each sheet's contents to text for extraction.
- The standalone `processor.py` helper can parse Excel workbooks into DataFrames.
- Excel extraction behavior is covered by backend tests.

## Images (PNG/JPG/JPEG)

- Both API upload routes accept PNG, JPG, and JPEG files and pass them through `extract_text_from_file` in `extractor.py`.
- The extractor converts images to grayscale, normalizes contrast, and upscales smaller images by at most 4x before running Tesseract OCR and structured invoice extraction.
- Tesseract must be installed on the API host. Set `TESSERACT_CMD` if its executable is not on `PATH` or the default Windows installation path.
- The upload API returns HTTP 503 when Tesseract is unavailable and HTTP 422 when the image cannot be read, OCR fails, or no text is recognized; it does not treat the filename as extracted invoice content.
- Automated route tests mock the OCR result to verify that both upload routes send recognized text into structured extraction. Preprocessing and OCR were also checked on five synthetic image conditions; see [test-results.md](test-results.md). This limited test set does not establish accuracy across all real-world images.

## Relevant implementation files

- API upload routes and supported extensions: `app.py`
- PDF, image, text, CSV, and Excel text extraction: `extractor.py`
- Standalone image OCR, spreadsheet parsing, and batch processing helpers: `processor.py`
- Automated pipeline regression tests: `test_app.py`
