import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MilvusClient } from "@zilliz/milvus2-sdk-node";
import type { MemoryEntry, MemoryReference } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { MilvusSearchManager, type MilvusSearchConfig } from "./search.js";

// ── Mocks ─────────────────────────────────────────────────────────

vi.mock("./fallback.js", () => ({
  writeFallback: vi.fn().mockResolvedValue(undefined),
  replayFallback: vi.fn().mockResolvedValue(0),
  pendingFallbackCount: vi.fn().mockResolvedValue(0),
  FALLBACK_DIR: "memory/.milvus-fallback",
}));

import { writeFallback, replayFallback } from "./fallback.js";

const writeFallbackMock = vi.mocked(writeFallback);
const replayFallbackMock = vi.mocked(replayFallback);

// ── Helpers ───────────────────────────────────────────────────────

type WriteEntry = Omit<MemoryEntry, "id">;

function makeEntry(overrides: Partial<WriteEntry> = {}): WriteEntry {
  return {
    text: "Test memory content",
    snippet: "Test memory...",
    agentId: "agent-1",
    memoryType: "short_term",
    provenance: { kind: "milvus", label: "chat_extract" },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<MilvusSearchConfig> = {}): MilvusSearchConfig {
  return {
    host: "localhost",
    port: 19530,
    collectionName: "test_collection",
    embedding: {
      provider: "auto",
      model: "text-embedding-v3",
      dimensions: 1024,
    },
    ...overrides,
  };
}

function makeProvider(): MemoryEmbeddingProvider {
  return {
    id: "test-provider",
    model: "text-embedding-v3",
    embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  } as unknown as MemoryEmbeddingProvider;
}

function makeClient(overrides?: Partial<Record<"describeCollection" | "insert" | "query" | "upsert" | "get", ReturnType<typeof vi.fn>>>): MilvusClient {
  return {
    describeCollection: vi.fn().mockResolvedValue({}),
    insert: vi.fn().mockResolvedValue({ IDs: { int_id: { data: [42] } } }),
    query: vi.fn().mockResolvedValue({ data: [] }),
    upsert: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as MilvusClient;
}

function createManager(
  opts?: {
    client?: MilvusClient;
    provider?: MemoryEmbeddingProvider;
    agentId?: string;
    degraded?: boolean;
  },
): MilvusSearchManager {
  const client = opts?.client ?? makeClient();
  const provider = opts?.provider ?? makeProvider();
  return new MilvusSearchManager(
    client,
    "test_collection",
    provider,
    opts?.agentId ?? "agent-1",
    makeConfig(),
    "/tmp/test-workspace",
    { degraded: opts?.degraded ?? false },
  );
}

// ── Reset mocks before each test ─────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Path 1: Successful write ─────────────────────────────────────

describe("MilvusSearchManager.write: 成功路径", () => {
  it("健康 → replay fallback → embed → insert → 返回 MemoryReference", async () => {
    const client = makeClient();
    const provider = {
      id: "test-provider",
      model: "text-embedding-v3",
      embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedBatch: vi.fn(),
    } as unknown as MemoryEmbeddingProvider;

    const manager = new MilvusSearchManager(
      client,
      "test_collection",
      provider,
      "agent-1",
      makeConfig(),
      "/tmp/test-workspace",
    );

    const entry = makeEntry({ text: "Test memory" });
    const ref = await manager.write(entry);

    // 健康探测调用了
    expect(client.describeCollection).toHaveBeenCalledOnce();
    // 回放了 fallback
    expect(replayFallbackMock).toHaveBeenCalledOnce();
    // embed 被调用
    expect(provider.embedQuery).toHaveBeenCalledWith("Test memory");
    // insert 被调用
    expect(client.insert).toHaveBeenCalledOnce();
    // 返回正确 id
    expect(ref.id).toBe("42");
    expect(ref.provenance.kind).toBe("milvus");
    expect(ref.provenance.label).toBe("chat_extract");
  });
});

// ── Path 2: Embed 失败 → fallback ────────────────────────────────

describe("MilvusSearchManager.write: embed 失败", () => {
  it("embed 抛错后走 fallback 并返回 fallback id", async () => {
    const client = makeClient();
    const provider = {
      id: "test-provider",
      model: "text-embedding-v3",
      embedQuery: vi.fn().mockRejectedValue(new Error("AI overload")),
      embedBatch: vi.fn(),
    } as unknown as MemoryEmbeddingProvider;

    const manager = new MilvusSearchManager(
      client,
      "test_collection",
      provider,
      "agent-1",
      makeConfig(),
      "/tmp/test-workspace",
    );

    const entry = makeEntry({ text: "Memory that fails" });
    const ref = await manager.write(entry);

    // 健康探测通过了
    expect(client.describeCollection).toHaveBeenCalledOnce();
    // embed 被调用
    expect(provider.embedQuery).toHaveBeenCalledWith("Memory that fails");
    // insert 未被调用（embed 就失败了）
    expect(client.insert).not.toHaveBeenCalled();
    // fallback 写入被调用
    expect(writeFallbackMock).toHaveBeenCalledOnce();
    // 返回 fallback id
    expect(ref.id).toMatch(/^fallback:\d+$/);
  });
});

// ── Path 3: Insert 失败 → fallback ───────────────────────────────

describe("MilvusSearchManager.write: insert 失败", () => {
  it("embed 成功但 insert 抛错后走 fallback", async () => {
    const client = makeClient({
      insert: (() => {
        const fn = vi.fn<() => Promise<never>>();
        fn.mockRejectedValue(new Error("Insert timeout"));
        return fn;
      })(),
    });
    const provider = makeProvider();

    const manager = new MilvusSearchManager(
      client,
      "test_collection",
      provider,
      "agent-1",
      makeConfig(),
      "/tmp/test-workspace",
    );

    const entry = makeEntry({ text: "Memory insert fails" });
    const ref = await manager.write(entry);

    expect(client.describeCollection).toHaveBeenCalledOnce();
    expect(provider.embedQuery).toHaveBeenCalledOnce();
    expect(client.insert).toHaveBeenCalledOnce();
    // fallback 兜底
    expect(writeFallbackMock).toHaveBeenCalledOnce();
    expect(ref.id).toMatch(/^fallback:\d+$/);
  });
});

// ── Path 4: Degraded 直 fallback ─────────────────────────────────

describe("MilvusSearchManager.write: degraded 直 fallback", () => {
  it("degraded=true 时跳过健康探测，直接 fallback", async () => {
    const client = makeClient();
    const provider = makeProvider();

    const manager = new MilvusSearchManager(
      client,
      "test_collection",
      provider,
      "agent-1",
      makeConfig(),
      "/tmp/test-workspace",
      { degraded: true },
    );

    const entry = makeEntry({ text: "Degraded write" });
    const ref = await manager.write(entry);

    // 不调健康探测
    expect(client.describeCollection).not.toHaveBeenCalled();
    // 不调 embed
    expect(provider.embedQuery).not.toHaveBeenCalled();
    // 不调 insert
    expect(client.insert).not.toHaveBeenCalled();
    // 直接 fallback
    expect(writeFallbackMock).toHaveBeenCalledOnce();
    expect(ref.id).toMatch(/^fallback:\d+$/);
  });
});

// ── Path 5: 健康探测失败 → fallback ──────────────────────────────

describe("MilvusSearchManager.write: 健康探测失败", () => {
  it("非 degraded 但 healthCheck 失败 → fallback", async () => {
    const client = makeClient({
      describeCollection: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    });
    const provider = makeProvider();

    const manager = new MilvusSearchManager(
      client,
      "test_collection",
      provider,
      "agent-1",
      makeConfig(),
      "/tmp/test-workspace",
    );

    const entry = makeEntry({ text: "Offline write" });
    const ref = await manager.write(entry);

    // 健康探测被调用
    expect(client.describeCollection).toHaveBeenCalledOnce();
    // 但不调 embed
    expect(provider.embedQuery).not.toHaveBeenCalled();
    // fallback 写入
    expect(writeFallbackMock).toHaveBeenCalledOnce();
    expect(ref.id).toMatch(/^fallback:\d+$/);
  });
});

// ── recordRecall 正式实现 ────────────────────────────────────

describe("MilvusSearchManager.recordRecall", () => {
  const makeRefs = (ids: string[]): MemoryReference[] =>
    ids.map((id) => ({
      id,
      snippet: `snippet-${id}`,
      score: 0.8,
      provenance: { kind: "milvus" as const, label: "chat_extract" },
    }));

  const makeQueryRow = (id: string, recallCount = 0): Record<string, unknown> => ({
    id,
    text: `text-${id}`,
    snippet: `snippet-${id}`,
    agent_id: "agent-1",
    session_key: "sess-1",
    memory_type: "short_term",
    recall_count: recallCount,
    provenance_kind: "milvus",
    provenance_label: "chat_extract",
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    last_recalled_at: "",
  });

  it("空 refs → 不调 client，直接返回", async () => {
    const client = makeClient();
    const manager = createManager({ client });

    await manager.recordRecall([]);

    expect(client.query).not.toHaveBeenCalled();
    expect(client.upsert).not.toHaveBeenCalled();
  });

  it("closed → throw", async () => {
    const client = makeClient();
    const manager = createManager({ client });
    // force closed
    await (manager as unknown as { close(): Promise<void> }).close();

    await expect(
      manager.recordRecall(makeRefs(["1"])),
    ).rejects.toThrow("MilvusSearchManager is closed");
  });

  it("degraded → warnOnce 后 return，不调 client", async () => {
    const client = makeClient();
    const manager = new MilvusSearchManager(
      client,
      "test_collection",
      makeProvider(),
      "agent-1",
      makeConfig(),
      "/tmp/test-workspace",
      { degraded: true },
    );

    await manager.recordRecall(makeRefs(["1"]));

    expect(client.query).not.toHaveBeenCalled();
    expect(client.upsert).not.toHaveBeenCalled();
  });

  it("正常路径：命中累加 recall_count + last_recalled_at", async () => {
    const querySpy = vi.fn().mockResolvedValue({
      data: [makeQueryRow("1", 2), makeQueryRow("2", 0)],
    });
    const upsertSpy = vi.fn().mockResolvedValue({});

    const client = makeClient({
      query: querySpy,
      upsert: upsertSpy,
    });

    const manager = createManager({ client });

    const before = Date.now();
    await manager.recordRecall(makeRefs(["1", "2"]));
    const after = Date.now();

    // 第一步：query 当前字段
    expect(querySpy).toHaveBeenCalledOnce();
    expect(querySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        collection_name: "test_collection",
        filter: "id in [1,2]",
        limit: 2,
      }),
    );

    // 第二步：upsert 累加后的值
    expect(upsertSpy).toHaveBeenCalledOnce();
    const upsertArg = upsertSpy.mock.calls[0][0];
    expect(upsertArg.collection_name).toBe("test_collection");
    const rows = upsertArg.data as Record<string, unknown>[];
    expect(rows).toHaveLength(2);

    // id=1 原有 recall_count=2 → 3
    const row1 = rows.find((r) => r.id === "1")!;
    expect(row1.recall_count).toBe(3);
    const t1 = row1.last_recalled_at as string;
    expect(new Date(t1).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(t1).getTime()).toBeLessThanOrEqual(after);
    expect(row1.text).toBe("text-1"); // 保留原字段
    expect(row1.created_at).toBe("2025-01-01T00:00:00.000Z");

    // id=2 原有 recall_count=0 → 1
    const row2 = rows.find((r) => r.id === "2")!;
    expect(row2.recall_count).toBe(1);
    const t2 = row2.last_recalled_at as string;
    expect(new Date(t2).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("refs 中存在不存在于 milvus 的 id 时仍正常累加（prevCount=0）", async () => {
    const querySpy = vi.fn().mockResolvedValue({
      data: [makeQueryRow("1", 5)], // 只有 id=1 在 db 中
    });
    const upsertSpy = vi.fn().mockResolvedValue({});

    const client = makeClient({ query: querySpy, upsert: upsertSpy });
    const manager = createManager({ client });

    await manager.recordRecall(makeRefs(["1", "missing-id"]));

    const rows = upsertSpy.mock.calls[0][0].data as Record<string, unknown>[];
    expect(rows).toHaveLength(2);

    // id=1: 5+1=6
    expect(rows.find((r) => r.id === "1")!.recall_count).toBe(6);
    // missing-id: 0+1=1，且不保留原字段（无 existing）
    const missing = rows.find((r) => r.id === "missing-id")!;
    expect(missing.recall_count).toBe(1);
    expect(missing.text).toBeUndefined();
  });

  it("upsert 失败 → warnOnce 不抛", async () => {
    const querySpy = vi.fn().mockResolvedValue({
      data: [makeQueryRow("1", 1)],
    });
    const upsertSpy = vi.fn().mockRejectedValue(new Error("gRPC timeout"));

    const client = makeClient({ query: querySpy, upsert: upsertSpy });
    const manager = createManager({ client });

    await expect(
      manager.recordRecall(makeRefs(["1"])),
    ).resolves.toBeUndefined();

    // query 仍被调用
    expect(querySpy).toHaveBeenCalledOnce();
    // upsert 失败不抛
  });

  it("query 失败 → warnOnce 不抛（整体链路容错）", async () => {
    const querySpy = vi.fn().mockRejectedValue(new Error("connection lost"));
    const upsertSpy = vi.fn();

    const client = makeClient({ query: querySpy, upsert: upsertSpy });
    const manager = createManager({ client });

    await expect(
      manager.recordRecall(makeRefs(["1"])),
    ).resolves.toBeUndefined();

    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

// ── search degraded 降级 ───────────────────────────────────────

describe("MilvusSearchManager.search: degraded 降级", () => {
  it("degraded=true 时 search 返回 []，不调 client", async () => {
    const client = makeClient();
    const provider = makeProvider();
    const manager = new MilvusSearchManager(
      client,
      "test_collection",
      provider,
      "agent-1",
      makeConfig(),
      "/tmp/test-workspace",
      { degraded: true },
    );

    const results = await manager.search("test query");
    expect(results).toEqual([]);
  });
});

// ── get(id) 四态 ──────────────────────────────────────────────

describe("MilvusSearchManager.get", () => {
  it("found → 返回 MemoryEntry", async () => {
    const row = {
      id: "42",
      text: "Hello world",
      snippet: "Hello...",
      agent_id: "agent-1",
      session_key: "sess-1",
      memory_type: "short_term",
      recall_count: "3",
      provenance_kind: "milvus",
      provenance_label: "chat_extract",
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-13T00:00:00.000Z",
      last_recalled_at: "",
    };
    const client = { get: vi.fn().mockResolvedValue({ data: [row] }) } as unknown as MilvusClient;
    const manager = createManager({ client });

    const entry = await manager.get("42");
    expect(entry.id).toBe("42");
    expect(entry.text).toBe("Hello world");
    expect(entry.snippet).toBe("Hello...");
    expect(entry.recallCount).toBe(3);
    expect(entry.provenance.kind).toBe("milvus");
  });

  it("not found → throw", async () => {
    const client = { get: vi.fn().mockResolvedValue({ data: [] }) } as unknown as MilvusClient;
    const manager = createManager({ client });

    await expect(manager.get("999")).rejects.toThrow("Memory entry not found");
  });

  it("closed → throw", async () => {
    const manager = createManager();
    await manager.close();

    await expect(manager.get("1")).rejects.toThrow("MilvusSearchManager is closed");
  });

  it("degraded → throw", async () => {
    const manager = createManager({ degraded: true });

    await expect(manager.get("1")).rejects.toThrow("degraded mode");
  });
});
