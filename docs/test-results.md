# Test and Build Results

**Earlier checks recorded:** 2026-11-02

For a concise backend/frontend working-status summary, see [application-status.md](application-status.md).

## Passing checks

| Command / check | Result |
|---|---|
| `python -m pytest -q test_app.py` | **53 passed** |
| Generated PNG OCR smoke check | Installed Tesseract recognized the invoice number, customer name, and total in a synthetic image |
| Actual `/process` image-upload smoke check | Tesseract plus local extraction processed a synthetic invoice PNG; the API returned `VALID` with the expected customer, invoice number, and total |
| Generated image-quality variants | Direct OCR plus local extraction passed **5/5** synthetic cases: clean PNG, low-resolution PNG, low-contrast PNG, 2-degree skew, and quality-20 JPEG |
| `npm.cmd --prefix frontend run lint` | **Passed** |
| `npm.cmd --prefix frontend run build` | **Passed**, including TypeScript checking |
| `git diff --check` | **Passed**, no whitespace errors |
| `GET http://localhost:8000/` | Returned `status: ok` |
| `GET /analytics` without credentials | Returned HTTP 401, as expected for a protected endpoint |
| Demo viewer login followed by authenticated `GET /analytics` | Succeeded; returned seven daily buckets |

The live analytics smoke check reported 31 total documents and two processing events in the trailing seven-day window at the time of that check. These are environment-specific database values, not fixed test assertions.

## Latest local verification

**Run date:** 2026-11-03

| Command / check | Result |
|---|---|
| `python -m pytest -q test_app.py` | **54 passed** |
| `npm.cmd --prefix frontend run lint` | **Passed** |
| `npm.cmd --prefix frontend run build` | **Passed**, including TypeScript checking |
| Python compile check (`compileall`) | **Passed** |
| `python evaluate.py` on `1000+ PDF_Invoice_Folder` | **1,007 PDFs**; 992/1,007 validated (98.51%); 5,982/6,012 field matches (99.50%); 69.067 seconds total |

The live OpenAI connectivity test was not run during this verification. It makes an external API request and may be subject to account quota or charges; a previous attempt returned HTTP 429, as described below.

## Node.js backend migration

**Run date:** 2026-11-05

| Command / check | Result |
|---|---|
| `npm.cmd --prefix backend test` | **10 passed** |
| Node syntax checks for backend source | **Passed** |
| Synthetic PNG through Node OCR | **Invoice number, customer, and total recognized** |
| Transformers.js semantic embedding smoke test | **384 finite values returned** |
| `npm.cmd --prefix backend audit --omit=dev` | **0 production dependency vulnerabilities** |

These are focused migration checks. They do not measure Node image/scanned-PDF OCR accuracy or replace the historical Python corpus evaluation above.

## Full-suite limitation

`python -m pytest -q` does not complete cleanly because `test_openai.py` sends a live request to OpenAI and the request returned HTTP 429 (rate limit/quota). This is an external OpenAI access/quota constraint, not a failure of the local application regression tests. OpenAI indicated that credits may be needed; the precise project billing balance was not independently verified. The 54-test result from the latest verification is from the deterministic application suite `test_app.py`, which does not require a successful live OpenAI request.

## Build configuration

The frontend production build passes without the workspace-root warning. `frontend/next.config.ts` explicitly sets the Turbopack root to `frontend/`, so the separate repository-root and frontend package lockfiles no longer leave Next.js to infer the application root.

## Coverage note

Automated tests cover mocked scanned-PDF OCR and PNG/JPG/JPEG OCR through both API upload routes, including missing-Tesseract and no-recognized-text responses. Preprocessing tests verify contrast normalization, bounded upscaling for small images, and that large images are not upscaled. An end-to-end `/process` smoke check used installed Tesseract to OCR a generated invoice PNG; the API extracted the expected customer, invoice number, and total and returned `VALID`. Five additional synthetic cases (clean, low resolution, low contrast, slight skew, and compressed JPEG) passed direct OCR and local field extraction. These controlled samples do not establish accuracy on all real-world documents, orientations, languages, or image conditions. Tesseract must be installed on the API host.

## Security scope

The authentication implementation now stores accounts in SQLite, hashes passwords with Argon2id, uses short-lived HTTP-only cookies, validates CSRF tokens and frontend origins, and throttles repeated account-creation and sign-in attempts. Production mode requires an explicit signing secret and frontend-origin allowlist.

Frontend lint, TypeScript, production-build, and browser authentication checks passed. Those checks did not identify a frontend-specific security issue, but they are not a dedicated security audit and do not prove that the frontend is free of vulnerabilities.

This project remains an **assessment prototype, not a complete production identity or multi-tenant system**. It does not verify email addresses, provide password recovery or MFA, or isolate documents by account. It lacks production features such as centralized logging, monitoring, automated backup, and compliance controls. It has not undergone a production security review.