const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const request = require("supertest");
const XLSX = require("@e965/xlsx");
const { extractTextFromFile } = require("../src/extractor");
const { extractInvoiceFields, validateInvoice } = require("../src/validation");

let app;
let directory;
let csrfToken;
let agent;

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "document-processor-node-"));
  process.env.DATABASE_PATH = path.join(directory, "documents.db");
  process.env.UPLOAD_DIRECTORY = path.join(directory, "uploaded_docs");
  process.env.OPENAI_API_KEY = "";
  process.env.APP_ENV = "development";
  app = require("../src/app");
  await app.locals.initPromise;
  app.locals.encodeSemanticText = async () => [1, 0];
  agent = request.agent(app);
});

after(() => {
  app?.locals.database.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test("health endpoint reports API status", async () => {
  const response = await request(app).get("/");
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
});

test("OpenAPI and Swagger UI remain available", async () => {
  const schemaResponse = await request(app).get("/openapi.json");
  assert.equal(schemaResponse.status, 200);
  assert.equal(
    schemaResponse.body.components.securitySchemes.OAuth2PasswordBearer.flows.password.tokenUrl,
    "/api/auth/token",
  );
  assert.equal((await request(app).get("/docs/")).status, 200);
});

test("local parser extracts labeled invoice fields and validation flags missing values", () => {
  const extracted = extractInvoiceFields(
    "ACME Supplies\nInvoice Number: INV-42\nInvoice Date: Jan 3, 2025\nBill To: Jordan Lee\nSubtotal: $100.00\nTotal: $110.00",
  );
  assert.equal(extracted.invoice_number, "INV-42");
  assert.equal(extracted.customer_name, "Jordan Lee");
  assert.equal(extracted.subtotal, 100);
  assert.equal(extracted.total, 110);
  assert.equal(validateInvoice(extracted).status, "VALID");
  assert.equal(validateInvoice({ total: null }).status, "FLAGGED FOR MANUAL REVIEW");
});

test("workbook extraction reads all worksheets", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["invoice_number", "total"], ["INV-8", 80]]),
    "Invoices",
  );
  const filePath = path.join(directory, "workbook.xlsx");
  fs.writeFileSync(filePath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));

  const text = await extractTextFromFile(filePath, "workbook.xlsx");
  assert.match(text, /Sheet: Invoices/);
  assert.match(text, /INV-8/);
});

test("PDF.js extracts text from an included invoice PDF", async () => {
  const filePath = path.resolve(__dirname, "../../invoice_Aaron Bergman_36258.pdf");
  const text = await extractTextFromFile(filePath, path.basename(filePath));
  assert.match(text, /Invoice/i);
});

test("registration creates a viewer session, supports protected upload, and enforces CSRF", async () => {
  const email = `viewer-${Date.now()}@example.com`;
  const registration = await agent
    .post("/api/auth/register")
    .send({ email, password: "A-long-passphrase-123" });
  assert.equal(registration.status, 201);
  assert.equal(registration.body.role, "viewer");
  assert.match(registration.headers["set-cookie"].join(";"), /document-processor-session=.*httponly/i);
  csrfToken = registration.body.csrf_token;

  const currentUser = await agent.get("/api/auth/me");
  assert.equal(currentUser.status, 200);
  assert.equal(currentUser.body.email, email);

  const rejectedUpload = await agent
    .post("/process")
    .attach("file", Buffer.from("Invoice Number: INV-1\nTotal: 12.50"), "invoice.txt");
  assert.equal(rejectedUpload.status, 403);

  const uploadResponse = await agent
    .post("/process")
    .set("X-CSRF-Token", csrfToken)
    .attach("file", Buffer.from("Invoice Number: INV-1\nTotal: 12.50"), "invoice.txt");
  assert.equal(uploadResponse.status, 200);
  assert.equal(uploadResponse.body.total_amount, 12.5);
  assert.equal(uploadResponse.body.semantic_search_indexed, true);

  const apiUpload = await agent
    .post("/api/documents/upload")
    .set("X-CSRF-Token", csrfToken)
    .attach("file", Buffer.from("Invoice Number: INV-2\nTotal: 20.00"), "invoice.txt");
  assert.equal(apiUpload.status, 200);
  assert.equal(apiUpload.body.extracted_intelligence.invoice_number, "INV-2");

  const documents = await agent.get("/api/documents/search");
  assert.equal(documents.status, 200);
  assert.equal(documents.body.results.length, 2);
  assert.equal(documents.body.results[0].structured_data.invoice_number, "INV-1");

  const forbiddenDelete = await agent.delete(`/api/documents/${uploadResponse.body.doc_id}`);
  assert.equal(forbiddenDelete.status, 403);

  const logout = await agent.post("/api/auth/logout").set("X-CSRF-Token", csrfToken);
  assert.equal(logout.status, 200);
  assert.equal((await agent.get("/api/auth/me")).status, 401);
});

test("semantic search prioritizes exact customer-name matches for bearer-authenticated users", async () => {
  const database = app.locals.database;
  database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "semantic-morgan", "Morgan Patel", "INV-M", 100, 110, "VALID", "success",
  );
  database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "semantic-taylor", "Taylor Smith", "INV-T", 20, 25, "VALID", "success",
  );
  const insertEmbedding = database.prepare(
    "INSERT INTO document_embeddings (doc_id, embedding) VALUES (?, ?)",
  );
  insertEmbedding.run("semantic-morgan", JSON.stringify([0, 1]));
  insertEmbedding.run("semantic-taylor", JSON.stringify([1, 0]));
  const token = app.locals.createAccessToken({ sub: "viewer@example.com", role: "viewer" });

  const response = await request(app)
    .post("/api/documents/semantic-search")
    .set("Authorization", `Bearer ${token}`)
    .send({ query: "Morgan Patel", top_k: 5 });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.results.map((result) => result.doc_id), ["semantic-morgan"]);
});

test("administrator bearer tokens can correct and delete documents", async () => {
  const database = app.locals.database;
  database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "admin-document", "Before", "INV-A", 10, 12, "FLAGGED FOR MANUAL REVIEW", "failed",
  );
  const token = app.locals.createAccessToken({ sub: "admin@example.com", role: "admin" });
  const headers = { Authorization: `Bearer ${token}` };

  const correction = await request(app)
    .put("/api/documents/admin-document/correct")
    .set(headers)
    .send({ customer_name: "After", subtotal: 10, total: 12 });
  assert.equal(correction.status, 200);
  assert.equal(database.prepare("SELECT validation_status FROM documents WHERE doc_id = ?")
    .get("admin-document").validation_status, "VALID");

  const deletion = await request(app)
    .delete("/api/documents/admin-document")
    .set(headers);
  assert.equal(deletion.status, 200);
  assert.equal(database.prepare("SELECT 1 FROM documents WHERE doc_id = ?").get("admin-document"), undefined);
});

test("login rejects unknown users without disclosing account existence", async () => {
  const response = await request(app)
    .post("/api/auth/login")
    .send({ email: "missing@example.com", password: "A-long-passphrase-123" });
  assert.equal(response.status, 401);
  assert.equal(response.body.detail, "Incorrect email or password.");
});

test("bearer token endpoint accepts email-based JSON credentials", async () => {
  const email = `token-${Date.now()}@example.com`;
  await request(app)
    .post("/api/auth/register")
    .send({ email, password: "A-long-passphrase-123" });

  const response = await request(app)
    .post("/api/auth/token")
    .send({ email, password: "A-long-passphrase-123" });

  assert.equal(response.status, 200);
  assert.equal(response.body.token_type, "bearer");
  assert.equal(response.body.role, "viewer");
  assert.match(response.body.access_token, /^[A-Za-z0-9\-_.]+$/);
});

test("unsupported upload extensions return a client error", async () => {
  const client = request.agent(app);
  const registration = await client
    .post("/api/auth/register")
    .send({ email: `upload-${Date.now()}@example.com`, password: "A-long-passphrase-123" });
  const csrf = registration.body.csrf_token;
  const rejected = await client
    .post("/api/documents/upload")
    .set("X-CSRF-Token", csrf)
    .attach("file", Buffer.from("not an invoice"), "invoice.exe");
  assert.equal(rejected.status, 400);
});
