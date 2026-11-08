const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const argon2 = require("argon2");

const databasePath = path.resolve(
  process.env.DATABASE_PATH || path.resolve(__dirname, "../../documents.db"),
);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new Database(databasePath);
db.pragma("foreign_keys = ON");

function normalizeEmail(email) {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length > 320 ||
    !/^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$/.test(normalized)
  ) {
    const error = new Error("Enter a valid email address.");
    error.status = 422;
    throw error;
  }
  return normalized;
}

function validateNewPassword(password) {
  if (password.length < 12) {
    const error = new Error("Use a password with at least 12 characters.");
    error.status = 422;
    throw error;
  }
  if (password.length > 128) {
    const error = new Error("Passwords must be 128 characters or fewer.");
    error.status = 422;
    throw error;
  }
}

async function initDatabase() {
  const initialAdminEmail = process.env.AUTH_INITIAL_ADMIN_EMAIL?.trim() || "";
  const initialAdminPassword = process.env.AUTH_INITIAL_ADMIN_PASSWORD || "";
  if (Boolean(initialAdminEmail) !== Boolean(initialAdminPassword)) {
    throw new Error("Set both AUTH_INITIAL_ADMIN_EMAIL and AUTH_INITIAL_ADMIN_PASSWORD to bootstrap an admin.");
  }
  const normalizedAdminEmail = initialAdminEmail ? normalizeEmail(initialAdminEmail) : null;
  if (initialAdminPassword) validateNewPassword(initialAdminPassword);

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      doc_id TEXT PRIMARY KEY,
      customer_name TEXT,
      invoice_number TEXT,
      subtotal REAL,
      total REAL,
      validation_status TEXT,
      status TEXT
    );
    CREATE TABLE IF NOT EXISTS document_embeddings (
      doc_id TEXT PRIMARY KEY,
      embedding TEXT NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES documents (doc_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS document_processing_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_attempts (
      attempt_key TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL,
      window_started_at REAL NOT NULL
    );
  `);

  if (normalizedAdminEmail && !db.prepare("SELECT 1 FROM users WHERE email = ?").get(normalizedAdminEmail)) {
    const passwordHash = await argon2.hash(initialAdminPassword, {
      type: argon2.argon2id,
      timeCost: 2,
      memoryCost: 19456,
      parallelism: 1,
    });
    db.prepare(`
      INSERT INTO users (email, password_hash, role, created_at)
      VALUES (?, ?, 'admin', ?)
    `).run(
      normalizedAdminEmail,
      passwordHash,
      new Date().toISOString().slice(0, 19) + "Z",
    );
  }
}

module.exports = { db, databasePath, initDatabase, normalizeEmail, validateNewPassword };
