const crypto = require("node:crypto");

const VECTOR_SIZE = 384;
const DEFAULT_COLLECTION = "document_embeddings";
let collectionPromise;
const pendingDocumentIds = new Set();

function getConfig() {
  const rawUrl = (process.env.QDRANT_URL || "").trim();
  if (!rawUrl) return null;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("QDRANT_URL must be a valid absolute URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("QDRANT_URL must use HTTP(S) and must not contain credentials, query parameters, or a fragment.");
  }
  if (url.pathname !== "/") {
    throw new Error("QDRANT_URL must be the Qdrant server origin without a path.");
  }
  if ((process.env.APP_ENV || "").trim().toLowerCase() === "production" && url.protocol !== "https:") {
    throw new Error("QDRANT_URL must use HTTPS in production.");
  }

  const apiKey = (process.env.QDRANT_API_KEY || "").trim();
  if (!apiKey) throw new Error("QDRANT_API_KEY is required when QDRANT_URL is configured.");

  const collection = (process.env.QDRANT_COLLECTION || DEFAULT_COLLECTION).trim();
  if (!collection) throw new Error("QDRANT_COLLECTION must not be empty.");

  return { apiKey, collection, url: url.origin };
}

function isQdrantConfigured() {
  return Boolean((process.env.QDRANT_URL || "").trim());
}

function pointIdForDocument(docId) {
  const bytes = crypto.createHash("sha256").update(String(docId)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function qdrantRequest(path, options = {}) {
  const config = getConfig();
  if (!config) return null;

  let response;
  try {
    response = await fetch(`${config.url}${path}`, {
      ...options,
      signal: AbortSignal.timeout(15000),
      headers: {
        "api-key": config.apiKey,
        "content-type": "application/json",
        ...options.headers,
      },
    });
  } catch (cause) {
    const error = new Error("Unable to reach the configured Qdrant service.");
    error.cause = cause;
    throw error;
  }
  return response;
}

function collectionPath(collection) {
  return `/collections/${encodeURIComponent(collection)}`;
}

async function ensureCollection() {
  const config = getConfig();
  if (!config) return;
  if (!collectionPromise) {
    collectionPromise = (async () => {
      const path = collectionPath(config.collection);
      const response = await qdrantRequest(path);
      if (response.ok) return;
      if (response.status !== 404) {
        throw new Error(`Qdrant collection check failed with HTTP ${response.status}.`);
      }

      const createResponse = await qdrantRequest(path, {
        method: "PUT",
        body: JSON.stringify({
          vectors: { size: VECTOR_SIZE, distance: "Cosine" },
        }),
      });
      if (!createResponse.ok && createResponse.status !== 409) {
        throw new Error(`Qdrant collection creation failed with HTTP ${createResponse.status}.`);
      }
    })().catch((error) => {
      collectionPromise = undefined;
      throw error;
    });
  }
  return collectionPromise;
}

function validateVector(vector) {
  if (
    !Array.isArray(vector) ||
    vector.length !== VECTOR_SIZE ||
    !vector.every((value) => Number.isFinite(value))
  ) {
    throw new Error(`Semantic embeddings must contain ${VECTOR_SIZE} finite numeric values.`);
  }
}

async function upsertPoints(points) {
  if (!points.length) return;
  const config = getConfig();
  if (!config) return;
  await ensureCollection();
  const response = await qdrantRequest(
    `${collectionPath(config.collection)}/points?wait=true`,
    {
      method: "PUT",
      body: JSON.stringify({ points }),
    },
  );
  if (!response.ok) throw new Error(`Qdrant vector upsert failed with HTTP ${response.status}.`);
}

async function upsertVector(docId, vector) {
  if (!isQdrantConfigured()) return false;
  validateVector(vector);
  return upsertVectors([{ docId, vector }]);
}

async function upsertVectors(entries) {
  if (!isQdrantConfigured()) return false;
  for (const { docId, vector } of entries) {
    validateVector(vector);
    pendingDocumentIds.add(String(docId));
  }
  await upsertPoints(entries.map(({ docId, vector }) => ({
    id: pointIdForDocument(docId),
    vector,
    payload: { doc_id: String(docId) },
  })));
  for (const { docId } of entries) pendingDocumentIds.delete(String(docId));
  return true;
}

async function searchVectors(vector, limit) {
  if (!isQdrantConfigured()) return null;
  validateVector(vector);
  const config = getConfig();
  await ensureCollection();
  const response = await qdrantRequest(`${collectionPath(config.collection)}/points/search`, {
    method: "POST",
    body: JSON.stringify({ vector, limit, with_payload: true }),
  });
  if (!response.ok) throw new Error(`Qdrant vector search failed with HTTP ${response.status}.`);
  const body = await response.json();
  if (!Array.isArray(body.result)) throw new Error("Qdrant returned an invalid search response.");
  return body.result
    .filter((hit) => typeof hit.payload?.doc_id === "string" && Number.isFinite(hit.score))
    .map((hit) => ({ doc_id: hit.payload.doc_id, score: hit.score }));
}

async function deleteVector(docId) {
  if (!isQdrantConfigured()) return false;
  const config = getConfig();
  await ensureCollection();
  const response = await qdrantRequest(
    `${collectionPath(config.collection)}/points/delete?wait=true`,
    {
      method: "POST",
      body: JSON.stringify({
        filter: {
          must: [{ key: "doc_id", match: { value: String(docId) } }],
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Qdrant vector deletion failed with HTTP ${response.status}.`);
  pendingDocumentIds.delete(String(docId));
  return true;
}

async function retryPendingVectors(database) {
  if (!isQdrantConfigured() || !pendingDocumentIds.size) return 0;
  const pendingIds = [...pendingDocumentIds].slice(0, 500);
  const rows = database.prepare(`
    SELECT doc_id, embedding FROM document_embeddings
    WHERE doc_id IN (${pendingIds.map(() => "?").join(", ")})
  `).all(...pendingIds);
  const rowsById = new Map(rows.map((row) => [row.doc_id, row]));
  const entries = [];
  for (const docId of pendingIds) {
    const row = rowsById.get(docId);
    if (!row) {
      pendingDocumentIds.delete(docId);
      continue;
    }
    let vector;
    try {
      vector = JSON.parse(row.embedding);
      validateVector(vector);
    } catch (cause) {
      const error = new Error(`Cannot retry the stored embedding for document ${docId}.`);
      error.cause = cause;
      throw error;
    }
    entries.push({ docId, vector });
  }
  if (entries.length) await upsertVectors(entries);
  return entries.length;
}

async function migrateStoredEmbeddings(database) {
  if (!isQdrantConfigured()) return 0;
  const rows = database.prepare(
    "SELECT doc_id, embedding FROM document_embeddings",
  ).all();
  const points = rows.map((row) => {
    let vector;
    try {
      vector = JSON.parse(row.embedding);
      validateVector(vector);
    } catch (cause) {
      const error = new Error(`Cannot migrate the stored embedding for document ${row.doc_id}.`);
      error.cause = cause;
      throw error;
    }
    return {
      id: pointIdForDocument(row.doc_id),
      vector,
      payload: { doc_id: String(row.doc_id) },
    };
  });

  for (let index = 0; index < points.length; index += 100) {
    await upsertPoints(points.slice(index, index + 100));
  }
  return points.length;
}

module.exports = {
  deleteVector,
  isQdrantConfigured,
  migrateStoredEmbeddings,
  pointIdForDocument,
  retryPendingVectors,
  searchVectors,
  upsertVector,
  upsertVectors,
};
