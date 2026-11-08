const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  deleteVector,
  migrateStoredEmbeddings,
  pointIdForDocument,
  retryPendingVectors,
  searchVectors,
  upsertVector,
} = require("../src/vector-store");

test("Qdrant creates a collection, migrates vectors, searches, and deletes points", async () => {
  const previous = {
    apiKey: process.env.QDRANT_API_KEY,
    collection: process.env.QDRANT_COLLECTION,
    url: process.env.QDRANT_URL,
  };
  const originalFetch = global.fetch;
  const calls = [];
  let failNextUpsert = false;
  const vector = Array.from({ length: 384 }, (_, index) => index / 384);
  process.env.QDRANT_URL = "https://qdrant.example.test";
  process.env.QDRANT_API_KEY = "test-key";
  process.env.QDRANT_COLLECTION = "test embeddings";
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === undefined) {
      return { ok: false, status: 404 };
    }
    if (url.endsWith("/points/search")) {
      return {
        ok: true,
        json: async () => ({
          result: [{ payload: { doc_id: "legacy-id" }, score: 0.91 }],
        }),
      };
    }
    if (url.endsWith("/points?wait=true") && failNextUpsert) {
      failNextUpsert = false;
      return { ok: false, status: 503 };
    }
    return { ok: true, status: 200 };
  };

  try {
    assert.match(pointIdForDocument("legacy-id"), /^[0-9a-f-]{36}$/);
    assert.equal(
      await migrateStoredEmbeddings({
        prepare: () => ({
          all: () => [
            { doc_id: "legacy-id", embedding: JSON.stringify(vector) },
            { doc_id: "another-id", embedding: JSON.stringify(vector) },
          ],
        }),
      }),
      2,
    );
    assert.equal(await upsertVector("new-id", vector), true);
    assert.deepEqual(await searchVectors(vector, 5), [{ doc_id: "legacy-id", score: 0.91 }]);
    assert.equal(await deleteVector("legacy-id"), true);
    failNextUpsert = true;
    await assert.rejects(upsertVector("retry-id", vector), /HTTP 503/);
    assert.equal(
      await retryPendingVectors({
        prepare: () => ({
          all: () => [{ doc_id: "retry-id", embedding: JSON.stringify(vector) }],
        }),
      }),
      1,
    );

    assert.equal(calls[0].options.method, undefined);
    assert.equal(calls[1].options.method, "PUT");
    assert.match(calls[2].url, /points\?wait=true$/);
    assert.equal(JSON.parse(calls[2].options.body).points.length, 2);
    assert.equal(calls[3].options.headers["api-key"], "test-key");
    assert.match(calls[4].url, /points\/search$/);
    assert.match(calls[5].url, /points\/delete\?wait=true$/);
    assert.match(calls[6].url, /points\?wait=true$/);
    assert.match(calls[7].url, /points\?wait=true$/);
  } finally {
    global.fetch = originalFetch;
    if (previous.apiKey === undefined) delete process.env.QDRANT_API_KEY;
    else process.env.QDRANT_API_KEY = previous.apiKey;
    if (previous.collection === undefined) delete process.env.QDRANT_COLLECTION;
    else process.env.QDRANT_COLLECTION = previous.collection;
    if (previous.url === undefined) delete process.env.QDRANT_URL;
    else process.env.QDRANT_URL = previous.url;
  }
});
