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

/** 成功响应 */
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

// ── 场景 1: 全新创建 ─────────────────────────────────────────────

describe("ensureCollectionReady: 全新创建", () => {
  it("执行完整三步：create_collection → create_index → load_collection", async () => {
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
    expect(createCall.fields).toHaveLength(13); // 12 schema + 1 metadata JSON

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
});

// ── 场景 2: Collection 已存在 ─────────────────────────────────────

describe("ensureCollectionReady: 已存在", () => {
  it("Collection+Index+Loaded 全部已存在时，三步全部跳过", async () => {
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

// ── 场景 3: 部分存在（Collection 有，Index 无）────────────────────

describe("ensureCollectionReady: 部分存在", () => {
  it("Collection 已存在但无 Index 时，跳过 create_collection，执行 create_index + load", async () => {
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

  it("Collection+Index 已存在但未 Loaded 时，仅执行 load_collection", async () => {
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

// ── 场景 4: create_collection 失败 ─────────────────────────────────

describe("ensureCollectionReady: 失败抛出", () => {
  it("createCollection 返回 error_code 非 Success 时抛出", async () => {
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

  it("createIndex 返回 error_code 非 Success 时抛出", async () => {
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

// ── 场景 5: HNSW 参数透传 ──────────────────────────────────────────

describe("ensureCollectionReady: HNSW 参数", () => {
  it("使用 config 中指定的 HNSW 参数而非默认值", async () => {
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

// ── 场景 6: 网络错误 → 调用方处理 degraded ─────────────────────────

describe("ensureCollectionReady: 网络错误", () => {
  it("describeCollection 抛网络错误时，ensureCollectionReady 向上抛出", async () => {
    // 连接错误 → tryDescribe 返回 null → createCollection 同样失败 → 向上抛
    const client = mockClient({
      describeCollection: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
      createCollection: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    });

    await expect(ensureCollectionReady(client, DEFAULT_CONFIG))
      .rejects.toThrow("connect ECONNREFUSED");
  });
});
