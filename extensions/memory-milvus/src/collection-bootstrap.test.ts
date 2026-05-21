import { afterEach, describe, expect, it, vi } from "vitest";
import type { MilvusClient } from "@zilliz/milvus2-sdk-node";

import {
  ensureCollectionReady,
  type CollectionBootstrapConfig,
} from "./collection-bootstrap.js";

// ── Helpers ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: CollectionBootstrapConfig = {
  collectionName: "openclaw_memory",
  embeddingDim: 1024,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Success response */
const okStatus = { error_code: "Success", reason: "" };

function mockClient(overrides: Partial<Record<keyof MilvusClient, unknown>> = {}): MilvusClient {
  return {
    hasCollection: vi.fn().mockResolvedValue({ status: okStatus, value: true }),
    describeCollection: vi.fn(),
    createCollection: vi.fn(),
    describeIndex: vi.fn(),
    createIndex: vi.fn(),
    getLoadState: vi.fn(),
    loadCollection: vi.fn(),
    ...overrides,
  } as unknown as MilvusClient;
}

// ── Scenario 1: Fresh creation ───────────────────────────────────

describe("ensureCollectionReady: fresh creation", () => {
  it("executes full three steps: create_collection → create_index → load_collection", async () => {
    const client = mockClient({
      hasCollection: vi.fn().mockResolvedValue({ status: okStatus, value: false }),
      createCollection: vi.fn().mockResolvedValue(okStatus),
      describeIndex: vi.fn().mockResolvedValue({ index_descriptions: [] }),
      createIndex: vi.fn().mockResolvedValue(okStatus),
      getLoadState: vi.fn().mockResolvedValue({ state: "LoadStateNotLoad" }),
      loadCollection: vi.fn().mockResolvedValue(okStatus),
    });

    await ensureCollectionReady(client, DEFAULT_CONFIG);

    expect(client.hasCollection).toHaveBeenCalledWith({
      collection_name: "openclaw_memory",
    });
    expect(client.describeCollection).not.toHaveBeenCalled();
    expect(client.createCollection).toHaveBeenCalledTimes(1);
    const createCall = (client.createCollection as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.collection_name).toBe("openclaw_memory");
    expect(createCall.enable_dynamic_field).toBe(false);
    expect(createCall.fields).toHaveLength(15); // 14 memory fields + 1 metadata JSON
    const fieldNames = createCall.fields.map((f: { name: string }) => f.name);
    expect(fieldNames).toContain("last_recalled_at");
    expect(fieldNames).toContain("content_hash");
    expect(fieldNames).not.toContain("sparse_bm25");

    expect(client.createIndex).toHaveBeenCalledTimes(1);
    const indexCall = (client.createIndex as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(indexCall.collection_name).toBe("openclaw_memory");
    expect(indexCall.field_name).toBe("embedding");
    expect(indexCall.index_type).toBe("HNSW");
    expect(indexCall.metric_type).toBe("COSINE");
    expect(indexCall.params).toEqual({ M: "16", efConstruction: "200" });

    expect(client.loadCollection).toHaveBeenCalledWith({
      collection_name: "openclaw_memory",
      replica_number: 1,
      refresh: true,
    });
  });

  it("creates collection when hasCollection returns CollectionNotExists status", async () => {
    const client = mockClient({
      hasCollection: vi.fn().mockResolvedValue({
        status: { error_code: "CollectionNotExists", reason: "collection not found" },
        value: false,
      }),
      createCollection: vi.fn().mockResolvedValue(okStatus),
      describeIndex: vi.fn().mockResolvedValue({ index_descriptions: [] }),
      createIndex: vi.fn().mockResolvedValue(okStatus),
      getLoadState: vi.fn().mockResolvedValue({ state: "LoadStateNotLoad" }),
      loadCollection: vi.fn().mockResolvedValue(okStatus),
    });

    await ensureCollectionReady(client, DEFAULT_CONFIG);

    expect(client.createCollection).toHaveBeenCalledTimes(1);
    expect(client.describeCollection).not.toHaveBeenCalled();
  });
});

// ── Scenario 2: Collection exists ────────────────────────────────

describe("ensureCollectionReady: already exists", () => {
  it("skips all three steps when Collection+Index+Loaded all exist", async () => {
    const client = mockClient({
      describeCollection: vi.fn().mockResolvedValue({
        status: okStatus,
        collection_name: "openclaw_memory",
        schema: { fields: [] },
      }),
      describeIndex: vi.fn().mockResolvedValue({
        index_descriptions: [{ index_name: "openclaw_memory_embedding_idx" }],
      }),
      getLoadState: vi.fn().mockResolvedValue({ state: "LoadStateLoaded" }),
    });

    await ensureCollectionReady(client, DEFAULT_CONFIG);

    expect(client.hasCollection).toHaveBeenCalledWith({
      collection_name: "openclaw_memory",
    });
    expect(client.describeCollection).toHaveBeenCalledWith({
      collection_name: "openclaw_memory",
      cache: false,
    });
    expect(client.createCollection).not.toHaveBeenCalled();
    expect(client.createIndex).not.toHaveBeenCalled();
    expect(client.loadCollection).not.toHaveBeenCalled();
  });
});

// ── Scenario 3: Partially exists (Collection yes, Index no) ──────

describe("ensureCollectionReady: partially exists", () => {
  it("Collection exists but no Index: skip create_collection, run create_index + load", async () => {
    const client = mockClient({
      describeCollection: vi.fn().mockResolvedValue({
        status: okStatus,
        collection_name: "openclaw_memory",
        schema: { fields: [] },
      }),
      describeIndex: vi.fn().mockRejectedValue(new Error("no index")),
      createIndex: vi.fn().mockResolvedValue(okStatus),
      getLoadState: vi.fn().mockResolvedValue({ state: "LoadStateNotLoad" }),
      loadCollection: vi.fn().mockResolvedValue(okStatus),
    });

    await ensureCollectionReady(client, DEFAULT_CONFIG);

    expect(client.createCollection).not.toHaveBeenCalled();
    expect(client.createIndex).toHaveBeenCalledTimes(1);
    expect(client.loadCollection).toHaveBeenCalledTimes(1);
  });

  it("Collection+Index exist but not Loaded: only run load_collection", async () => {
    const client = mockClient({
      describeCollection: vi.fn().mockResolvedValue({
        status: okStatus,
        collection_name: "openclaw_memory",
        schema: { fields: [] },
      }),
      describeIndex: vi.fn().mockResolvedValue({
        index_descriptions: [{ index_name: "idx", field_name: "embedding" }],
      }),
      getLoadState: vi.fn().mockResolvedValue({ state: "LoadStateNotLoad" }),
      loadCollection: vi.fn().mockResolvedValue(okStatus),
    });

    await ensureCollectionReady(client, DEFAULT_CONFIG);

    expect(client.createCollection).not.toHaveBeenCalled();
    expect(client.createIndex).not.toHaveBeenCalled();
    expect(client.loadCollection).toHaveBeenCalledTimes(1);
  });

  it("treats getLoadState collection-not-loaded errors as not loaded", async () => {
    const client = mockClient({
      describeCollection: vi.fn().mockResolvedValue({
        status: okStatus,
        collection_name: "openclaw_memory",
        schema: { fields: [] },
      }),
      describeIndex: vi.fn().mockResolvedValue({
        index_descriptions: [{ index_name: "idx", field_name: "embedding" }],
      }),
      getLoadState: vi.fn().mockRejectedValue(
        new Error(
          "ErrorCode: UnexpectedError. Reason: collection not loaded[collection=466411843909033358]",
        ),
      ),
      loadCollection: vi.fn().mockResolvedValue(okStatus),
    });

    await ensureCollectionReady(client, DEFAULT_CONFIG);

    expect(client.createCollection).not.toHaveBeenCalled();
    expect(client.createIndex).not.toHaveBeenCalled();
    expect(client.loadCollection).toHaveBeenCalledWith({
      collection_name: "openclaw_memory",
      replica_number: 1,
      refresh: true,
    });
  });

  it("uses async load and waits for loaded state", async () => {
    const client = mockClient({
      describeCollection: vi.fn().mockResolvedValue({
        status: okStatus,
        collection_name: "openclaw_memory",
        schema: { fields: [] },
      }),
      describeIndex: vi.fn().mockResolvedValue({
        index_descriptions: [{ index_name: "idx", field_name: "embedding" }],
      }),
      getLoadState: vi
        .fn()
        .mockResolvedValueOnce({ state: "LoadStateNotLoad" })
        .mockResolvedValueOnce({ state: "LoadStateNotLoad" })
        .mockResolvedValueOnce({ state: "LoadStateLoaded" }),
      loadCollectionAsync: vi.fn().mockResolvedValue(okStatus),
      loadCollection: vi.fn().mockResolvedValue(okStatus),
    });

    await ensureCollectionReady(client, DEFAULT_CONFIG);

    expect(client.loadCollectionAsync).toHaveBeenCalledWith({
      collection_name: "openclaw_memory",
      replica_number: 1,
      refresh: true,
    });
    expect(client.loadCollection).not.toHaveBeenCalled();
  });

  it("continues polling when sync load throws collection-not-loaded during SDK progress polling", async () => {
    const client = mockClient({
      describeCollection: vi.fn().mockResolvedValue({
        status: okStatus,
        collection_name: "openclaw_memory",
        schema: { fields: [] },
      }),
      describeIndex: vi.fn().mockResolvedValue({
        index_descriptions: [{ index_name: "idx", field_name: "embedding" }],
      }),
      getLoadState: vi
        .fn()
        .mockResolvedValueOnce({ state: "LoadStateNotLoad" })
        .mockResolvedValueOnce({ state: "LoadStateLoaded" }),
      loadCollectionAsync: undefined,
      loadCollection: vi.fn().mockRejectedValue(
        new Error(
          "ErrorCode: UnexpectedError. Reason: collection not loaded[collection=466411843909033358]",
        ),
      ),
    });

    await ensureCollectionReady(client, DEFAULT_CONFIG);

    expect(client.loadCollection).toHaveBeenCalledWith({
      collection_name: "openclaw_memory",
      replica_number: 1,
      refresh: true,
    });
  });
});

// ── Scenario 4: create_collection failure ────────────────────────

describe("ensureCollectionReady: failure throws", () => {
  it("createCollection returns non-Success error_code, throws", async () => {
    const client = mockClient({
      hasCollection: vi.fn().mockResolvedValue({ status: okStatus, value: false }),
      createCollection: vi.fn().mockResolvedValue({
        error_code: "UnexpectedError",
        reason: "something went wrong",
      }),
    });

    await expect(ensureCollectionReady(client, DEFAULT_CONFIG))
      .rejects.toThrow("Failed to create collection");
  });

  it("createIndex returns non-Success error_code, throws", async () => {
    const client = mockClient({
      hasCollection: vi.fn().mockResolvedValue({ status: okStatus, value: false }),
      createCollection: vi.fn().mockResolvedValue(okStatus),
      describeIndex: vi.fn().mockResolvedValue({ index_descriptions: [] }),
      createIndex: vi.fn().mockResolvedValue({
        error_code: "UnexpectedError",
        reason: "index creation failed",
      }),
    });

    await expect(ensureCollectionReady(client, DEFAULT_CONFIG))
      .rejects.toThrow("Failed to create index");
  });

  it("describeCollection returns non-not-found error_code, throws", async () => {
    const client = mockClient({
      hasCollection: vi.fn().mockResolvedValue({ status: okStatus, value: true }),
      describeCollection: vi.fn().mockResolvedValue({
        status: { error_code: "UnexpectedError", reason: "permission denied" },
      }),
    });

    await expect(ensureCollectionReady(client, DEFAULT_CONFIG))
      .rejects.toThrow("Failed to describe collection");
    expect(client.createCollection).not.toHaveBeenCalled();
  });

  it("hasCollection returns non-not-found error_code, throws", async () => {
    const client = mockClient({
      hasCollection: vi.fn().mockResolvedValue({
        status: { error_code: "UnexpectedError", reason: "permission denied" },
        value: false,
      }),
    });

    await expect(ensureCollectionReady(client, DEFAULT_CONFIG))
      .rejects.toThrow("Failed to check collection");
    expect(client.describeCollection).not.toHaveBeenCalled();
    expect(client.createCollection).not.toHaveBeenCalled();
  });
});

// ── Scenario 5: HNSW parameter passthrough ───────────────────────

describe("ensureCollectionReady: HNSW params", () => {
  it("uses config-specified HNSW params instead of defaults", async () => {
    const client = mockClient({
      describeCollection: vi.fn().mockResolvedValue({
        status: okStatus,
        collection_name: "openclaw_memory",
        schema: { fields: [] },
      }),
      describeIndex: vi.fn().mockRejectedValue(new Error("no index")),
      createIndex: vi.fn().mockResolvedValue(okStatus),
      getLoadState: vi.fn().mockResolvedValue({ state: "LoadStateLoaded" }),
    });

    await ensureCollectionReady(client, {
      ...DEFAULT_CONFIG,
      hnswM: 32,
      efConstruction: 400,
      metricType: "IP",
    });

    const indexCall = (client.createIndex as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(indexCall.metric_type).toBe("IP");
    expect(indexCall.params).toEqual({ M: "32", efConstruction: "400" });
  });

  it("creates a BM25 Function collection through REST when enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = mockClient({
      hasCollection: vi.fn().mockResolvedValue({ status: okStatus, value: false }),
      describeIndex: vi
        .fn()
        .mockResolvedValueOnce({
          index_descriptions: [{ index_name: "embedding_idx", field_name: "embedding" }],
        })
        .mockResolvedValueOnce({
          index_descriptions: [{ index_name: "sparse_idx", field_name: "sparse_bm25" }],
        }),
      getLoadState: vi.fn().mockResolvedValue({ state: "LoadStateNotLoad" }),
      loadCollection: vi.fn().mockResolvedValue(okStatus),
    });

    await ensureCollectionReady(client, {
      ...DEFAULT_CONFIG,
      host: "127.0.0.1",
      port: 19530,
      token: "test-token",
      database: "default",
      enableSparseIndex: true,
    });

    expect(client.createCollection).not.toHaveBeenCalled();
    expect(client.createIndex).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:19530/v2/vectordb/collections/create");
    expect(init.headers.Authorization).toBe("Bearer test-token");
    const payload = JSON.parse(String(init.body));
    expect(payload.dbName).toBe("default");
    expect(payload.collectionName).toBe("openclaw_memory");
    expect(payload.schema.functions).toEqual([
      {
        name: "text_bm25_emb",
        description: "BM25 function for memory text",
        type: "BM25",
        inputFieldNames: ["text"],
        outputFieldNames: ["sparse_bm25"],
        params: {},
      },
    ]);
    const textField = payload.schema.fields.find((field: { fieldName: string }) =>
      field.fieldName === "text"
    );
    expect(textField.elementTypeParams.enable_analyzer).toBe(true);
    const sparseField = payload.schema.fields.find((field: { fieldName: string }) =>
      field.fieldName === "sparse_bm25"
    );
    expect(sparseField).toMatchObject({
      fieldName: "sparse_bm25",
      dataType: "SparseFloatVector",
      isFunctionOutput: true,
    });
    expect(payload.indexParams).toBeUndefined();
    const [loadUrl, loadInit] = fetchMock.mock.calls[1]!;
    expect(loadUrl).toBe("http://127.0.0.1:19530/v2/vectordb/collections/load");
    expect(loadInit.headers.Authorization).toBe("Bearer test-token");
    expect(JSON.parse(String(loadInit.body))).toEqual({
      dbName: "default",
      collectionName: "openclaw_memory",
    });
  });

  it("creates optional sparse BM25 index with IP metric when enabled for an existing collection", async () => {
    const client = mockClient({
      describeCollection: vi.fn().mockResolvedValue({
        status: okStatus,
        collection_name: "openclaw_memory",
        schema: { fields: [] },
      }),
      describeIndex: vi.fn().mockResolvedValue({ index_descriptions: [] }),
      createIndex: vi.fn().mockResolvedValue(okStatus),
      getLoadState: vi.fn().mockResolvedValue({ state: "LoadStateLoaded" }),
    });

    await ensureCollectionReady(client, {
      ...DEFAULT_CONFIG,
      enableSparseIndex: true,
    });

    expect(client.createIndex).toHaveBeenCalledTimes(2);
    const sparseIndexCall = (client.createIndex as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(sparseIndexCall.field_name).toBe("sparse_bm25");
    expect(sparseIndexCall.index_type).toBe("SPARSE_INVERTED_INDEX");
    expect(sparseIndexCall.metric_type).toBe("IP");
    expect(sparseIndexCall.params).toEqual({
      inverted_index_algo: "DAAT_MAXSCORE",
    });
  });

  it("does not treat an unrelated dense index as the sparse BM25 index", async () => {
    const client = mockClient({
      describeCollection: vi.fn().mockResolvedValue({
        status: okStatus,
        collection_name: "openclaw_memory",
        schema: { fields: [] },
      }),
      describeIndex: vi
        .fn()
        .mockResolvedValueOnce({
          index_descriptions: [{ index_name: "openclaw_memory_embedding_idx" }],
        })
        .mockResolvedValueOnce({
          index_descriptions: [{ index_name: "openclaw_memory_embedding_idx" }],
        }),
      createIndex: vi.fn().mockResolvedValue(okStatus),
      getLoadState: vi.fn().mockResolvedValue({ state: "LoadStateLoaded" }),
    });

    await ensureCollectionReady(client, {
      ...DEFAULT_CONFIG,
      enableSparseIndex: true,
    });

    expect(client.createIndex).toHaveBeenCalledTimes(1);
    const sparseIndexCall = (client.createIndex as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sparseIndexCall.field_name).toBe("sparse_bm25");
    expect(sparseIndexCall.metric_type).toBe("IP");
  });
});

// ── Scenario 6: Network error → caller handles degraded ──────────

describe("ensureCollectionReady: network error", () => {
  it("hasCollection throws network error, ensureCollectionReady re-throws", async () => {
    // connect error → tryDescribe returns null → createCollection also fails → re-throw
    const client = mockClient({
      hasCollection: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
      createCollection: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    });

    await expect(ensureCollectionReady(client, DEFAULT_CONFIG))
      .rejects.toThrow("connect ECONNREFUSED");
  });
});
