# Document Processor

Document Processor is a prototype built for an assessment. It demonstrates invoice extraction, validation, and document search; it is not a production-ready document-management system.

## What it does

- Accepts PDF, TXT, CSV, XLS, XLSX, PNG, JPG, and JPEG uploads through the Node.js API.
- Extracts invoice fields with OpenAI when configured, with a local parser fallback.
- Validates required invoice fields and reports missing information for manual review.
- Stores API records in SQLite and supports customer search, semantic search, CSV export, and analytics.
- Supports optional Qdrant Cloud semantic search; SQLite-based ranking remains the default when Qdrant is not configured.
- Provides a Next.js dashboard for sign-in, upload, search, and review.

See [docs/application-status.md](docs/application-status.md) for the verified backend/frontend status and its supporting checks.

### Processing pipeline status

- **PDF:** PDF.js extracts digital text and renders scanned pages for Tesseract.js OCR.
- **CSV and Excel:** CSV and XLS/XLSX sheet extraction is implemented in the Node API.
- **Images:** PNG/JPG/JPEG uploads use contrast-normalized Tesseract.js OCR, with bounded upscaling for small images. OCR language data and the semantic model are downloaded on first use; see [docs/processing-pipelines.md](docs/processing-pipelines.md) for limitations.

See [docs/architecture-and-schema.md](docs/architecture-and-schema.md) for the architecture and [docs/test-results.md](docs/test-results.md) for tested behavior and limitations.


## Requirements

- Node.js 20 or newer and npm
- Python with pip only for the legacy FastAPI app and the corpus evaluation scripts
- An OpenAI API key for the configured OpenAI client. Keep it private; do not commit it.

## Setup on Windows PowerShell

Run commands from the repository root.

### 1. Install and start the Node.js backend

```powershell
npm.cmd --prefix backend ci
npm.cmd --prefix backend run dev
```

The API listens on `http://localhost:8000/`; interactive API documentation is available at `http://localhost:8000/docs`. Configure secrets in the repository-root `.env` file (excluded from Git); `OPENAI_API_KEY` is optional and the local parser is used when it is absent.

### 2. Install and start the frontend

Open a second PowerShell terminal:

```powershell
cd frontend
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:3000/`. Set `NEXT_PUBLIC_API_BASE_URL` to the deployed API origin when hosting the frontend separately.

For local setup, copy `frontend/.env.example` to `frontend/.env.local`. For production, configure `NEXT_PUBLIC_API_BASE_URL` in the frontend host before building; it must be the public origin of the Node API, without a path. Configure the matching exact frontend URL in the API's `FRONTEND_ORIGINS`.

### Deployment

Deploy `backend/` as a Node.js web service with `npm ci` as the build/install command and `npm start` as the start command. The API listens on the host-provided `PORT`. Set `APP_ENV=production`, `AUTH_SECRET_KEY` (at least 32 characters), `FRONTEND_ORIGINS` (the exact comma-separated frontend origins), and any optional AI settings. Attach persistent storage for the SQLite database, uploaded files, and model caches by setting `DATABASE_PATH`, `UPLOAD_DIRECTORY`, `HF_HOME`, and `TESSERACT_CACHE_PATH` to paths on that storage. The embedding model and English OCR data are fetched on first use, so allow outbound downloads or prewarm/cache them on persistent storage. Deploy the `frontend/` directory separately as a Next.js app and set `NEXT_PUBLIC_API_BASE_URL` to the Node API's public origin at build time.

To use Qdrant Cloud for vector search, create a collection endpoint and API key, then set `QDRANT_URL`, `QDRANT_API_KEY`, and optionally `QDRANT_COLLECTION` in the API host's environment. The API creates a 384-dimensional cosine collection if needed and migrates existing SQLite embeddings at startup. Keep the SQLite database as the source for invoice records; do not expose the Qdrant key in frontend settings. Without Qdrant settings, semantic search continues to use SQLite.

### Authentication setup

The sign-in screen supports account creation. New accounts are stored in `documents.db`, passwords are hashed with Argon2id, and browser sessions use short-lived HTTP-only cookies with CSRF protection. New accounts receive the `viewer` role. Any signed-in user can upload and process documents; administrator access is still required for administrator-only actions such as deleting documents.

To create an administrator account, copy `.env.example` to `.env`, generate a unique signing secret, and set the administrator email and a password of at least 12 characters:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Paste the generated value into `AUTH_SECRET_KEY` in `.env`, then set `AUTH_INITIAL_ADMIN_EMAIL` and `AUTH_INITIAL_ADMIN_PASSWORD`. The API creates that account if it does not already exist. Keep `.env` private and restart the API after changing these settings. Configure `FRONTEND_ORIGINS` to the exact origins hosting the frontend.

### Security scope

The application now has persistent accounts, Argon2id password hashing, short-lived HTTP-only sessions, CSRF checks, origin-restricted credentialed CORS, role checks, and basic sign-in/account-creation throttling. Production mode requires a configured signing key and frontend origins; serve both frontend and API over HTTPS.

This is still not a complete production identity system: email ownership is not verified, password reset and MFA are not implemented, and documents are shared across signed-in users rather than isolated by account. Do not use it for sensitive or multi-tenant data until those requirements are addressed and the deployment is independently reviewed. A managed identity provider is recommended for public production use.

## Tests and evaluation

Run the Node.js backend regression tests:

```powershell
npm.cmd --prefix backend test
```

The earlier Python API regression suite is retained for the legacy implementation:

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

- The active dashboard API is the Node.js service in `backend/`; it shares the `documents.db` schema with the legacy FastAPI implementation.
- `app.py` and the Python modules remain for historical regression tests and corpus evaluation; they are not required to run the Node API.
- `database.py` separately defines a SQLAlchemy model and `invoices.db`; it is not the persistence path used by either API.
- Weekly analytics count processing events recorded after event tracking was introduced; old documents have no historical processing timestamp.
