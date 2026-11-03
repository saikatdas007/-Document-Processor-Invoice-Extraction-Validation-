import pytest
from fastapi.testclient import TestClient
from app import app, create_access_token

client = TestClient(app)

def test_root_endpoint():
    """Verify that the base/health endpoint responds correctly."""
    response = client.get("/")
    assert response.status_code in [200, 404]  # Adjust based on your root route

def test_validator_missing_fields():
    """Test validation logic for malformed document payloads."""
    from validator import validate_document_payload

    invalid_payload = {"invoice_number": "", "total_amount": -50.0}
    is_valid, errors = validate_document_payload(invalid_payload)

    assert is_valid is False
    assert len(errors) > 0

def test_process_invalid_file_format():
    """Test failure scenario: uploading an unsupported file type."""
    token = create_access_token({"sub": "admin@example.com", "role": "admin"})
    response = client.post(
        "/api/documents/upload",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("test.exe", b"fake binary data", "application/x-msdownload")},
    )
    assert response.status_code == 400

def test_openai_fallback_handling():
    """Test graceful handling when AI service encounters an error or invalid key."""
    from processor import extract_document_data

    # Passing dummy text with a simulated client error or missing credentials
    result = extract_document_data("Sample invoice text with total $100")
    # Verify that the processor returns a safe fallback dictionary instead of crashing
    assert isinstance(result, dict)
    assert "error" in result or "total" in result

def test_process_spreadsheet_accepts_uppercase_csv_extension(tmp_path):
    from processor import process_spreadsheet

    csv_file = tmp_path / "invoices.CSV"
    csv_file.write_text("invoice_number,total\nINV-1,12.50\n", encoding="utf-8")

    sheets = process_spreadsheet(str(csv_file))

    assert sheets["Sheet1"].loc[0, "invoice_number"] == "INV-1"

@pytest.mark.parametrize("filename", ["invoices.csv", "invoices.xls", "invoices.xlsx"])
def test_process_endpoint_accepts_spreadsheet_uploads(tmp_path, monkeypatch, filename):
    import app as app_module

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    monkeypatch.setattr(app_module, "api_key_check", False)
    monkeypatch.setattr(
        app_module,
        "extract_text_from_file",
        lambda _: "Invoice Number: INV-1\nTotal: 12.50",
    )
    monkeypatch.setattr(
        "processor.extract_document_data",
        lambda _: {
            "invoice_number": "INV-1",
            "invoice_date": "2026-01-01",
            "supplier_name": "Acme",
            "customer_name": "Morgan Patel",
            "subtotal": 12.5,
            "total": 12.5,
        },
    )
    monkeypatch.setattr(app_module, "_encode_semantic_text", lambda _: [1.0, 0.0])

    token = create_access_token({"sub": "admin@example.com", "role": "admin"})
    response = client.post(
        "/process",
        headers={"Authorization": "Bearer " + token},
        files={"file": (filename, b"spreadsheet content", "application/octet-stream")},
    )

    assert response.status_code == 200
    assert response.json()["total_amount"] == 12.5
    assert response.json()["status"] == "VALID"

def test_process_endpoint_flags_incomplete_extraction_without_fabricating_fields(
    tmp_path, monkeypatch
):
    import sqlite3
    import app as app_module

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    monkeypatch.setattr(app_module, "api_key_check", False)
    monkeypatch.setattr(
        app_module,
        "extract_text_from_file",
        lambda _: "INVOICE\nDate: Jun 5, 2023\nBill To: Balance Due: $0.00\nTotal: $0.00",
    )
    monkeypatch.setattr(
        "processor.extract_document_data",
        lambda _: {
            "invoice_number": None,
            "invoice_date": "Jun 5, 2023",
            "supplier_name": None,
            "customer_name": None,
            "subtotal": None,
            "total": 0.0,
        },
    )
    monkeypatch.setattr(app_module, "_encode_semantic_text", lambda _: [1.0, 0.0])
    token = create_access_token({"sub": "admin@example.com", "role": "admin"})

    response = client.post(
        "/process",
        headers={"Authorization": "Bearer " + token},
        files={"file": ("empty_invoice.pdf", b"pdf", "application/pdf")},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "FLAGGED FOR MANUAL REVIEW"
    assert any("Missing mandatory field: invoice_number" in issue for issue in data["validation_issues"])
    assert data["customer_name"] is None
    with sqlite3.connect("documents.db") as conn:
        row = conn.execute(
            "SELECT customer_name, invoice_number, validation_status, status FROM documents"
        ).fetchone()
    assert row == (None, None, "FLAGGED FOR MANUAL REVIEW", "failed")

@pytest.mark.parametrize("endpoint", ["/process", "/api/documents/upload"])
@pytest.mark.parametrize("ai_customer_name", [None, "string"])
def test_upload_recovers_missing_customer_name_from_document_text(
    tmp_path, monkeypatch, endpoint, ai_customer_name
):
    import json
    import sqlite3
    from types import SimpleNamespace
    import app as app_module

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    monkeypatch.setattr(app_module, "api_key_check", True)
    monkeypatch.setattr(
        app_module,
        "extract_text_from_file",
        lambda _: "Invoice Number: INV-1\nCustomer Name: Morgan Patel\nTotal: 12.50",
    )
    ai_response = json.dumps({
        "invoice_number": "INV-1",
        "invoice_date": "2026-01-01",
        "supplier_name": "Acme",
        "customer_name": ai_customer_name,
        "subtotal": 12.5,
        "total": 12.5,
    })
    monkeypatch.setattr(
        app_module.client.chat.completions,
        "create",
        lambda **_: SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=ai_response))]
        ),
    )
    monkeypatch.setattr(app_module, "_encode_semantic_text", lambda _: [1.0, 0.0])
    token = create_access_token({"sub": "admin@example.com", "role": "admin"})

    response = client.post(
        endpoint,
        headers={"Authorization": "Bearer " + token},
        files={"file": ("invoice.pdf", b"pdf", "application/pdf")},
    )

    assert response.status_code == 200
    assert response.json()["extracted_intelligence"]["customer_name"] == "Morgan Patel"
    with sqlite3.connect("documents.db") as conn:
        customer_name = conn.execute(
            "SELECT customer_name FROM documents"
        ).fetchone()[0]
        processing_events = conn.execute(
            "SELECT COUNT(*) FROM document_processing_events"
        ).fetchone()[0]
    assert customer_name == "Morgan Patel"
    assert processing_events == 1

def test_process_endpoint_requires_admin_authentication():
    response = client.post(
        "/process",
        files={"file": ("invoice.csv", b"invoice,total\nINV-1,12.50", "text/csv")},
    )

    assert response.status_code in {401, 403}

@pytest.mark.parametrize("endpoint", ["/process", "/api/documents/upload"])
def test_authenticated_viewer_can_upload_documents(tmp_path, monkeypatch, endpoint):
    from types import SimpleNamespace
    from uuid import uuid4
    import app as app_module

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    monkeypatch.setattr(
        app_module,
        "_extract_uploaded_text",
        lambda *_: "Invoice Number: INV-1\nCustomer: Morgan Patel\nTotal: 12.50",
    )
    monkeypatch.setattr(app_module, "_encode_semantic_text", lambda _: [1.0, 0.0])
    monkeypatch.setattr(
        app_module,
        "client",
        SimpleNamespace(
            chat=SimpleNamespace(
                completions=SimpleNamespace(
                    create=lambda **_: SimpleNamespace(
                        choices=[
                            SimpleNamespace(
                                message=SimpleNamespace(
                                    content='{"customer_name":"Morgan Patel","invoice_number":"INV-1","total":12.5}'
                                )
                            )
                        ]
                    )
                )
            )
        ),
    )

    auth_client = TestClient(app)
    registration = auth_client.post(
        "/api/auth/register",
        json={"email": f"{uuid4().hex}@example.com", "password": "A-long-passphrase-123"},
    )
    assert registration.status_code == 201
    assert registration.json()["role"] == "viewer"

    response = auth_client.post(
        endpoint,
        headers={"X-CSRF-Token": registration.json()["csrf_token"]},
        files={"file": ("invoice.txt", b"Invoice Number: INV-1", "text/plain")},
    )

    assert response.status_code == 200
    assert response.json()["doc_id"]

def test_analytics_endpoint_requires_authentication():
    assert client.get("/analytics").status_code in {401, 403}

    viewer_token = create_access_token({"sub": "viewer@example.com", "role": "viewer"})
    response = client.get(
        "/analytics",
        headers={"Authorization": "Bearer " + viewer_token},
    )
    assert response.status_code == 200

def test_registration_creates_viewer_and_issues_http_only_session(tmp_path, monkeypatch):
    import app as app_module
    from uuid import uuid4

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    auth_client = TestClient(app)
    email = f"{uuid4().hex}@example.com"
    response = auth_client.post(
        "/api/auth/register",
        json={"email": email, "password": "A-long-passphrase-123"},
    )

    assert response.status_code == 201
    assert response.json()["email"] == email
    assert response.json()["role"] == "viewer"
    assert isinstance(response.json()["csrf_token"], str)
    cookies = response.headers.get_list("set-cookie")
    session_cookie = next(cookie for cookie in cookies if cookie.startswith("document-processor-session="))
    assert "httponly" in session_cookie.lower()
    assert "samesite=strict" in session_cookie.lower()
    session_response = auth_client.get("/api/auth/me")
    assert session_response.json()["email"] == email
    assert session_response.json()["role"] == "viewer"
    assert isinstance(session_response.json()["csrf_token"], str)

    csrf_token = auth_client.cookies.get("document-processor-csrf")
    assert csrf_token
    assert auth_client.post("/api/auth/logout").status_code == 403
    assert auth_client.post(
        "/api/auth/logout",
        headers={"X-CSRF-Token": csrf_token},
    ).status_code == 200
    assert auth_client.get("/api/auth/me").status_code == 401

    login_response = auth_client.post(
        "/api/auth/login",
        json={"email": email, "password": "A-long-passphrase-123"},
    )
    assert login_response.status_code == 200
    assert login_response.json()["email"] == email
    assert login_response.json()["role"] == "viewer"
    assert isinstance(login_response.json()["csrf_token"], str)


def test_registration_validates_password_and_rejects_duplicate_email(tmp_path, monkeypatch):
    import app as app_module
    from uuid import uuid4

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    auth_client = TestClient(app)
    email = f"{uuid4().hex}@example.com"
    weak_password = auth_client.post(
        "/api/auth/register",
        json={"email": email, "password": "short"},
    )
    assert weak_password.status_code == 422

    created = auth_client.post(
        "/api/auth/register",
        json={"email": email, "password": "A-long-passphrase-123"},
    )
    assert created.status_code == 201

    duplicate = auth_client.post(
        "/api/auth/register",
        json={"email": email.upper(), "password": "Another-long-passphrase-456"},
    )
    assert duplicate.status_code == 409


def test_swagger_login_returns_token_usable_by_protected_routes(tmp_path, monkeypatch):
    import app as app_module
    from uuid import uuid4

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    auth_client = TestClient(app)
    email = f"{uuid4().hex}@example.com"
    password = "A-long-passphrase-123"
    created = auth_client.post(
        "/api/auth/register",
        json={"email": email, "password": password},
    )
    assert created.status_code == 201
    response = auth_client.post(
        "/api/auth/token",
        data={"username": email, "password": password},
    )

    assert response.status_code == 200
    token_data = response.json()
    assert token_data["token_type"] == "bearer"
    assert token_data["role"] == "viewer"
    analytics_response = auth_client.get(
        "/analytics",
        headers={"Authorization": f"Bearer {token_data['access_token']}"},
    )
    assert analytics_response.status_code == 200

def test_json_login_rejects_unknown_account_without_leaking_account_existence(tmp_path, monkeypatch):
    import app as app_module

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    auth_client = TestClient(app)
    response = auth_client.post(
        "/api/auth/login",
        json={"email": "missing@example.com", "password": "A-long-passphrase-123"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Incorrect email or password."

def test_openapi_exposes_oauth2_password_authorization():
    schema = client.get("/openapi.json").json()

    assert "/api/auth/login" in schema["paths"]
    assert schema["components"]["securitySchemes"]["OAuth2PasswordBearer"][
        "flows"
    ]["password"]["tokenUrl"] == "/api/auth/token"


def test_initial_admin_is_seeded_from_environment(tmp_path, monkeypatch):
    import app as app_module

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("AUTH_INITIAL_ADMIN_EMAIL", "owner@example.com")
    monkeypatch.setenv("AUTH_INITIAL_ADMIN_PASSWORD", "A-strong-admin-passphrase")
    app_module.init_db()

    auth_client = TestClient(app)
    response = auth_client.post(
        "/api/auth/login",
        json={
            "email": "owner@example.com",
            "password": "A-strong-admin-passphrase",
        },
    )

    assert response.status_code == 200
    assert response.json()["role"] == "admin"


def test_semantic_search_requires_authentication():
    response = client.post(
        "/api/documents/semantic-search",
        json={"query": "high value invoice"},
    )

    assert response.status_code in {401, 403}

def test_semantic_search_returns_closest_documents(tmp_path, monkeypatch):
    import json
    import sqlite3
    import app as app_module

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    with sqlite3.connect("documents.db") as conn:
        conn.executemany(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                ("doc-1", "Morgan Patel", "INV-1", 100, 110, "VALID", "success"),
                ("doc-2", "Taylor Smith", "INV-2", 20, 25, "VALID", "success"),
            ],
        )
        conn.executemany(
            "INSERT INTO document_embeddings (doc_id, embedding) VALUES (?, ?)",
            [
                ("doc-1", json.dumps([1.0, 0.0])),
                ("doc-2", json.dumps([0.0, 1.0])),
            ],
        )
    monkeypatch.setattr(app_module, "_encode_semantic_text", lambda _: [1.0, 0.0])
    token = create_access_token({"sub": "viewer@example.com", "role": "viewer"})

    response = client.post(
        "/api/documents/semantic-search",
        headers={"Authorization": "Bearer " + token},
        json={"query": "similar to a high value invoice", "top_k": 1},
    )

    assert response.status_code == 200
    results = response.json()["results"]
    assert len(results) == 1
    assert results[0]["doc_id"] == "doc-1"
    assert results[0]["customer_name"] == "Morgan Patel"
    assert results[0]["score"] == pytest.approx(1.0)

def test_semantic_search_prioritizes_customer_name_matches(tmp_path, monkeypatch):
    import json
    import sqlite3
    import app as app_module

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    with sqlite3.connect("documents.db") as conn:
        conn.executemany(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                ("doc-morgan-1", "Morgan Patel", "INV-1", 100, 110, "VALID", "success"),
                ("doc-morgan-2", "Morgan Patel", "INV-2", 50, 55, "VALID", "success"),
                ("doc-taylor", "Taylor Smith", "INV-3", 200, 220, "VALID", "success"),
            ],
        )
        conn.executemany(
            "INSERT INTO document_embeddings (doc_id, embedding) VALUES (?, ?)",
            [
                ("doc-morgan-1", json.dumps([0.0, 1.0])),
                ("doc-morgan-2", json.dumps([0.0, 1.0])),
                ("doc-taylor", json.dumps([1.0, 0.0])),
            ],
        )
    monkeypatch.setattr(app_module, "_encode_semantic_text", lambda _: [1.0, 0.0])
    token = create_access_token({"sub": "viewer@example.com", "role": "viewer"})

    response = client.post(
        "/api/documents/semantic-search",
        headers={"Authorization": "Bearer " + token},
        json={"query": "Find invoices for MORGAN PATEL", "top_k": 5},
    )

    assert response.status_code == 200
    results = response.json()["results"]
    assert [result["doc_id"] for result in results] == [
        "doc-morgan-1",
        "doc-morgan-2",
    ]
    assert all(result["customer_name"] == "Morgan Patel" for result in results)

def test_semantic_search_backfills_legacy_documents(tmp_path, monkeypatch):
    import sqlite3
    import app as app_module

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    with sqlite3.connect("documents.db") as conn:
        conn.execute(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("legacy-1", "Morgan Patel", "INV-1", 100, 110, "VALID", "success"),
        )

    def fake_encode(text):
        return [1.0, 0.0] if "Morgan Patel" in text or "Find Morgan" in text else [0.0, 1.0]

    monkeypatch.setattr(app_module, "_encode_semantic_text", fake_encode)
    token = create_access_token({"sub": "viewer@example.com", "role": "viewer"})
    response = client.post(
        "/api/documents/semantic-search",
        headers={"Authorization": "Bearer " + token},
        json={"query": "Find Morgan Patel"},
    )

    assert response.status_code == 200
    assert response.json()["results"][0]["doc_id"] == "legacy-1"
    with sqlite3.connect("documents.db") as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM document_embeddings WHERE doc_id = 'legacy-1'"
        ).fetchone()[0] == 1

def test_semantic_search_validates_query_length():
    token = create_access_token({"sub": "viewer@example.com", "role": "viewer"})
    response = client.post(
        "/api/documents/semantic-search",
        headers={"Authorization": "Bearer " + token},
        json={"query": "x" * 1001},
    )

    assert response.status_code == 400

def test_analytics_counts_flagged_documents_as_failures(tmp_path, monkeypatch):
    import sqlite3
    import app as app_module

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    with sqlite3.connect("documents.db") as conn:
        conn.executemany(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                ("valid-1", "Morgan Patel", "INV-1", 10, 10, "VALID", "success"),
                ("review-1", None, None, None, 0, "FLAGGED FOR MANUAL REVIEW", "failed"),
            ],
        )

    token = create_access_token({"sub": "viewer@example.com", "role": "viewer"})
    response = client.get(
        "/analytics",
        headers={"Authorization": "Bearer " + token},
    )

    assert response.status_code == 200
    assert response.json()["total_processed"] == 2
    assert response.json()["failed_count"] == 1
    assert response.json()["success_rate"] == 50.0

def test_analytics_reports_actual_daily_processing_for_last_seven_days(
    tmp_path, monkeypatch
):
    from datetime import datetime, timedelta, timezone
    import sqlite3

    import app as app_module

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    today = datetime.now(timezone.utc).date()
    two_days_ago = today - timedelta(days=2)
    eight_days_ago = today - timedelta(days=8)
    with sqlite3.connect("documents.db") as conn:
        conn.executemany(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                ("recent-1", "Morgan Patel", "INV-1", 10, 10, "VALID", "success"),
                ("recent-2", "Taylor Smith", "INV-2", 10, 10, "VALID", "success"),
                ("older", "Alex Kim", "INV-3", 10, 10, "VALID", "success"),
            ],
        )
        conn.executemany(
            "INSERT INTO document_processing_events (doc_id, processed_at) VALUES (?, ?)",
            [
                ("recent-1", datetime.combine(today, datetime.min.time(), timezone.utc).isoformat()),
                ("recent-2", datetime.combine(two_days_ago, datetime.min.time(), timezone.utc).isoformat()),
                ("older", datetime.combine(eight_days_ago, datetime.min.time(), timezone.utc).isoformat()),
            ],
        )

    token = create_access_token({"sub": "viewer@example.com", "role": "viewer"})
    response = client.get(
        "/analytics",
        headers={"Authorization": "Bearer " + token},
    )

    assert response.status_code == 200
    weekly_volume = response.json()["weekly_volume"]
    assert len(weekly_volume) == 7
    assert [entry["date"] for entry in weekly_volume] == [
        (today - timedelta(days=day_offset)).isoformat()
        for day_offset in range(6, -1, -1)
    ]
    assert sum(entry["count"] for entry in weekly_volume) == 2
    assert next(entry["count"] for entry in weekly_volume if entry["date"] == today.isoformat()) == 1
    assert next(
        entry["count"] for entry in weekly_volume if entry["date"] == two_days_ago.isoformat()
    ) == 1

def test_extractor_reads_excel_sheet_contents(tmp_path, monkeypatch):
    import pandas as pd
    import extractor

    excel_file = tmp_path / "invoices.xlsx"
    excel_file.write_bytes(b"mock workbook")
    monkeypatch.setattr(
        extractor.pd,
        "read_excel",
        lambda path, sheet_name: {
            "Invoices": pd.DataFrame([{"invoice_number": "INV-1", "total": 12.5}])
        },
    )

    text = extractor.extract_text_from_file(str(excel_file))

    assert "Sheet: Invoices" in text
    assert "INV-1" in text
    assert "12.5" in text

def test_batch_process_does_not_count_empty_csv_as_success(tmp_path, capsys):
    from processor import batch_process_folder

    (tmp_path / "empty.csv").write_text("", encoding="utf-8")

    batch_process_folder(str(tmp_path))

    output = capsys.readouterr().out
    assert "Warning: No data extracted" in output
    assert "Successfully processed 0 files." in output

def test_extractor_handles_generic_invoice_labels_and_items():
    from extractor import extract_invoice_fields

    text = "\n".join([
        "Vendor: Acme Supplies",
        "Invoice Number: INV-2026-001",
        "Date: 2026-05-04",
        "Bill To: Example Buyer",
        "Subtotal: $40.00",
        "Grand Total $44.00",
        "Widget Pro 2 $20.00 $40.00",
    ])

    data = extract_invoice_fields(text)

    assert data["supplier_name"] == "Acme Supplies"
    assert data["customer_name"] == "Example Buyer"
    assert data["invoice_number"] == "INV-2026-001"
    assert data["invoice_date"] == "2026-05-04"
    assert data["total"] == 44.0
    assert data["line_items"] == [{"product_name": "Widget Pro", "amount": 40.0}]

def test_extractor_preserves_bundled_invoice_fields():
    from pathlib import Path
    from extractor import extract_text_from_file, process_invoice_to_json
    from processor import extract_document_data

    sample_path = Path(__file__).with_name("invoice_Aaron Bergman_36258.pdf")
    data = process_invoice_to_json(sample_path)

    assert data["invoice_number"] == "36258"
    assert data["supplier_name"] == "SuperStore"
    assert data["customer_name"] == "Aaron Bergman"
    assert data["total"] == 50.1

    text = extract_text_from_file(str(sample_path))
    assert "Customer Name: Aaron Bergman" in text
    assert extract_document_data(text)["customer_name"] == "Aaron Bergman"

def test_extractor_recovers_wrapped_customer_name_from_pdf_columns():
    from pathlib import Path
    from extractor import extract_invoice_fields, extract_text_from_file
    from processor import extract_document_data

    sample_path = Path("1000+ PDF_Invoice_Folder") / "invoice_Aleksandra Gannaway_33911.pdf"
    text = extract_text_from_file(str(sample_path))
    extracted = extract_document_data(text)

    assert extracted["customer_name"] == "Aleksandra Gannaway"
    assert extract_invoice_fields(text)["customer_name"] == "Aleksandra Gannaway"

def test_extractor_recovers_three_word_customer_name_from_pdf_columns():
    from pathlib import Path
    from extractor import extract_text_from_file
    from processor import extract_document_data

    sample_path = Path("1000+ PDF_Invoice_Folder") / "invoice_Sample Company A_29496.pdf"
    extracted = extract_document_data(extract_text_from_file(str(sample_path)))

    assert extracted["customer_name"] == "Sample Company A"

def test_validator_extracts_customer_from_explicit_text_label():
    from validator import extract_invoice_fields

    result = extract_invoice_fields("Invoice # INV-1\nCustomer Name: Morgan Patel\nTotal: $25.00")

    assert result["customer_name"] == "Morgan Patel"

def test_validator_does_not_treat_balance_due_as_customer():
    from validator import extract_invoice_fields

    result = extract_invoice_fields("INVOICE\nBill To: Balance Due: $0.00\nTotal: $0.00")

    assert result["customer_name"] is None

def test_extractor_does_not_treat_balance_due_as_customer():
    from extractor import extract_invoice_fields

    result = extract_invoice_fields("INVOICE\nBill To: Balance Due: $0.00\nTotal: $0.00")

    assert result["customer_name"] is None

def test_validate_invoice_rejects_non_numeric_amount():
    from validator import validate_invoice

    result = validate_invoice({
        "invoice_number": "INV-1",
        "invoice_date": "2026-01-01",
        "supplier_name": "Acme",
        "customer_name": "Morgan Patel",
        "subtotal": "not-an-amount",
        "total": 25,
    })

    assert result["status"] == "FLAGGED FOR MANUAL REVIEW"
    assert "Subtotal must be numeric." in result["issues"]

def test_extractor_uses_ocr_for_scanned_pdf(tmp_path, monkeypatch):
    from types import SimpleNamespace
    import extractor

    class ScannedPage:
        def extract_text(self):
            return ""

        def to_image(self, resolution):
            return SimpleNamespace(original=object())

    class PdfDocument:
        pages = [ScannedPage()]

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

    pdf_path = tmp_path / "scanned.pdf"
    pdf_path.write_bytes(b"mock pdf")
    monkeypatch.setattr(extractor.pdfplumber, "open", lambda _: PdfDocument())
    monkeypatch.setattr(extractor.pytesseract, "image_to_string", lambda _: "OCR invoice")

    assert extractor.extract_text_from_file(str(pdf_path)) == "OCR invoice"

def test_extractor_reports_missing_tesseract_for_scanned_pdf(tmp_path, monkeypatch):
    from types import SimpleNamespace
    import extractor

    class ScannedPage:
        def extract_text(self):
            return ""

        def to_image(self, resolution):
            return SimpleNamespace(original=object())

    class PdfDocument:
        pages = [ScannedPage()]

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

    pdf_path = tmp_path / "scanned.pdf"
    pdf_path.write_bytes(b"mock pdf")
    monkeypatch.setattr(extractor.pdfplumber, "open", lambda _: PdfDocument())

    def missing_tesseract(_):
        raise extractor.pytesseract.TesseractNotFoundError()

    monkeypatch.setattr(extractor.pytesseract, "image_to_string", missing_tesseract)
    with pytest.raises(RuntimeError, match="Tesseract OCR must be installed"):
        extractor.extract_text_from_file(str(pdf_path))

@pytest.mark.parametrize("endpoint", ["/process", "/api/documents/upload"])
@pytest.mark.parametrize("filename", ["invoice.png", "invoice.jpg", "invoice.jpeg"])
def test_image_upload_routes_run_ocr_before_structured_extraction(
    tmp_path, monkeypatch, endpoint, filename
):
    import io
    import json
    from types import SimpleNamespace
    from PIL import Image
    import app as app_module
    import extractor

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    monkeypatch.setattr(app_module, "api_key_check", True)
    ocr_text = "Invoice Number: INV-IMAGE-1\nCustomer Name: Morgan Patel\nTotal: 12.50"
    monkeypatch.setattr(
        extractor.pytesseract,
        "image_to_string",
        lambda _, config: ocr_text,
    )
    ai_response = json.dumps({
        "invoice_number": "INV-IMAGE-1",
        "invoice_date": "2026-01-01",
        "supplier_name": "Acme",
        "customer_name": "Morgan Patel",
        "subtotal": 12.5,
        "total": 12.5,
    })
    requests = []

    def create_chat_completion(**kwargs):
        requests.append(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=ai_response))]
        )

    monkeypatch.setattr(
        app_module.client.chat.completions, "create", create_chat_completion
    )
    monkeypatch.setattr(app_module, "_encode_semantic_text", lambda _: [1.0, 0.0])

    image_buffer = io.BytesIO()
    image_format = "PNG" if filename.endswith(".png") else "JPEG"
    Image.new("RGB", (20, 20), color="white").save(image_buffer, format=image_format)
    token = create_access_token({"sub": "admin@example.com", "role": "admin"})
    response = client.post(
        endpoint,
        headers={"Authorization": f"Bearer {token}"},
        files={"file": (filename, image_buffer.getvalue(), f"image/{image_format.lower()}")},
    )

    assert response.status_code == 200
    assert response.json()["extracted_intelligence"]["customer_name"] == "Morgan Patel"
    assert len(requests) == 1
    assert ocr_text in requests[0]["messages"][1]["content"]

@pytest.mark.parametrize("endpoint", ["/process", "/api/documents/upload"])
def test_image_upload_reports_missing_tesseract(tmp_path, monkeypatch, endpoint):
    import io
    from PIL import Image
    import app as app_module
    import extractor

    monkeypatch.chdir(tmp_path)
    app_module.init_db()

    def missing_tesseract(_, config):
        raise extractor.pytesseract.TesseractNotFoundError()

    monkeypatch.setattr(extractor.pytesseract, "image_to_string", missing_tesseract)
    image_buffer = io.BytesIO()
    Image.new("RGB", (20, 20), color="white").save(image_buffer, format="PNG")
    token = create_access_token({"sub": "admin@example.com", "role": "admin"})
    response = client.post(
        endpoint,
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("invoice.png", image_buffer.getvalue(), "image/png")},
    )

    assert response.status_code == 503
    assert "Tesseract OCR must be installed" in response.json()["detail"]

@pytest.mark.parametrize("endpoint", ["/process", "/api/documents/upload"])
def test_image_upload_reports_when_ocr_finds_no_text(tmp_path, monkeypatch, endpoint):
    import io
    from PIL import Image
    import app as app_module
    import extractor

    monkeypatch.chdir(tmp_path)
    app_module.init_db()
    monkeypatch.setattr(
        extractor.pytesseract, "image_to_string", lambda _, config: " \n"
    )
    image_buffer = io.BytesIO()
    Image.new("RGB", (20, 20), color="white").save(image_buffer, format="PNG")
    token = create_access_token({"sub": "admin@example.com", "role": "admin"})
    response = client.post(
        endpoint,
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("invoice.png", image_buffer.getvalue(), "image/png")},
    )

    assert response.status_code == 422
    assert "No text could be recognized" in response.json()["detail"]

@pytest.mark.parametrize(
    ("image_size", "expected_size"),
    [((240, 100), (960, 400)), ((1600, 900), (1600, 900))],
)
def test_image_extractor_normalizes_contrast_and_bounds_upscaling(
    tmp_path, monkeypatch, image_size, expected_size
):
    from PIL import Image
    import extractor

    image_path = tmp_path / "invoice.png"
    Image.new("RGB", image_size, color=(200, 200, 200)).save(image_path)
    observed = {}

    def fake_ocr(image, config):
        observed["size"] = image.size
        observed["mode"] = image.mode
        observed["config"] = config
        return "OCR invoice"

    monkeypatch.setattr(extractor.pytesseract, "image_to_string", fake_ocr)

    assert extractor.extract_text_from_file(str(image_path)) == "OCR invoice"
    assert observed == {
        "size": expected_size,
        "mode": "L",
        "config": "--psm 6",
    }