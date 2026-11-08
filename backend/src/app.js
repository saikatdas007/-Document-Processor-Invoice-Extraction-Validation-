const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const argon2 = require("argon2");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const express = require("express");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const OpenAI = require("openai");
const swaggerUi = require("swagger-ui-express");
const { db, initDatabase, normalizeEmail, validateNewPassword } = require("./database");
const { encodeSemanticText, extractInvoiceFields, extractTextFromFile } = require("./extractor");
const {
  deleteVector,
  isQdrantConfigured,
  migrateStoredEmbeddings,
  retryPendingVectors,
  searchVectors,
  upsertVector,
  upsertVectors,
} = require("./vector-store");
const { extractDocumentData, validateInvoice } = require("./validation");

const PORT = Number(process.env.PORT || 8000);
const APP_ENV = (process.env.APP_ENV || "development").trim().toLowerCase();
const IS_PRODUCTION = APP_ENV === "production";
const configuredSecret = (process.env.AUTH_SECRET_KEY || "").trim();
if (configuredSecret && configuredSecret.length < 32) {
  throw new Error("AUTH_SECRET_KEY must contain at least 32 characters.");
}
if (IS_PRODUCTION && !configuredSecret) {
  throw new Error("AUTH_SECRET_KEY must be configured in production.");
}
const SECRET_KEY = configuredSecret || crypto.randomBytes(48).toString("base64url");
if (!configuredSecret) {
  console.warn("WARNING: Using an ephemeral development auth key; sessions will expire when the API restarts.");
}

const configuredOrigins = (process.env.FRONTEND_ORIGINS || "").trim();
if (IS_PRODUCTION && !configuredOrigins) {
  throw new Error("FRONTEND_ORIGINS must be configured in production.");
}
const allowedOrigins = configuredOrigins
  ? configuredOrigins.split(",").map((origin) => origin.trim()).filter(Boolean)
  : [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
    ];

const SESSION_COOKIE_NAME = "document-processor-session";
const CSRF_COOKIE_NAME = "document-processor-csrf";
const ACCESS_TOKEN_EXPIRE_MINUTES = 15;
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_ATTEMPT_WINDOW_SECONDS = 15 * 60;
const UPLOAD_DIRECTORY = path.resolve(
  process.env.UPLOAD_DIRECTORY || path.resolve(__dirname, "../../uploaded_docs"),
);
const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  ".pdf",
  ".txt",
  ".csv",
  ".xls",
  ".xlsx",
  ".png",
  ".jpg",
  ".jpeg",
]);
const IMAGE_UPLOAD_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const initPromise = initDatabase().then(async () => {
  if (isQdrantConfigured()) await migrateStoredEmbeddings(db);
});

const app = express();
app.set("trust proxy", IS_PRODUCTION ? 1 : false);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "X-CSRF-Token"],
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(async (_req, _res, next) => {
  try {
    await initPromise;
    next();
  } catch (error) {
    next(error);
  }
});

function createAccessToken(data, expiresIn = `${ACCESS_TOKEN_EXPIRE_MINUTES}m`) {
  return jwt.sign(data, SECRET_KEY, { algorithm: "HS256", expiresIn });
}

function validateOrigin(req) {
  const origin = req.get("origin");
  if (origin && !allowedOrigins.includes(origin)) {
    const error = new Error("Request origin is not allowed.");
    error.status = 403;
    throw error;
  }
}

function validateCsrf(req) {
  validateOrigin(req);
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const csrfCookie = req.cookies[CSRF_COOKIE_NAME];
  const csrfHeader = req.get("X-CSRF-Token");
  if (
    !csrfCookie ||
    !csrfHeader ||
    csrfCookie.length !== csrfHeader.length ||
    !crypto.timingSafeEqual(Buffer.from(csrfCookie), Buffer.from(csrfHeader))
  ) {
    const error = new Error("CSRF validation failed.");
    error.status = 403;
    throw error;
  }
}

function issueSession(res, email, role) {
  const token = createAccessToken({ sub: email, role });
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  const cookieOptions = {
    maxAge: ACCESS_TOKEN_EXPIRE_MINUTES * 60 * 1000,
    secure: IS_PRODUCTION,
    sameSite: "strict",
    path: "/",
  };
  res.cookie(SESSION_COOKIE_NAME, token, { ...cookieOptions, httpOnly: true });
  res.cookie(CSRF_COOKIE_NAME, csrfToken, { ...cookieOptions, httpOnly: false });
  return csrfToken;
}

function authAttemptKey(scope, value) {
  return `${scope}:${value}`;
}

function isAuthRateLimited(keys) {
  const now = Date.now() / 1000;
  const select = db.prepare("SELECT attempts, window_started_at FROM auth_attempts WHERE attempt_key = ?");
  return keys.some((key) => {
    const row = select.get(key);
    return row &&
      now - row.window_started_at < AUTH_ATTEMPT_WINDOW_SECONDS &&
      row.attempts >= MAX_AUTH_ATTEMPTS;
  });
}

function recordAuthFailure(keys) {
  const now = Date.now() / 1000;
  const upsert = db.prepare(`
    INSERT INTO auth_attempts (attempt_key, attempts, window_started_at)
    VALUES (?, 1, ?)
    ON CONFLICT(attempt_key) DO UPDATE SET
      attempts = CASE
        WHEN excluded.window_started_at - auth_attempts.window_started_at >= ? THEN 1
        ELSE auth_attempts.attempts + 1
      END,
      window_started_at = CASE
        WHEN excluded.window_started_at - auth_attempts.window_started_at >= ?
        THEN excluded.window_started_at ELSE auth_attempts.window_started_at
      END
  `);
  const record = db.transaction(() => {
    db.prepare("DELETE FROM auth_attempts WHERE window_started_at < ?")
      .run(now - AUTH_ATTEMPT_WINDOW_SECONDS);
    for (const key of keys) {
      upsert.run(key, now, AUTH_ATTEMPT_WINDOW_SECONDS, AUTH_ATTEMPT_WINDOW_SECONDS);
    }
  });
  record();
}

function clearAuthFailures(keys) {
  const remove = db.prepare("DELETE FROM auth_attempts WHERE attempt_key = ?");
  const clear = db.transaction(() => keys.forEach((key) => remove.run(key)));
  clear();
}

const dummyPasswordHash = argon2.hash(crypto.randomBytes(32).toString("hex"), {
  type: argon2.argon2id,
});

async function authenticateUser(email, password, req) {
  const normalizedEmail = normalizeEmail(email);
  const keys = [
    authAttemptKey("login-ip", req.ip || req.socket.remoteAddress || "unknown"),
    authAttemptKey("login-email", normalizedEmail),
  ];
  if (isAuthRateLimited(keys)) {
    const error = new Error("Too many sign-in attempts. Try again in 15 minutes.");
    error.status = 429;
    throw error;
  }
  const user = db.prepare(
    "SELECT email, password_hash, role, is_active FROM users WHERE email = ?",
  ).get(normalizedEmail);
  const hash = user?.password_hash || await dummyPasswordHash;
  let passwordValid = false;
  try {
    passwordValid = await argon2.verify(hash, password);
  } catch {
    passwordValid = false;
  }
  if (!passwordValid || !user || !user.is_active) {
    recordAuthFailure(keys);
    const error = new Error("Incorrect email or password.");
    error.status = 401;
    throw error;
  }
  clearAuthFailures(keys);
  return user;
}

function requireRole(requiredRole) {
  return (req, _res, next) => {
    try {
      validateOrigin(req);
      const bearer = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (req.cookies[SESSION_COOKIE_NAME] && !bearer) validateCsrf(req);
      const token = bearer || req.cookies[SESSION_COOKIE_NAME];
      if (!token) {
        const error = new Error("Authentication is required.");
        error.status = 401;
        throw error;
      }

      const payload = jwt.verify(token, SECRET_KEY, { algorithms: ["HS256"] });
      if (
        typeof payload.sub !== "string" ||
        typeof payload.role !== "string" ||
        !["admin", "viewer"].includes(payload.role)
      ) {
        const error = new Error("Invalid authentication credentials");
        error.status = 401;
        throw error;
      }
      if (payload.role !== "admin" && payload.role !== requiredRole) {
        const error = new Error("Operation not permitted for your role");
        error.status = 403;
        throw error;
      }
      req.user = { username: payload.sub, role: payload.role };
      next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
        error.status = 401;
        error.message = "Could not validate credentials";
      }
      next(error);
    }
  };
}

function createCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function fillMissingCustomerName(extractedData, rawText) {
  const missingValues = new Set([
    "",
    "n/a",
    "na",
    "none",
    "not provided",
    "null",
    "string",
    "unknown",
    "unknown customer",
  ]);
  if (
    typeof extractedData.customer_name !== "string" ||
    missingValues.has(extractedData.customer_name.trim().toLowerCase())
  ) {
    const localName = extractInvoiceFields(rawText).customer_name;
    if (localName) extractedData.customer_name = localName;
  }
  return extractedData;
}

function documentSearchText(rawText, extractedData) {
  const fields = ["customer_name", "invoice_number", "invoice_date", "supplier_name", "subtotal", "total"];
  const summary = fields
    .filter((field) => extractedData[field] !== null && extractedData[field] !== undefined)
    .map((field) => `${field.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}: ${extractedData[field]}`)
    .join("\n");
  return `${rawText}\n${summary}`.trim();
}

function databaseAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function customerNameMatchesQuery(customerName, query) {
  if (!customerName) return false;
  const normalize = (value) => value.toLowerCase().replace(/[^\w]+/g, " ").trim().replace(/\s+/g, " ");
  const normalizedName = normalize(customerName);
  const normalizedQuery = normalize(query);
  return Boolean(
    normalizedName &&
    normalizedQuery &&
    (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName)),
  );
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

const storage = multer.diskStorage({
  destination(_req, _file, callback) {
    fs.mkdirSync(UPLOAD_DIRECTORY, { recursive: true });
    callback(null, UPLOAD_DIRECTORY);
  },
  filename(_req, file, callback) {
    callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  },
});
const upload = multer({ storage });

async function extractUploadedText(filePath, filename, extension) {
  try {
    const text = await extractTextFromFile(filePath, filename);
    if (IMAGE_UPLOAD_EXTENSIONS.has(extension) && !text.trim()) {
      const error = new Error("No text could be recognized in the uploaded image.");
      error.status = 422;
      throw error;
    }
    return text.trim() ? text : `Document filename: ${filename}`;
  } catch (error) {
    if (IMAGE_UPLOAD_EXTENSIONS.has(extension) || error.status === 503) throw error;
    console.warn(`Warning: Text extraction failed for ${filename}: ${error.message}`);
    return `Document filename: ${filename}`;
  }
}

async function extractStructuredData(rawText) {
  if (openai) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a document intelligence assistant. Extract customer_name, invoice_number, invoice_date, supplier_name, subtotal, total into a valid JSON object. Use null for fields that are not present; never guess or claim validation status.",
          },
          {
            role: "user",
            content: `Extract metadata from this document text:\n${rawText}`,
          },
        ],
        response_format: { type: "json_object" },
      });
      const data = JSON.parse(response.choices[0].message.content);
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
      throw new Error("The extraction service returned an invalid object.");
    } catch (error) {
      console.warn(`Warning: OpenAI extraction failed; using local extraction. ${error.message}`);
    }
  }
  return extractDocumentData(rawText);
}

async function handleDocumentUpload(req, res, responseShape) {
  if (!req.file) {
    const error = new Error("File is required.");
    error.status = 422;
    throw error;
  }
  const filename = req.file.originalname || "";
  const extension = path.extname(filename).toLowerCase();
  if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) {
    const error = new Error(
      `Unsupported file type. Upload a PDF, ${responseShape === "process" ? "PNG, JPG, JPEG, " : ""}TXT, CSV, XLS, XLSX${responseShape === "upload" ? ", PNG, JPG, or JPEG" : ""} file.`,
    );
    error.status = 400;
    throw error;
  }

  const rawText = await extractUploadedText(req.file.path, filename, extension);
  const extractedData = fillMissingCustomerName(await extractStructuredData(rawText), rawText);
  const docId = crypto.randomUUID();
  const validation = validateInvoice(extractedData);
  const validationStatus = validation.status;
  const status = validationStatus === "VALID" ? "success" : "failed";
  let embedding = null;
  let semanticWarning = null;
  try {
    embedding = await app.locals.encodeSemanticText(documentSearchText(rawText, extractedData));
  } catch (error) {
    console.warn(`Semantic indexing failed for an uploaded document: ${error.message}`);
    semanticWarning = "Document processed, but could not be added to semantic search.";
  }

  const save = db.transaction(() => {
    db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      docId,
      extractedData.customer_name ?? null,
      extractedData.invoice_number ?? null,
      databaseAmount(extractedData.subtotal),
      databaseAmount(extractedData.total),
      validationStatus,
      status,
    );
    db.prepare("INSERT INTO document_processing_events (doc_id, processed_at) VALUES (?, ?)")
      .run(docId, new Date().toISOString().slice(0, 19) + "Z");
    if (embedding) {
      db.prepare("INSERT OR REPLACE INTO document_embeddings (doc_id, embedding) VALUES (?, ?)")
        .run(docId, JSON.stringify(embedding));
    }
  });
  save();

  if (embedding && isQdrantConfigured()) {
    try {
      await upsertVector(docId, embedding);
    } catch (error) {
      console.warn(`Qdrant indexing failed for an uploaded document: ${error.message}`);
      semanticWarning = "Document processed, but could not be added to semantic search.";
    }
  }

  if (responseShape === "process") {
    return res.json({
      doc_id: docId,
      status: validationStatus,
      total_amount: databaseAmount(extractedData.total),
      customer_name: extractedData.customer_name ?? null,
      invoice_number: extractedData.invoice_number ?? null,
      extracted_intelligence: extractedData,
      validation_issues: validation.issues,
      semantic_search_indexed: Boolean(embedding),
      semantic_search_warning: semanticWarning,
    });
  }
  return res.json({
    doc_id: docId,
    status: validationStatus,
    validation_issues: validation.issues,
    extracted_intelligence: extractedData,
    semantic_search_indexed: Boolean(embedding),
    semantic_search_warning: semanticWarning,
  });
}

app.post("/api/auth/register", async (req, res, next) => {
  try {
    validateOrigin(req);
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string" || password.length < 1 || password.length > 128) {
      const error = new Error("Invalid account credentials.");
      error.status = 422;
      throw error;
    }
    const normalizedEmail = normalizeEmail(email);
    validateNewPassword(password);
    const key = authAttemptKey("register-ip", req.ip || req.socket.remoteAddress || "unknown");
    if (isAuthRateLimited([key])) {
      const error = new Error("Too many account creation attempts. Try again in 15 minutes.");
      error.status = 429;
      throw error;
    }
    recordAuthFailure([key]);
    try {
      db.prepare(`
        INSERT INTO users (email, password_hash, role, created_at)
        VALUES (?, ?, 'viewer', ?)
      `).run(
        normalizedEmail,
        await argon2.hash(password, { type: argon2.argon2id, timeCost: 2, memoryCost: 19456, parallelism: 1 }),
        new Date().toISOString().slice(0, 19) + "Z",
      );
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        const conflict = new Error("An account with this email already exists.");
        conflict.status = 409;
        throw conflict;
      }
      throw error;
    }
    const csrfToken = issueSession(res, normalizedEmail, "viewer");
    res.status(201).json({ email: normalizedEmail, role: "viewer", csrf_token: csrfToken });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    validateOrigin(req);
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string" || password.length < 1 || password.length > 128) {
      const error = new Error("Invalid account credentials.");
      error.status = 422;
      throw error;
    }
    const user = await authenticateUser(email, password, req);
    const csrfToken = issueSession(res, user.email, user.role);
    res.json({ email: user.email, role: user.role, csrf_token: csrfToken });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", (req, res, next) => {
  try {
    validateCsrf(req);
    const cookieOptions = {
      secure: IS_PRODUCTION,
      sameSite: "strict",
      path: "/",
    };
    res.clearCookie(SESSION_COOKIE_NAME, { ...cookieOptions, httpOnly: true });
    res.clearCookie(CSRF_COOKIE_NAME, { ...cookieOptions, httpOnly: false });
    res.set("Cache-Control", "no-store").json({ message: "Signed out." });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", requireRole("viewer"), (req, res) => {
  let csrfToken = req.cookies[CSRF_COOKIE_NAME];
  if (!csrfToken) {
    csrfToken = createCsrfToken();
    res.cookie(CSRF_COOKIE_NAME, csrfToken, {
      maxAge: ACCESS_TOKEN_EXPIRE_MINUTES * 60 * 1000,
      httpOnly: false,
      secure: IS_PRODUCTION,
      sameSite: "strict",
      path: "/",
    });
  }
  res.set("Cache-Control", "no-store").json({
    email: req.user.username,
    role: req.user.role,
    csrf_token: csrfToken,
  });
});

app.post("/api/auth/token", async (req, res, next) => {
  try {
    validateOrigin(req);

    const rawUsername = typeof req.body?.username === "string" ? req.body.username : req.body?.email;
    const rawPassword = req.body?.password;
    if (typeof rawUsername !== "string" || typeof rawPassword !== "string") {
      const error = new Error("Invalid account credentials.");
      error.status = 422;
      throw error;
    }

    const user = await authenticateUser(rawUsername, rawPassword, req);
    res.json({
      access_token: createAccessToken({ sub: user.email, role: user.role }),
      token_type: "bearer",
      role: user.role,
      expires_in: ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/documents/search", requireRole("viewer"), (req, res) => {
  const rows = req.query.customer
    ? db.prepare("SELECT * FROM documents WHERE customer_name LIKE ?")
      .all(`%${req.query.customer}%`)
    : db.prepare("SELECT * FROM documents").all();
  res.json({
    results: rows.map((row) => ({
      doc_id: row.doc_id,
      structured_data: {
        customer_name: row.customer_name,
        invoice_number: row.invoice_number,
        subtotal: row.subtotal,
        total: row.total,
      },
      validation_status: row.validation_status,
      status: row.status,
    })),
  });
});

app.post("/api/documents/semantic-search", requireRole("viewer"), async (req, res, next) => {
  try {
    const { query, top_k: topK = 5 } = req.body || {};
    if (typeof query !== "string" || !query.trim()) {
      const error = new Error("A non-empty search query is required.");
      error.status = 400;
      throw error;
    }
    if (query.length > 1000) {
      const error = new Error("Search queries must be 1000 characters or fewer.");
      error.status = 400;
      throw error;
    }
    if (!Number.isInteger(topK) || topK < 1 || topK > 20) {
      const error = new Error("top_k must be an integer from 1 to 20.");
      error.status = 400;
      throw error;
    }

    let queryVector;
    try {
      queryVector = await app.locals.encodeSemanticText(query);
    } catch (cause) {
      const error = new Error("Semantic search is unavailable. Check that the local embedding model is installed and available.");
      error.status = 503;
      error.cause = cause;
      throw error;
    }

    const missing = db.prepare(`
      SELECT d.doc_id, d.customer_name, d.invoice_number, d.subtotal, d.total,
             d.validation_status, d.status
      FROM documents AS d
      LEFT JOIN document_embeddings AS e ON e.doc_id = d.doc_id
      WHERE e.doc_id IS NULL
    `).all();
    if (missing.length) {
      const encodedRows = [];
      for (const document of missing) {
        const searchableText = Object.entries(document)
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([field, value]) => `${field.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}: ${value}`)
          .join("\n");
        if (searchableText) {
          encodedRows.push([document.doc_id, JSON.stringify(await app.locals.encodeSemanticText(searchableText))]);
        }
      }
      db.transaction(() => {
        const insert = db.prepare("INSERT INTO document_embeddings (doc_id, embedding) VALUES (?, ?)");
        for (const row of encodedRows) insert.run(...row);
      })();
      if (isQdrantConfigured()) {
        try {
          await upsertVectors(encodedRows.map(([docId, embedding]) => ({
            docId,
            vector: JSON.parse(embedding),
          })));
        } catch (cause) {
          const error = new Error("Semantic search is unavailable because Qdrant indexing failed.");
          error.status = 503;
          error.cause = cause;
          throw error;
        }
      }
    }

    const queryNorm = Math.sqrt(queryVector.reduce((sum, value) => sum + value * value, 0));
    if (!queryNorm) {
      const error = new Error("The search model returned an empty query vector.");
      error.status = 503;
      throw error;
    }
    if (isQdrantConfigured()) {
      try {
        await retryPendingVectors(db);
      } catch (cause) {
        const error = new Error("Semantic search is unavailable because Qdrant indexing could not be completed.");
        error.status = 503;
        error.cause = cause;
        throw error;
      }
    }
    let scored;
    let qdrantHits;
    try {
      qdrantHits = await searchVectors(queryVector, Math.max(topK, 20));
    } catch (cause) {
      const error = new Error("Semantic search is unavailable. Check Qdrant configuration and connectivity.");
      error.status = 503;
      error.cause = cause;
      throw error;
    }
    if (qdrantHits) {
      const rows = db.prepare(`
        SELECT doc_id, customer_name, invoice_number, subtotal, total, validation_status, status
        FROM documents
      `).all();
      const rowsById = new Map(rows.map((row) => [row.doc_id, row]));
      scored = qdrantHits
        .map((hit) => {
          const row = rowsById.get(hit.doc_id);
          if (!row) return null;
          return {
            nameMatch: customerNameMatchesQuery(row.customer_name, query),
            result: {
              doc_id: row.doc_id,
              score: hit.score,
              customer_name: row.customer_name,
              invoice_number: row.invoice_number,
              subtotal: row.subtotal,
              total: row.total,
              validation_status: row.validation_status,
              status: row.status,
            },
          };
        })
        .filter(Boolean);
    } else {
      const rows = db.prepare(`
        SELECT d.doc_id, d.customer_name, d.invoice_number, d.subtotal, d.total,
               d.validation_status, d.status, e.embedding
        FROM documents AS d
        JOIN document_embeddings AS e ON e.doc_id = d.doc_id
      `).all();
      scored = rows.map((row) => {
        let documentVector;
        try {
          documentVector = JSON.parse(row.embedding);
          if (!Array.isArray(documentVector) || documentVector.length !== queryVector.length) {
            throw new Error("dimension mismatch");
          }
        } catch {
          const error = new Error("A stored document embedding is invalid.");
          error.status = 500;
          throw error;
        }
        const documentNorm = Math.sqrt(documentVector.reduce((sum, value) => sum + value * value, 0));
        const score = documentNorm
          ? queryVector.reduce((sum, value, index) => sum + value * documentVector[index], 0) / (queryNorm * documentNorm)
          : 0;
        return {
          nameMatch: customerNameMatchesQuery(row.customer_name, query),
          result: {
            doc_id: row.doc_id,
            score,
            customer_name: row.customer_name,
            invoice_number: row.invoice_number,
            subtotal: row.subtotal,
            total: row.total,
            validation_status: row.validation_status,
            status: row.status,
          },
        };
      });
    }
    scored.sort((left, right) => Number(right.nameMatch) - Number(left.nameMatch) || right.result.score - left.result.score);
    const customerMatches = scored.filter((item) => item.nameMatch);
    const results = (customerMatches.length ? customerMatches : scored)
      .slice(0, topK)
      .map((item) => item.result);
    res.json({ query: query.trim(), results });
  } catch (error) {
    next(error);
  }
});

app.post("/api/documents/upload", requireRole("viewer"), upload.single("file"), (req, res, next) => {
  handleDocumentUpload(req, res, "upload").catch(next);
});

app.put("/api/documents/:doc_id/correct", requireRole("admin"), (req, res) => {
  const { customer_name: customerName, subtotal, total } = req.body || {};
  db.prepare(`
    UPDATE documents SET customer_name = COALESCE(?, customer_name),
      subtotal = COALESCE(?, subtotal), total = COALESCE(?, total),
      validation_status = 'VALID' WHERE doc_id = ?
  `).run(customerName ?? null, subtotal ?? null, total ?? null, req.params.doc_id);
  res.json({ status: "success", message: `Corrected by ${req.user.username}` });
});

app.get("/api/documents/export-csv", requireRole("viewer"), (_req, res) => {
  const rows = db.prepare("SELECT * FROM documents").all();
  const lines = [[
    "Document ID",
    "Customer Name",
    "Invoice Number",
    "Subtotal",
    "Total",
    "Validation Status",
  ]];
  for (const row of rows) {
    lines.push([
      row.doc_id,
      row.customer_name || "N/A",
      row.invoice_number || "N/A",
      row.subtotal || 0,
      row.total || 0,
      row.validation_status || "UNKNOWN",
    ]);
  }
  res.set("Content-Disposition", "attachment;filename=document_report.csv");
  res.type("text/csv").send(lines.map((line) => line.map(csvCell).join(",")).join("\r\n"));
});

app.get("/api/documents/analytics", requireRole("viewer"), (_req, res) => {
  res.json([
    { date: "Mon", processed: 4 },
    { date: "Tue", processed: 7 },
    { date: "Wed", processed: 3 },
    { date: "Thu", processed: 12 },
    { date: "Fri", processed: 9 },
    { date: "Sat", processed: 5 },
    { date: "Sun", processed: 8 },
  ]);
});

app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Document Processor API is running" });
});

app.get("/analytics", requireRole("viewer"), (_req, res, next) => {
  try {
    const today = new Date();
    const todayString = today.toISOString().slice(0, 10);
    const firstDayDate = new Date(today);
    firstDayDate.setUTCDate(firstDayDate.getUTCDate() - 6);
    const firstDay = firstDayDate.toISOString().slice(0, 10);
    const totalProcessed = db.prepare("SELECT COUNT(*) AS count FROM documents").get().count;
    const successful = db.prepare(`
      SELECT COUNT(*) AS count FROM documents
      WHERE status = 'success' AND validation_status = 'VALID'
    `).get().count;
    const dailyRows = db.prepare(`
      SELECT date(processed_at) AS processing_day, COUNT(*) AS count
      FROM document_processing_events
      WHERE date(processed_at) BETWEEN ? AND ?
      GROUP BY date(processed_at)
    `).all(firstDay, todayString);
    const dailyCounts = new Map(dailyRows.map((row) => [row.processing_day, row.count]));
    const weeklyVolume = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const processingDay = new Date(firstDayDate);
      processingDay.setUTCDate(processingDay.getUTCDate() + offset);
      const date = processingDay.toISOString().slice(0, 10);
      weeklyVolume.push({
        date,
        day: processingDay.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
        count: dailyCounts.get(date) || 0,
      });
    }
    res.json({
      total_processed: totalProcessed,
      success_rate: totalProcessed ? Math.round((successful / totalProcessed * 100) * 10) / 10 : 100,
      failed_count: Math.max(totalProcessed - successful, 0),
      avg_latency: "1.2s",
      weekly_volume: weeklyVolume,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/process", requireRole("viewer"), upload.single("file"), (req, res, next) => {
  handleDocumentUpload(req, res, "process").catch(next);
});

app.delete("/api/documents/:document_id", requireRole("admin"), async (req, res, next) => {
  try {
    await deleteVector(req.params.document_id);
    db.prepare("DELETE FROM documents WHERE doc_id = ?").run(req.params.document_id);
    res.json({ message: `Document ${req.params.document_id} deleted successfully` });
  } catch (error) {
    next(error);
  }
});

const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Document Processor API",
    version: "1.0.0",
    description: "Invoice extraction, validation, search, and analytics API.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      OAuth2PasswordBearer: {
        type: "oauth2",
        flows: {
          password: {
            tokenUrl: "/api/auth/token",
            scopes: {},
          },
        },
      },
      SessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: SESSION_COOKIE_NAME,
      },
    },
  },
  paths: {
    "/": { get: { summary: "Health check", responses: { 200: { description: "API is running." } } } },
    "/api/auth/register": { post: { summary: "Create a viewer account", responses: { 201: { description: "Account created." } } } },
    "/api/auth/login": { post: { summary: "Sign in with email and password", responses: { 200: { description: "Session created." } } } },
    "/api/auth/logout": { post: { summary: "Sign out", responses: { 200: { description: "Session cleared." } } } },
    "/api/auth/me": {
      get: {
        summary: "Get the current account",
        security: [{ OAuth2PasswordBearer: [] }, { SessionCookie: [] }],
        responses: { 200: { description: "Current account." } },
      },
    },
    "/api/auth/token": { post: { summary: "Get a bearer token", responses: { 200: { description: "Bearer token." } } } },
    "/api/documents/search": {
      get: {
        summary: "Search documents by customer",
        security: [{ OAuth2PasswordBearer: [] }, { SessionCookie: [] }],
        responses: { 200: { description: "Matching documents." } },
      },
    },
    "/api/documents/semantic-search": {
      post: {
        summary: "Search documents semantically",
        security: [{ OAuth2PasswordBearer: [] }, { SessionCookie: [] }],
        responses: { 200: { description: "Ranked search results." } },
      },
    },
    "/api/documents/upload": {
      post: {
        summary: "Upload and process an invoice",
        security: [{ OAuth2PasswordBearer: [] }, { SessionCookie: [] }],
        responses: { 200: { description: "Extraction and validation result." } },
      },
    },
    "/api/documents/{doc_id}/correct": {
      put: {
        summary: "Correct extracted invoice fields",
        security: [{ OAuth2PasswordBearer: [] }, { SessionCookie: [] }],
        responses: { 200: { description: "Correction result." } },
      },
    },
    "/api/documents/export-csv": {
      get: {
        summary: "Export document records as CSV",
        security: [{ OAuth2PasswordBearer: [] }, { SessionCookie: [] }],
        responses: { 200: { description: "CSV report." } },
      },
    },
    "/api/documents/analytics": {
      get: {
        summary: "Get weekly processing counts",
        security: [{ OAuth2PasswordBearer: [] }, { SessionCookie: [] }],
        responses: { 200: { description: "Weekly processing counts." } },
      },
    },
    "/analytics": {
      get: {
        summary: "Get document processing analytics",
        security: [{ OAuth2PasswordBearer: [] }, { SessionCookie: [] }],
        responses: { 200: { description: "Processing analytics." } },
      },
    },
    "/process": {
      post: {
        summary: "Upload and process an invoice",
        security: [{ OAuth2PasswordBearer: [] }, { SessionCookie: [] }],
        responses: { 200: { description: "Extraction and validation result." } },
      },
    },
    "/api/documents/{document_id}": {
      delete: {
        summary: "Delete a document (administrator only)",
        security: [{ OAuth2PasswordBearer: [] }, { SessionCookie: [] }],
        responses: { 200: { description: "Document deleted." } },
      },
    },
  },
};

app.get("/openapi.json", (_req, res) => {
  res.json(openApiDocument);
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

app.use((_req, res) => {
  res.status(404).json({ detail: "Not Found" });
});

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error);
  const detail = status >= 500 && IS_PRODUCTION ? "Internal server error." : error.message;
  res.status(status).json({ detail });
});

app.locals.encodeSemanticText = encodeSemanticText;
app.locals.createAccessToken = createAccessToken;
app.locals.initPromise = initPromise;
app.locals.database = db;

module.exports = app;
