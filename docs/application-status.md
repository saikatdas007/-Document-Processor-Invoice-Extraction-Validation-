# Application Status: Node Backend and Frontend

## Status

The active backend has been ported to **Node.js/Express**, with API paths, session behavior, and the `documents.db` schema preserved for the Next.js dashboard.

## Verification evidence

- `npm.cmd --prefix backend test`: **10 passed** (2026-11-05). Covers health, API documentation, local parser/validation, workbook and PDF extraction, both upload routes, sessions and CSRF, semantic-search ranking, role enforcement, and unsupported file types.
- Node OCR smoke test recognized the invoice number, customer, and total in a synthetic PNG; semantic embedding smoke test returned 384 finite values.
- `npm.cmd --prefix backend audit --omit=dev`: **0 vulnerabilities** (2026-11-05).
- Node.js syntax checks passed for the backend source.
- The earlier Python API regression and invoice-corpus results below are evidence for the retained legacy implementation only; they do not measure Node OCR accuracy.
- `python -m pytest -q test_app.py`: **54 passed** (latest local verification, 2026-11-03).
- `GET http://localhost:8000/`: returned `status: ok`.
- Unauthenticated `GET /analytics`: returned HTTP 401, as expected for a protected endpoint.
- Demo viewer login followed by authenticated `GET /analytics`: succeeded and returned seven daily buckets.
- `npm.cmd --prefix frontend run lint`: passed.
- `npm.cmd --prefix frontend run build`: passed, including TypeScript checking.
- Python compile check (`compileall`): passed.
- `python evaluate.py`: processed 1,007 PDFs; 98.51% passed required-field validation and field accuracy was 99.50%. See [evaluation-report.md](evaluation-report.md) for the measured results and limitations.
- Dashboard sign-in and customer-name semantic search were also exercised in the browser.
- PNG/JPG/JPEG uploads through both API routes are covered by regression tests that verify OCR text is passed to structured extraction; separate tests verify clear responses when Tesseract is missing or recognizes no text.
- Image OCR preprocessing and local extraction passed five controlled synthetic variants: clean, low-resolution, low-contrast, slightly skewed, and compressed JPEG.
- A synthetic invoice PNG was uploaded through `/process` with OpenAI disabled; installed Tesseract and the local parser extracted the expected customer, invoice number, and total, and the API returned `VALID`.

The Python checks above verify the legacy application's flow and controlled OCR samples; they do not establish equivalent Node OCR quality. The Node route tests currently cover local text uploads but do not benchmark image or scanned-PDF OCR. See [processing-pipelines.md](processing-pipelines.md).

## Assessment prototype caveats

- This is a prototype for an interview assessment, not a production-ready service.
- Production hosting must use persistent storage for the SQLite database and uploaded files. OCR/embedding dependencies download their models on first use.
- The full pytest run includes a live OpenAI connectivity request which received HTTP 429 during testing. The local backend regression suite passed; OpenAI quota/rate-limit availability is separate from the local application checks.
- See [test-results.md](test-results.md) for detailed test outcomes and [evaluation-report.md](evaluation-report.md) for measured PDF extraction metrics.
