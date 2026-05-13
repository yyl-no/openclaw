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

function makeClient(overrides?: Partial<Record<"describeCollection" | "insert", ReturnType<typeof vi.fn>>>): MilvusClient {
  return {
    describeCollection: vi.fn().mockResolvedValue({}),
    insert: vi.fn().mockResolvedValue({ IDs: { int_id: { data: [42] } } }),
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

// ── recordRecall 占位 ────────────────────────────────────────────

describe("MilvusSearchManager.recordRecall: 占位", () => {
  it("调用不抛错，仅 console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = createManager();

    const refs: MemoryReference[] = [
      { id: "1", snippet: "test", score: 0.5, provenance: { kind: "milvus", label: "chat_extract" } },
    ];

    await expect(
      manager.recordRecall(refs, { query: "test", timezone: "UTC" }),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      "[memory-milvus] recordRecall not yet implemented (Task 12)",
    );

    warnSpy.mockRestore();
  });
});
