# Document Processor

Document Processor is a prototype built for an assessment. It demonstrates invoice extraction, validation, and document search; it is not a production-ready document-management system.

## What it does

- Accepts PDF, TXT, CSV, XLS, XLSX, PNG, JPG, and JPEG uploads through the FastAPI API.
- Extracts invoice fields with OpenAI when configured, with a local parser fallback.
- Validates required invoice fields and reports missing information for manual review.
- Stores API records in SQLite and supports customer search, semantic search, CSV export, and analytics.
- Provides a Next.js dashboard for sign-in, upload, search, and review.

See [docs/application-status.md](docs/application-status.md) for the verified backend/frontend status and its supporting checks.

### Processing pipeline status

- **PDF:** text extraction is implemented; scanned pages use Tesseract OCR. The local evaluator measured extraction on the included invoice PDF corpus.
- **CSV and Excel:** text and spreadsheet-sheet extraction are implemented in the API upload path.
- **Images:** PNG/JPG/JPEG uploads use contrast-normalized Tesseract OCR in the API extraction path, with bounded upscaling for small images. OCR requires Tesseract on the API host; see [docs/processing-pipelines.md](docs/processing-pipelines.md) for tested cases and limitations.

See [docs/architecture-and-schema.md](docs/architecture-and-schema.md) for the architecture and [docs/test-results.md](docs/test-results.md) for tested behavior and limitations.


## Requirements

- Python with pip
- Node.js and npm
- Tesseract OCR installed and available on `PATH` for scanned-PDF and image OCR. You can set `TESSERACT_CMD` to the executable path if needed.
- An OpenAI API key for the configured OpenAI client. Keep it private; do not commit it.

## Setup on Windows PowerShell

Run commands from the repository root.

### 1. Create a Python environment and install backend dependencies

```powershell
py -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:OPENAI_API_KEY = "YOUR_OPENAI_API_KEY"
```

Set the environment variable in the same terminal before starting the API. Alternatively, configure it in a local `.env` file that is excluded from Git.

### 2. Start the backend

In the activated Python terminal:

```powershell
python -m uvicorn app:app --reload --port 8000
```

The API health check is at `http://localhost:8000/`. Interactive API documentation is available at `http://localhost:8000/docs`.

### 3. Install and start the frontend

Open a second PowerShell terminal:

```powershell
cd frontend
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:3000/`.

### Authentication setup

The sign-in screen supports account creation. New accounts are stored in `documents.db`, passwords are hashed with Argon2id, and browser sessions use short-lived HTTP-only cookies with CSRF protection. New accounts receive the `viewer` role. Any signed-in user can upload and process documents; administrator access is still required for administrator-only actions such as deleting documents.

To create an administrator account, copy `.env.example` to `.env`, generate a unique signing secret, and set the administrator email and a password of at least 12 characters:

```powershell
py -c "import secrets; print(secrets.token_urlsafe(48))"
```

Paste the generated value into `AUTH_SECRET_KEY` in `.env`, then set `AUTH_INITIAL_ADMIN_EMAIL` and `AUTH_INITIAL_ADMIN_PASSWORD`. The API creates that account if it does not already exist. Keep `.env` private and restart the API after changing these settings. Configure `FRONTEND_ORIGINS` to the exact origins hosting the frontend.

### Security scope

The application now has persistent accounts, Argon2id password hashing, short-lived HTTP-only sessions, CSRF checks, origin-restricted credentialed CORS, role checks, and basic sign-in/account-creation throttling. Production mode requires a configured signing key and frontend origins; serve both frontend and API over HTTPS.

This is still not a complete production identity system: email ownership is not verified, password reset and MFA are not implemented, and documents are shared across signed-in users rather than isolated by account. Do not use it for sensitive or multi-tenant data until those requirements are addressed and the deployment is independently reviewed. A managed identity provider is recommended for public production use.

## Tests and evaluation

Run focused backend regression tests:

```powershell
python -m pytest -q test_app.py
```

Run frontend lint and production build:

```powershell
npm.cmd --prefix frontend run lint
npm.cmd --prefix frontend run build
```

Evaluate the local invoice corpus:

```powershell
python evaluate.py
```

See [docs/test-results.md](docs/test-results.md) and [docs/evaluation-report.md](docs/evaluation-report.md) for recorded results and their limitations.

## Submission documents

- [Architecture and database schema](docs/architecture-and-schema.md)
- [Backend and frontend working status](docs/application-status.md)
- [Processing pipeline coverage](docs/processing-pipelines.md)
- [Measured evaluation report](docs/evaluation-report.md)
- [Test results](docs/test-results.md)
- [AI assistance disclosure and prompts](docs/ai-disclosure.md)
- [Walkthrough recording checklist](docs/walkthrough.md)



## Current architecture caveats

- The FastAPI routes use `documents.db`.
- `database.py` separately defines a SQLAlchemy model and `invoices.db`; it is not the persistence path used by the current API routes.
- Weekly analytics count processing events recorded after event tracking was introduced; old documents have no historical processing timestamp.
