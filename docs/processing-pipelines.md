# Document Processing Pipelines

This document describes the active Node.js implementation and distinguishes earlier Python-only measurements.

## PDF

- The Node API uses PDF.js to read text from digital PDFs.
- Scanned pages with no extractable text are rendered with PDF.js and passed to Tesseract.js.
- The local evaluation script was run against the 1,007 PDFs in `1000+ PDF_Invoice_Folder`; see [evaluation-report.md](evaluation-report.md) for measured results and limitations.
- Those corpus measurements are from the legacy Python evaluation path and do not certify the Node.js extractor.

## CSV

- The Node API reads CSV file contents as text before invoice-field extraction.
- The standalone `processor.py` helper can also parse CSV rows into a pandas DataFrame.
- CSV processing is covered by backend tests.

## Excel (XLS/XLSX)

- The Node API reads XLS/XLSX workbook sheets and converts each sheet's contents to text for extraction.
- The standalone `processor.py` helper can parse Excel workbooks into DataFrames.
- Excel extraction behavior is covered by backend tests.

## Images (PNG/JPG/JPEG)

- Both Node upload routes accept PNG, JPG, and JPEG files and preprocess them with Sharp (grayscale, contrast normalization, and upscaling of smaller images by at most 4x) before Tesseract.js OCR.
- English OCR model data is fetched on first use; no system Tesseract executable is required. Allow outbound downloads or set `TESSERACT_CACHE_PATH` to persistent storage.
- The semantic embedding model is also downloaded on first use; set `HF_HOME` to persistent storage to retain it across restarts.
- The legacy Python API required a system Tesseract executable; that requirement does not apply to the Node API.
- Node API route tests cover local text-file upload and auth protections; OCR behavior has not yet been independently benchmarked against the Python OCR test corpus.

## Relevant implementation files

- Node API upload routes and supported extensions: `backend/src/app.js`
- Node PDF, image, text, CSV, and Excel text extraction: `backend/src/extractor.js`
- Node invoice parser and validator: `backend/src/validation.js`
- Legacy Python API upload routes and supported extensions: `app.py`
- Legacy Python extraction helpers: `extractor.py`
- Standalone image OCR, spreadsheet parsing, and batch processing helpers: `processor.py`
- Automated pipeline regression tests: `test_app.py`
