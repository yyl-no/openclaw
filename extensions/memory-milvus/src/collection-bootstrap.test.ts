import { describe, expect, it, vi } from "vitest";
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

/** Success response */
const okStatus = { error_code: "Success", reason: "" };

function mockClient(overrides: Partial<Record<keyof MilvusClient, unknown>> = {}): MilvusClient {
  return {
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
      describeCollection: vi.fn().mockRejectedValue(new Error("not found")),
      createCollection: vi.fn().mockResolvedValue(okStatus),
      describeIndex: vi.fn().mockResolvedValue({ index_descriptions: [] }),
      createIndex: vi.fn().mockResolvedValue(okStatus),
      getLoadState: vi.fn().mockResolvedValue({ state: "LoadStateNotLoad" }),
      loadCollection: vi.fn().mockResolvedValue(okStatus),
    });

    await ensureCollectionReady(client, DEFAULT_CONFIG);

    expect(client.describeCollection).toHaveBeenCalledWith({
      collection_name: "openclaw_memory",
    });
    expect(client.createCollection).toHaveBeenCalledTimes(1);
    const createCall = (client.createCollection as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.collection_name).toBe("openclaw_memory");
    expect(createCall.enable_dynamic_field).toBe(false);
    expect(createCall.fields).toHaveLength(16); // 15 schema + 1 metadata JSON
    const fieldNames = createCall.fields.map((f: { name: string }) => f.name);
    expect(fieldNames).toContain("last_recalled_at");
    expect(fieldNames).toContain("content_hash");
    expect(fieldNames).toContain("sparse_bm25");

    expect(client.createIndex).toHaveBeenCalledTimes(2);
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
    expect(client.createIndex).toHaveBeenCalledTimes(2);
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
        index_descriptions: [{ index_name: "idx" }],
      }),
      getLoadState: vi.fn().mockResolvedValue({ state: "LoadStateNotLoad" }),
      loadCollection: vi.fn().mockResolvedValue(okStatus),
    });

    await ensureCollectionReady(client, DEFAULT_CONFIG);

    expect(client.createCollection).not.toHaveBeenCalled();
    expect(client.createIndex).not.toHaveBeenCalled();
    expect(client.loadCollection).toHaveBeenCalledTimes(1);
  });
});

// ── Scenario 4: create_collection failure ────────────────────────

describe("ensureCollectionReady: failure throws", () => {
  it("createCollection returns non-Success error_code, throws", async () => {
    const client = mockClient({
      describeCollection: vi.fn().mockRejectedValue(new Error("not found")),
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
      describeCollection: vi.fn().mockRejectedValue(new Error("not found")),
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
});

// ── Scenario 6: Network error → caller handles degraded ──────────

describe("ensureCollectionReady: network error", () => {
  it("describeCollection throws network error, ensureCollectionReady re-throws", async () => {
    // connect error → tryDescribe returns null → createCollection also fails → re-throw
    const client = mockClient({
      describeCollection: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
      createCollection: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    });

    await expect(ensureCollectionReady(client, DEFAULT_CONFIG))
      .rejects.toThrow("connect ECONNREFUSED");
  });
});
