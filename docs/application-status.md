# Application Status: Backend and Frontend

## Status

The **FastAPI backend API and Next.js frontend are both working** in the verified interview-assessment setup.

## Verification evidence

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

These checks verify the core application flow and a small set of controlled OCR cases, not accuracy across all real-world image quality, orientation, or languages. Image extraction requires Tesseract on the API host; see [processing-pipelines.md](processing-pipelines.md).

## Assessment prototype caveats

- This is a prototype for an interview assessment, not a production-ready service.
- The full pytest run includes a live OpenAI connectivity request which received HTTP 429 during testing. The local backend regression suite passed; OpenAI quota/rate-limit availability is separate from the local application checks.
- See [test-results.md](test-results.md) for detailed test outcomes and [evaluation-report.md](evaluation-report.md) for measured PDF extraction metrics.
