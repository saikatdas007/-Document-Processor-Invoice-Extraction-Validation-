import csv
import hmac
import io
import math
import os
import json
import re
import secrets
import sqlite3
import shutil
import uuid
import traceback
import time
from functools import lru_cache
from datetime import datetime, timedelta, timezone
from typing import Optional
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, Security, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from openai import OpenAI
from validator import validate_invoice

# --- Explicitly load .env from the current directory ---
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

# Debug print to verify if the key was successfully loaded
api_key_check = os.getenv("OPENAI_API_KEY")
print(f"DEBUG: OPENAI_API_KEY loaded successfully? {bool(api_key_check)}")

# Initialize OpenAI client explicitly passing the key
client = OpenAI(api_key=api_key_check)

# Import your custom text extractor from extractor.py
from extractor import extract_invoice_fields as extract_text_invoice_fields
from extractor import ImageOCRFailedError, ImageOCRUnavailableError
from extractor import extract_text_from_file

app = FastAPI()

APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
IS_PRODUCTION = APP_ENV == "production"
configured_secret = os.getenv("AUTH_SECRET_KEY", "").strip()
if configured_secret and len(configured_secret) < 32:
    raise RuntimeError("AUTH_SECRET_KEY must contain at least 32 characters.")
if IS_PRODUCTION and not configured_secret:
    raise RuntimeError("AUTH_SECRET_KEY must be configured in production.")
if IS_PRODUCTION and not os.getenv("FRONTEND_ORIGINS", "").strip():
    raise RuntimeError("FRONTEND_ORIGINS must be configured in production.")
SECRET_KEY = configured_secret or secrets.token_urlsafe(48)
if not configured_secret:
    print("WARNING: Using an ephemeral development auth key; sessions will expire when the API restarts.")

configured_origins = os.getenv("FRONTEND_ORIGINS", "").strip()
ALLOWED_FRONTEND_ORIGINS = (
    [origin.strip() for origin in configured_origins.split(",") if origin.strip()]
    if configured_origins
    else [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ]
)
if IS_PRODUCTION and not ALLOWED_FRONTEND_ORIGINS:
    raise RuntimeError("FRONTEND_ORIGINS must include at least one valid origin.")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_FRONTEND_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type", "X-CSRF-Token"],
)

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
SESSION_COOKIE_NAME = "document-processor-session"
CSRF_COOKIE_NAME = "document-processor-csrf"
SESSION_COOKIE_SECURE = IS_PRODUCTION
MAX_AUTH_ATTEMPTS = 5
AUTH_ATTEMPT_WINDOW_SECONDS = 15 * 60

password_hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
DUMMY_PASSWORD_HASH = password_hasher.hash(secrets.token_urlsafe(32))
security = OAuth2PasswordBearer(tokenUrl="/api/auth/token", auto_error=False)


class AuthCredentials(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(min_length=1, max_length=128)


def normalize_email(email: str) -> str:
    normalized = email.strip().casefold()
    if (
        len(normalized) > 320
        or not re.fullmatch(r"[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}", normalized)
    ):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    return normalized


def validate_new_password(password: str) -> None:
    if len(password) < 12:
        raise HTTPException(
            status_code=422,
            detail="Use a password with at least 12 characters.",
        )
    if len(password) > 128:
        raise HTTPException(
            status_code=422,
            detail="Passwords must be 128 characters or fewer.",
        )


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return password_hasher.verify(hashed_password, plain_password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _auth_attempt_key(scope: str, value: str) -> str:
    return f"{scope}:{value}"


def _is_auth_rate_limited(keys: list[str]) -> bool:
    now = time.time()
    with sqlite3.connect(DB_NAME) as conn:
        for key in keys:
            row = conn.execute(
                "SELECT attempts, window_started_at FROM auth_attempts WHERE attempt_key = ?",
                (key,),
            ).fetchone()
            if not row:
                continue
            attempts, window_started_at = row
            if now - window_started_at < AUTH_ATTEMPT_WINDOW_SECONDS and attempts >= MAX_AUTH_ATTEMPTS:
                return True
    return False


def _record_auth_failure(keys: list[str]) -> None:
    now = time.time()
    with sqlite3.connect(DB_NAME) as conn:
        conn.execute(
            "DELETE FROM auth_attempts WHERE window_started_at < ?",
            (now - AUTH_ATTEMPT_WINDOW_SECONDS,),
        )
        for key in keys:
            conn.execute(
                """
                INSERT INTO auth_attempts (attempt_key, attempts, window_started_at)
                VALUES (?, 1, ?)
                ON CONFLICT(attempt_key) DO UPDATE SET
                    attempts = CASE
                        WHEN excluded.window_started_at - auth_attempts.window_started_at >= ?
                        THEN 1 ELSE auth_attempts.attempts + 1
                    END,
                    window_started_at = CASE
                        WHEN excluded.window_started_at - auth_attempts.window_started_at >= ?
                        THEN excluded.window_started_at ELSE auth_attempts.window_started_at
                    END
                """,
                (key, now, AUTH_ATTEMPT_WINDOW_SECONDS, AUTH_ATTEMPT_WINDOW_SECONDS),
            )


def _clear_auth_failures(keys: list[str]) -> None:
    with sqlite3.connect(DB_NAME) as conn:
        conn.executemany(
            "DELETE FROM auth_attempts WHERE attempt_key = ?",
            [(key,) for key in keys],
        )


def _validate_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin and origin not in ALLOWED_FRONTEND_ORIGINS:
        raise HTTPException(status_code=403, detail="Request origin is not allowed.")


def _validate_csrf(request: Request) -> None:
    _validate_origin(request)
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME)
    csrf_header = request.headers.get("X-CSRF-Token")
    if (
        not csrf_cookie
        or not csrf_header
        or not hmac.compare_digest(csrf_cookie, csrf_header)
    ):
        raise HTTPException(status_code=403, detail="CSRF validation failed.")


def _issue_session(response: Response, email: str, role: str) -> str:
    token = create_access_token({"sub": email, "role": role})
    csrf_token = secrets.token_urlsafe(32)
    max_age = ACCESS_TOKEN_EXPIRE_MINUTES * 60
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        max_age=max_age,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite="strict",
        path="/",
    )
    response.set_cookie(
        CSRF_COOKIE_NAME,
        csrf_token,
        max_age=max_age,
        httponly=False,
        secure=SESSION_COOKIE_SECURE,
        samesite="strict",
        path="/",
    )
    response.headers["Cache-Control"] = "no-store"
    return csrf_token


def _authenticate_user(email: str, password: str, request: Request) -> sqlite3.Row:
    normalized_email = normalize_email(email)
    email_key = _auth_attempt_key("login-email", normalized_email)
    ip_key = _auth_attempt_key("login-ip", _client_ip(request))
    rate_keys = [email_key, ip_key]
    if _is_auth_rate_limited(rate_keys):
        raise HTTPException(
            status_code=429,
            detail="Too many sign-in attempts. Try again in 15 minutes.",
        )

    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    try:
        user = conn.execute(
            "SELECT email, password_hash, role, is_active FROM users WHERE email = ?",
            (normalized_email,),
        ).fetchone()
    finally:
        conn.close()

    stored_hash = user["password_hash"] if user else DUMMY_PASSWORD_HASH
    if (
        not verify_password(password, stored_hash)
        or not user
        or not user["is_active"]
    ):
        _record_auth_failure(rate_keys)
        raise HTTPException(status_code=401, detail="Incorrect email or password.")

    _clear_auth_failures(rate_keys)
    return user


def _database_amount(value):
    if value is None or value == "":
        return None
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    return amount if math.isfinite(amount) else None


def _fill_missing_customer_name(extracted_data: dict, raw_text: str) -> dict:
    customer_name = extracted_data.get("customer_name")
    missing_values = {
        "",
        "n/a",
        "na",
        "none",
        "not provided",
        "null",
        "string",
        "unknown",
        "unknown customer",
    }
    if not isinstance(customer_name, str) or customer_name.strip().casefold() in missing_values:
        local_customer_name = extract_text_invoice_fields(raw_text).get("customer_name")
        if local_customer_name:
            extracted_data["customer_name"] = local_customer_name
    return extracted_data


@lru_cache(maxsize=1)
def _get_semantic_model():
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer("all-MiniLM-L6-v2")


def _encode_semantic_text(text: str) -> list[float]:
    vector = _get_semantic_model().encode(text)
    return [float(value) for value in vector]


def _document_search_text(raw_text: str, extracted_data: dict) -> str:
    structured_fields = (
        "customer_name",
        "invoice_number",
        "invoice_date",
        "supplier_name",
        "subtotal",
        "total",
    )
    summary = "\n".join(
        f"{field.replace('_', ' ').title()}: {extracted_data[field]}"
        for field in structured_fields
        if extracted_data.get(field) is not None
    )
    return f"{raw_text}\n{summary}".strip()


def _try_encode_document(raw_text: str, extracted_data: dict):
    try:
        return _encode_semantic_text(_document_search_text(raw_text, extracted_data)), None
    except Exception as exc:
        print(f"Semantic indexing failed for an uploaded document: {exc}")
        return None, "Document processed, but could not be added to semantic search."


def _store_document_embedding(
    cursor: sqlite3.Cursor, doc_id: str, embedding: Optional[list[float]]
):
    if embedding is None:
        return False
    cursor.execute(
        "INSERT OR REPLACE INTO document_embeddings (doc_id, embedding) VALUES (?, ?)",
        (doc_id, json.dumps(embedding)),
    )
    return True


def _record_document_processing(cursor: sqlite3.Cursor, doc_id: str) -> None:
    cursor.execute(
        "INSERT INTO document_processing_events (doc_id, processed_at) VALUES (?, ?)",
        (doc_id, datetime.now(timezone.utc).isoformat(timespec="seconds")),
    )


def _customer_name_matches_query(customer_name: Optional[str], query: str) -> bool:
    if not customer_name:
        return False

    def normalize(value: str) -> str:
        return " ".join(re.sub(r"[^\w]+", " ", value.casefold()).split())

    normalized_name = normalize(customer_name)
    normalized_query = normalize(query)
    return bool(
        normalized_name
        and normalized_query
        and (
            normalized_name in normalized_query
            or normalized_query in normalized_name
        )
    )


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def require_role(required_role: str):
    def role_dependency(
        request: Request,
        bearer_token: Optional[str] = Security(security),
    ):
        _validate_origin(request)
        if SESSION_COOKIE_NAME in request.cookies and not bearer_token:
            _validate_csrf(request)

        token = bearer_token or request.cookies.get(SESSION_COOKIE_NAME)
        if not token:
            raise HTTPException(
                status_code=401,
                detail="Authentication is required.",
                headers={"WWW-Authenticate": "Bearer"},
            )

        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            username = payload.get("sub")
            role = payload.get("role")
            if (
                not isinstance(username, str)
                or not isinstance(role, str)
                or role not in {"admin", "viewer"}
            ):
                raise HTTPException(
                    status_code=401, detail="Invalid authentication credentials"
                )

            if role != "admin" and role != required_role:
                raise HTTPException(
                    status_code=403, detail="Operation not permitted for your role"
                )

            return {"username": username, "role": role}
        except JWTError:
            raise HTTPException(status_code=401, detail="Could not validate credentials")

    return role_dependency


# --- Database Setup ---
DB_NAME = "documents.db"
SUPPORTED_UPLOAD_EXTENSIONS = {
    ".pdf",
    ".txt",
    ".csv",
    ".xls",
    ".xlsx",
    ".png",
    ".jpg",
    ".jpeg",
}
IMAGE_UPLOAD_EXTENSIONS = {".png", ".jpg", ".jpeg"}


def _extract_uploaded_text(file_location: str, filename: str, file_extension: str) -> str:
    try:
        raw_text = extract_text_from_file(file_location)
    except ImageOCRUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ImageOCRFailedError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as extract_err:
        if file_extension in IMAGE_UPLOAD_EXTENSIONS:
            raise
        print(f"Warning: Text extraction failed: {extract_err}")
        raw_text = f"Document filename: {filename}"

    if file_extension in IMAGE_UPLOAD_EXTENSIONS and not raw_text.strip():
        raise HTTPException(
            status_code=422,
            detail="No text could be recognized in the uploaded image.",
        )
    return raw_text if raw_text.strip() else f"Document filename: {filename}"


def init_db():
    initial_admin_email = os.getenv("AUTH_INITIAL_ADMIN_EMAIL", "").strip()
    initial_admin_password = os.getenv("AUTH_INITIAL_ADMIN_PASSWORD", "")
    if bool(initial_admin_email) != bool(initial_admin_password):
        raise RuntimeError(
            "Set both AUTH_INITIAL_ADMIN_EMAIL and AUTH_INITIAL_ADMIN_PASSWORD to bootstrap an admin."
        )
    normalized_admin_email = None
    if initial_admin_email:
        normalized_admin_email = normalize_email(initial_admin_email)
        validate_new_password(initial_admin_password)

    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS documents (
            doc_id TEXT PRIMARY KEY,
            customer_name TEXT,
            invoice_number TEXT,
            subtotal REAL,
            total REAL,
            validation_status TEXT,
            status TEXT
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS document_embeddings (
            doc_id TEXT PRIMARY KEY,
            embedding TEXT NOT NULL,
            FOREIGN KEY (doc_id) REFERENCES documents (doc_id) ON DELETE CASCADE
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS document_processing_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT NOT NULL,
            processed_at TEXT NOT NULL
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS auth_attempts (
            attempt_key TEXT PRIMARY KEY,
            attempts INTEGER NOT NULL,
            window_started_at REAL NOT NULL
        )
    """)
    if normalized_admin_email:
        existing_admin = cursor.execute(
            "SELECT 1 FROM users WHERE email = ?",
            (normalized_admin_email,),
        ).fetchone()
        if not existing_admin:
            cursor.execute(
            """
            INSERT INTO users (email, password_hash, role, created_at)
            VALUES (?, ?, 'admin', ?)
            """,
            (
                normalized_admin_email,
                password_hasher.hash(initial_admin_password),
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
            ),
            )
    conn.commit()
    conn.close()


init_db()


@app.post("/api/auth/register", status_code=201)
def register_account(
    credentials: AuthCredentials,
    request: Request,
    response: Response,
):
    _validate_origin(request)
    email = normalize_email(credentials.email)
    validate_new_password(credentials.password)
    registration_key = _auth_attempt_key("register-ip", _client_ip(request))
    if _is_auth_rate_limited([registration_key]):
        raise HTTPException(
            status_code=429,
            detail="Too many account creation attempts. Try again in 15 minutes.",
        )
    _record_auth_failure([registration_key])

    password_hash = password_hasher.hash(credentials.password)
    conn = sqlite3.connect(DB_NAME)
    try:
        conn.execute(
            """
            INSERT INTO users (email, password_hash, role, created_at)
            VALUES (?, ?, 'viewer', ?)
            """,
            (
                email,
                password_hash,
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
            ),
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail="An account with this email already exists.",
        ) from exc
    finally:
        conn.close()

    csrf_token = _issue_session(response, email, "viewer")
    return {"email": email, "role": "viewer", "csrf_token": csrf_token}


@app.post("/api/auth/login")
def login_account(
    credentials: AuthCredentials,
    request: Request,
    response: Response,
):
    _validate_origin(request)
    user = _authenticate_user(credentials.email, credentials.password, request)
    csrf_token = _issue_session(response, user["email"], user["role"])
    return {
        "email": user["email"],
        "role": user["role"],
        "csrf_token": csrf_token,
    }


@app.post("/api/auth/logout")
def logout_account(request: Request, response: Response):
    _validate_csrf(request)
    response.delete_cookie(
        SESSION_COOKIE_NAME,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite="strict",
        path="/",
    )
    response.delete_cookie(
        CSRF_COOKIE_NAME,
        httponly=False,
        secure=SESSION_COOKIE_SECURE,
        samesite="strict",
        path="/",
    )
    response.headers["Cache-Control"] = "no-store"
    return {"message": "Signed out."}


@app.get("/api/auth/me")
def current_account(
    response: Response,
    request: Request,
    user: dict = Security(require_role("viewer")),
):
    csrf_token = request.cookies.get(CSRF_COOKIE_NAME)
    if not csrf_token:
        csrf_token = secrets.token_urlsafe(32)
        response.set_cookie(
            CSRF_COOKIE_NAME,
            csrf_token,
            max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
            httponly=False,
            secure=SESSION_COOKIE_SECURE,
            samesite="strict",
            path="/",
        )
    response.headers["Cache-Control"] = "no-store"
    return {
        "email": user["username"],
        "role": user["role"],
        "csrf_token": csrf_token,
    }


@app.post("/api/auth/token")
def swagger_login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
):
    _validate_origin(request)
    user = _authenticate_user(form_data.username, form_data.password, request)
    access_token = create_access_token(
        data={"sub": user["email"], "role": user["role"]},
        expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "role": user["role"],
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }


# --- Document Endpoints ---
@app.get("/api/documents/search")
def search_documents(
    customer: Optional[str] = None, user: dict = Security(require_role("viewer"))
):
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    if customer:
        cursor.execute(
            "SELECT * FROM documents WHERE customer_name LIKE ?",
            (f"%{customer}%",),
        )
    else:
        cursor.execute("SELECT * FROM documents")

    rows = cursor.fetchall()
    conn.close()

    results = []
    for row in rows:
        results.append({
            "doc_id": row["doc_id"],
            "structured_data": {
                "customer_name": row["customer_name"],
                "invoice_number": row["invoice_number"],
                "subtotal": row["subtotal"],
                "total": row["total"],
            },
            "validation_status": row["validation_status"],
            "status": row["status"],
        })

    return {"results": results}


@app.post("/api/documents/semantic-search")
def semantic_search_documents(
    payload: dict, user: dict = Security(require_role("viewer"))
):
    query = payload.get("query")
    if not isinstance(query, str) or not query.strip():
        raise HTTPException(status_code=400, detail="A non-empty search query is required.")
    if len(query) > 1000:
        raise HTTPException(status_code=400, detail="Search queries must be 1000 characters or fewer.")

    top_k = payload.get("top_k", 5)
    if isinstance(top_k, bool) or not isinstance(top_k, int) or not 1 <= top_k <= 20:
        raise HTTPException(status_code=400, detail="top_k must be an integer from 1 to 20.")

    try:
        query_vector = _encode_semantic_text(query)
    except Exception as exc:
        print(f"Semantic search model failed to load or encode a query: {exc}")
        raise HTTPException(
            status_code=503,
            detail="Semantic search is unavailable. Check that the local embedding model is installed and available.",
        ) from exc

    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    try:
        missing_embeddings = conn.execute(
            """
            SELECT d.doc_id, d.customer_name, d.invoice_number, d.subtotal, d.total,
                   d.validation_status, d.status
            FROM documents AS d
            LEFT JOIN document_embeddings AS e ON e.doc_id = d.doc_id
            WHERE e.doc_id IS NULL
            """
        ).fetchall()

        for document in missing_embeddings:
            fields = {
                "customer_name": document["customer_name"],
                "invoice_number": document["invoice_number"],
                "subtotal": document["subtotal"],
                "total": document["total"],
                "validation_status": document["validation_status"],
                "status": document["status"],
            }
            searchable_text = "\n".join(
                f"{field.replace('_', ' ').title()}: {value}"
                for field, value in fields.items()
                if value is not None
            )
            if not searchable_text:
                continue
            embedding = _encode_semantic_text(searchable_text)
            conn.execute(
                "INSERT INTO document_embeddings (doc_id, embedding) VALUES (?, ?)",
                (document["doc_id"], json.dumps(embedding)),
            )
        conn.commit()

        rows = conn.execute(
            """
            SELECT d.doc_id, d.customer_name, d.invoice_number, d.subtotal, d.total,
                   d.validation_status, d.status, e.embedding
            FROM documents AS d
            JOIN document_embeddings AS e ON e.doc_id = d.doc_id
            """
        ).fetchall()
    except Exception as exc:
        conn.rollback()
        print(f"Semantic search failed while loading document embeddings: {exc}")
        raise HTTPException(status_code=500, detail="Unable to search indexed documents.") from exc
    finally:
        conn.close()

    query_norm = math.sqrt(sum(value * value for value in query_vector))
    if query_norm == 0:
        raise HTTPException(status_code=503, detail="The search model returned an empty query vector.")

    scored_results = []
    for row in rows:
        try:
            document_vector = json.loads(row["embedding"])
            if len(document_vector) != len(query_vector):
                raise ValueError("Stored embedding dimension does not match the query model.")
            document_norm = math.sqrt(sum(value * value for value in document_vector))
            if document_norm == 0:
                continue
            score = sum(
                query_value * document_value
                for query_value, document_value in zip(query_vector, document_vector)
            ) / (query_norm * document_norm)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=500, detail="A stored document embedding is invalid."
            ) from exc

        result = {
            "doc_id": row["doc_id"],
            "score": score,
            "customer_name": row["customer_name"],
            "invoice_number": row["invoice_number"],
            "subtotal": row["subtotal"],
            "total": row["total"],
            "validation_status": row["validation_status"],
            "status": row["status"],
        }
        name_match = _customer_name_matches_query(row["customer_name"], query)
        scored_results.append((name_match, result))

    scored_results.sort(
        key=lambda item: (item[0], item[1]["score"]),
        reverse=True,
    )
    matching_customer_results = [
        item for item in scored_results if item[0]
    ]
    if matching_customer_results:
        scored_results = matching_customer_results

    return {
        "query": query.strip(),
        "results": [result for _, result in scored_results[:top_k]],
    }


@app.post("/api/documents/upload")
async def upload_document(
    file: UploadFile = File(...), user: dict = Security(require_role("viewer"))
):
    file_extension = os.path.splitext(file.filename or "")[1].lower()
    if file_extension not in SUPPORTED_UPLOAD_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Upload a PDF, TXT, CSV, XLS, XLSX, PNG, JPG, or JPEG file.",
        )

    try:
        # 1. Save uploaded file locally
        os.makedirs("uploaded_docs", exist_ok=True)
        file_location = f"uploaded_docs/{file.filename}"
        with open(file_location, "wb+") as file_object:
            shutil.copyfileobj(file.file, file_object)

        # 2. Extract raw text with fallback protection
        raw_text = _extract_uploaded_text(file_location, file.filename or "", file_extension)

        # 3. Extract structured fields, then validate them independently.
        try:
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "system",
                        "content": "You are a document intelligence assistant. Extract customer_name, invoice_number, invoice_date, supplier_name, subtotal, total into a valid JSON object. Use null for fields that are not present; never guess or claim validation status."
                    },
                    {
                        "role": "user",
                        "content": f"Extract metadata from this document text:\n{raw_text}"
                    }
                ],
                response_format={"type": "json_object"}
            )
            llm_data = json.loads(response.choices[0].message.content)
        except Exception as openai_err:
            print(f"Warning: OpenAI extraction failed ({openai_err}), using local extraction.")
            from processor import extract_document_data

            llm_data = extract_document_data(raw_text)

        llm_data = _fill_missing_customer_name(llm_data, raw_text)
        doc_id = str(uuid.uuid4())
        validation = validate_invoice(llm_data)
        customer_name = llm_data.get("customer_name")
        invoice_number = llm_data.get("invoice_number")
        subtotal = _database_amount(llm_data.get("subtotal"))
        total = _database_amount(llm_data.get("total"))
        validation_status = validation["status"]
        status_val = "success" if validation_status == "VALID" else "failed"
        embedding, semantic_warning = _try_encode_document(raw_text, llm_data)

        # 4. Save to SQLite database
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                doc_id,
                customer_name,
                invoice_number,
                subtotal,
                total,
                validation_status,
                status_val,
            ),
        )
        _record_document_processing(cursor, doc_id)
        semantic_indexed = _store_document_embedding(cursor, doc_id, embedding)
        conn.commit()
        conn.close()

        return {
            "doc_id": doc_id,
            "status": validation_status,
            "validation_issues": validation["issues"],
            "extracted_intelligence": llm_data,
            "semantic_search_indexed": semantic_indexed,
            "semantic_search_warning": semantic_warning,
        }

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/documents/{doc_id}/correct")
def correct_document(
    doc_id: str,
    payload: dict,
    user: dict = Security(require_role("admin")),
):
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    customer_name = payload.get("customer_name")
    subtotal = payload.get("subtotal")
    total = payload.get("total")

    cursor.execute(
        """UPDATE documents SET customer_name = COALESCE(?, customer_name), 
           subtotal = COALESCE(?, subtotal), total = COALESCE(?, total), 
           validation_status = 'VALID' WHERE doc_id = ?""",
        (customer_name, subtotal, total, doc_id),
    )
    conn.commit()
    conn.close()

    return {"status": "success", "message": f"Corrected by {user['username']}"}


@app.get("/api/documents/export-csv")
def export_documents_csv(user: dict = Security(require_role("viewer"))):
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM documents")
    rows = cursor.fetchall()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow([
        "Document ID",
        "Customer Name",
        "Invoice Number",
        "Subtotal",
        "Total",
        "Validation Status",
    ])

    for row in rows:
        writer.writerow([
            row["doc_id"],
            row["customer_name"] or "N/A",
            row["invoice_number"] or "N/A",
            row["subtotal"] or 0.0,
            row["total"] or 0.0,
            row["validation_status"] or "UNKNOWN",
        ])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment;filename=document_report.csv"
        },
    )


@app.get("/api/documents/analytics")
def get_document_analytics(user: dict = Security(require_role("viewer"))):
    return [
        {"date": "Mon", "processed": 4},
        {"date": "Tue", "processed": 7},
        {"date": "Wed", "processed": 3},
        {"date": "Thu", "processed": 12},
        {"date": "Fri", "processed": 9},
        {"date": "Sat", "processed": 5},
        {"date": "Sun", "processed": 8}
    ]


@app.get("/")
def root():
    return {"status": "ok", "message": "Document Processor API is running"}


@app.get("/analytics")
def get_analytics(user: dict = Security(require_role("viewer"))):
    today = datetime.now(timezone.utc).date()
    first_day = today - timedelta(days=6)
    try:
        conn = sqlite3.connect(DB_NAME)
        total_processed = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        successful_rows = conn.execute(
            "SELECT COUNT(*) FROM documents WHERE status = 'success' AND validation_status = 'VALID'"
        ).fetchone()[0]
        failed_rows = max(total_processed - successful_rows, 0)
        daily_counts = dict(
            conn.execute(
                """
                SELECT date(processed_at), COUNT(*)
                FROM document_processing_events
                WHERE date(processed_at) BETWEEN ? AND ?
                GROUP BY date(processed_at)
                """,
                (first_day.isoformat(), today.isoformat()),
            ).fetchall()
        )
        conn.close()
    except sqlite3.Error as exc:
        raise HTTPException(
            status_code=500, detail="Unable to load document analytics."
        ) from exc

    success_rate = round((successful_rows / total_processed * 100), 1) if total_processed else 100.0
    weekly_volume = []
    for day_offset in range(7):
        processing_day = first_day + timedelta(days=day_offset)
        weekly_volume.append({
            "date": processing_day.isoformat(),
            "day": processing_day.strftime("%a"),
            "count": daily_counts.get(processing_day.isoformat(), 0),
        })

    return {
        "total_processed": total_processed,
        "success_rate": success_rate,
        "failed_count": failed_rows,
        "avg_latency": "1.2s",
        "weekly_volume": weekly_volume,
    }


@app.post("/process")
async def process_document(
    file: UploadFile = File(...),
    user: dict = Security(require_role("viewer")),
):
    file_extension = os.path.splitext(file.filename or "")[1].lower()
    if file_extension not in SUPPORTED_UPLOAD_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Upload a PDF, PNG, JPG, JPEG, TXT, CSV, XLS, or XLSX file.",
        )

    try:
        os.makedirs("uploaded_docs", exist_ok=True)
        file_location = os.path.join("uploaded_docs", file.filename or f"upload_{uuid.uuid4()}" )
        with open(file_location, "wb+") as file_object:
            shutil.copyfileobj(file.file, file_object)

        raw_text = _extract_uploaded_text(file_location, file.filename or "", file_extension)

        extracted_data = {}
        try:
            if api_key_check:
                response = client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[
                        {
                            "role": "system",
                            "content": "You are a document intelligence assistant. Extract customer_name, invoice_number, invoice_date, supplier_name, subtotal, total into a valid JSON object. Use null for fields that are not present; never guess or claim validation status.",
                        },
                        {
                            "role": "user",
                            "content": f"Extract metadata from this document text:\n{raw_text}",
                        },
                    ],
                    response_format={"type": "json_object"},
                )
                extracted_data = json.loads(response.choices[0].message.content)
            else:
                raise RuntimeError("No OpenAI API key configured")
        except Exception as openai_err:
            print(f"Warning: OpenAI extraction failed ({openai_err}), using local fallback parser.")
            from processor import extract_document_data

            extracted_data = extract_document_data(raw_text)

        extracted_data = _fill_missing_customer_name(extracted_data, raw_text)
        doc_id = str(uuid.uuid4())
        validation = validate_invoice(extracted_data)
        customer_name = extracted_data.get("customer_name")
        invoice_number = extracted_data.get("invoice_number")
        subtotal = _database_amount(extracted_data.get("subtotal"))
        total = _database_amount(extracted_data.get("total"))
        validation_status = validation["status"]
        status_val = "success" if validation_status == "VALID" else "failed"
        embedding, semantic_warning = _try_encode_document(raw_text, extracted_data)

        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                doc_id,
                customer_name,
                invoice_number,
                subtotal,
                total,
                validation_status,
                status_val,
            ),
        )
        _record_document_processing(cursor, doc_id)
        semantic_indexed = _store_document_embedding(cursor, doc_id, embedding)
        conn.commit()
        conn.close()

        return {
            "doc_id": doc_id,
            "status": validation_status,
            "total_amount": total,
            "customer_name": customer_name,
            "invoice_number": invoice_number,
            "extracted_intelligence": extracted_data,
            "validation_issues": validation["issues"],
            "semantic_search_indexed": semantic_indexed,
            "semantic_search_warning": semantic_warning,
        }

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/documents/{document_id}")
def delete_document(document_id: str, user: dict = Security(require_role("admin"))):
    """
    Deletes a document by ID. Restricted to admin users only.
    """
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM documents WHERE doc_id = ?", (document_id,))
    conn.commit()
    conn.close()

    return {"message": f"Document {document_id} deleted successfully"}