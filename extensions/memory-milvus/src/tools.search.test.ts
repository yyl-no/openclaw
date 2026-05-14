import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMemorySearchTool, type MemorySearchToolDeps } from "./tools.search.js";
import type { MemoryReference } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

// ── Mock 补充: mock listMemoryCorpusSupplements ─────────────────

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-core")>(
    "openclaw/plugin-sdk/memory-core-host-runtime-core",
  );
  return {
    ...actual,
    listMemoryCorpusSupplements: vi.fn(() => []),
  };
});

function parseResult(raw: unknown): Record<string, unknown> {
  const result = raw as { details?: unknown };
  if (result.details) return result.details as Record<string, unknown>;
  return {} as Record<string, unknown>;
}

function makeRef(overrides?: Partial<MemoryReference>): MemoryReference {
  return {
    id: "42",
    snippet: "Test snippet",
    score: 0.85,
    provenance: { kind: "milvus", label: "chat_extract" },
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<MemorySearchToolDeps>): MemorySearchToolDeps {
  return {
    getManager: () => ({
      search: vi.fn().mockResolvedValue([makeRef()]),
      recordRecall: vi.fn().mockResolvedValue(undefined),
    }),
    ...overrides,
  };
}

// ── Reset ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Schema 守护 ───────────────────────────────────────────────────

describe("memory_search tool: schema", () => {
  it("schema 字段集与 memory-core MemorySearchSchema 一致", () => {
    const tool = createMemorySearchTool(makeDeps());
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    const fieldNames = Object.keys(props).sort();
    expect(fieldNames).toEqual(["corpus", "maxResults", "minScore", "query"]);
  });
});

// ── 参数校验 ─────────────────────────────────────────────────────

describe("memory_search tool: 参数校验", () => {
  it("query 为空字符串返回错误", async () => {
    const tool = createMemorySearchTool(makeDeps());
    const result = await tool.execute("call-1", { query: "" }, undefined);
    const payload = parseResult(result);
    expect(payload.error).toContain("query is required");
  });

  it("query 缺失返回错误", async () => {
    const tool = createMemorySearchTool(makeDeps());
    const result = await tool.execute("call-1", {}, undefined);
    const payload = parseResult(result);
    expect(payload.error).toContain("query is required");
  });
});

// ── corpus 路由 ──────────────────────────────────────────────────

describe("memory_search tool: corpus 路由", () => {
  it("corpus=memory → 调用 manager.search 并返回结果", async () => {
    const searchSpy = vi.fn().mockResolvedValue([
      makeRef({ id: "1", snippet: "Memory hit" }),
    ]);
    const tool = createMemorySearchTool(
      makeDeps({ getManager: () => ({ search: searchSpy }) }),
    );

    const result = await tool.execute(
      "call-1",
      { query: "test", corpus: "memory", maxResults: 5, minScore: 0.3 },
      undefined,
    );
    const payload = parseResult(result);

    expect(searchSpy).toHaveBeenCalledWith("test", {
      maxResults: 5,
      minScore: 0.3,
      sessionKey: undefined,
    });
    expect(payload.results).toHaveLength(1);
    expect(payload.corpus).toBe("memory");
  });

  it("corpus 未传 → 默认 memory，正常搜索", async () => {
    const searchSpy = vi.fn().mockResolvedValue([makeRef()]);
    const tool = createMemorySearchTool(
      makeDeps({ getManager: () => ({ search: searchSpy }) }),
    );

    const result = await tool.execute("call-1", { query: "test" }, undefined);
    const payload = parseResult(result);

    expect(searchSpy).toHaveBeenCalledWith("test", {
      maxResults: undefined,
      minScore: undefined,
      sessionKey: undefined,
    });
    expect(payload.corpus).toBe("memory");
  });

  it("corpus=sessions → 搜索 milvus（sessionKey 过滤）, 输出 corpus=sessions", async () => {
    const searchSpy = vi.fn().mockResolvedValue([makeRef({ id: "s1" })]);
    const tool = createMemorySearchTool(
      makeDeps({
        getManager: () => ({ search: searchSpy }),
        agentSessionKey: "agent:test:session-1",
      }),
    );

    const result = await tool.execute(
      "call-1",
      { query: "test", corpus: "sessions" },
      undefined,
    );
    const payload = parseResult(result);

    expect(searchSpy).toHaveBeenCalledWith("test", {
      maxResults: undefined,
      minScore: undefined,
      sessionKey: "agent:test:session-1",
    });
    expect(payload.results).toHaveLength(1);
    expect(payload.corpus).toBe("sessions");
  });

  it("corpus=wiki → 仅查 supplement（无注册时返回空数组）", async () => {
    const searchSpy = vi.fn();
    const tool = createMemorySearchTool(
      makeDeps({ getManager: () => ({ search: searchSpy }) }),
    );

    const result = await tool.execute(
      "call-1",
      { query: "test", corpus: "wiki" },
      undefined,
    );
    const payload = parseResult(result);

    // wiki corpus 不调 milvus
    expect(searchSpy).not.toHaveBeenCalled();
    expect(payload.results).toEqual([]);
    expect(payload.corpus).toBe("wiki");
  });

  it("corpus=all → milvus + supplement 双路合并，输出 corpus=all", async () => {
    const searchSpy = vi.fn().mockResolvedValue([makeRef({ id: "m1" })]);
    const tool = createMemorySearchTool(
      makeDeps({ getManager: () => ({ search: searchSpy }) }),
    );

    const result = await tool.execute(
      "call-1",
      { query: "test", corpus: "all" },
      undefined,
    );
    const payload = parseResult(result);

    expect(searchSpy).toHaveBeenCalledOnce();
    expect(payload.results).toHaveLength(1);
    expect(payload.corpus).toBe("all");
  });

  it("corpus=wiki 时 manager 为 null 不抛错（wiki 不查 milvus）", async () => {
    const tool = createMemorySearchTool({ getManager: () => null });

    const result = await tool.execute(
      "call-1",
      { query: "test", corpus: "wiki" },
      undefined,
    );
    const payload = parseResult(result);

    expect(payload.results).toEqual([]);
    expect(payload.corpus).toBe("wiki");
    expect(payload.error).toBeUndefined();
  });
});

// ── recordRecall hook ────────────────────────────────────────────

describe("memory_search tool: recordRecall hook", () => {
  it("搜索命中后触发 recordRecall，传入 refs 和 context", async () => {
    const refs = [makeRef({ id: "1" }), makeRef({ id: "2" })];
    const recallSpy = vi.fn().mockResolvedValue(undefined);
    const tool = createMemorySearchTool(
      makeDeps({
        getManager: () => ({ search: vi.fn().mockResolvedValue(refs), recordRecall: recallSpy }),
      }),
    );

    await tool.execute("call-1", { query: "hello world" }, undefined);

    // recordRecall is called asynchronously (void), wait a tick
    await vi.waitFor(() => {
      expect(recallSpy).toHaveBeenCalledWith(refs, { query: "hello world" });
    });
  });

  it("搜索无结果时不触发 recordRecall", async () => {
    const recallSpy = vi.fn();
    const tool = createMemorySearchTool(
      makeDeps({
        getManager: () => ({ search: vi.fn().mockResolvedValue([]), recordRecall: recallSpy }),
      }),
    );

    await tool.execute("call-1", { query: "nothing" }, undefined);

    // No recordRecall call
    expect(recallSpy).not.toHaveBeenCalled();
  });

  it("manager 无 recordRecall 方法时不抛错", async () => {
    const tool = createMemorySearchTool(
      makeDeps({
        getManager: () => ({ search: vi.fn().mockResolvedValue([makeRef()]) }),
      }),
    );

    await expect(
      tool.execute("call-1", { query: "test" }, undefined),
    ).resolves.toBeDefined();
  });
});

// ── Citation 装饰 ────────────────────────────────────────────────

describe("memory_search tool: citation 装饰", () => {
  it("默认 (cfg 未设置, 无 sessionKey) → auto 模式 → direct → 包含 citation", async () => {
    const ref = makeRef({ id: "1", snippet: "Some memory content", provenance: { kind: "milvus", label: "test_source.md" } });
    const tool = createMemorySearchTool(
      makeDeps({
        getManager: () => ({ search: vi.fn().mockResolvedValue([ref]) }),
      }),
    );

    const result = await tool.execute("call-1", { query: "test" }, undefined);
    const payload = parseResult(result);
    const results = payload.results as MemoryReference[];

    expect(results).toHaveLength(1);
    expect(results[0].snippet).toContain("\n\nSource: test_source.md");
  });

  it("cfg.memory.citations='off' → 不装饰 citation", async () => {
    const ref = makeRef({ id: "1", snippet: "Some memory content" });
    const tool = createMemorySearchTool(
      makeDeps({
        getManager: () => ({ search: vi.fn().mockResolvedValue([ref]) }),
        cfg: { memory: { citations: "off" } } as any,
      }),
    );

    const result = await tool.execute("call-1", { query: "test" }, undefined);
    const payload = parseResult(result);
    const results = payload.results as MemoryReference[];

    expect(results).toHaveLength(1);
    expect(results[0].snippet).not.toContain("\n\nSource:");
    expect(results[0].snippet).toBe("Some memory content");
  });

  it("cfg.memory.citations='on' → 强制装饰", async () => {
    const ref = makeRef({ id: "1", snippet: "Forced citation", provenance: { kind: "milvus", label: "force_label" } });
    const tool = createMemorySearchTool(
      makeDeps({
        getManager: () => ({ search: vi.fn().mockResolvedValue([ref]) }),
        cfg: { memory: { citations: "on" } } as any,
      }),
    );

    const result = await tool.execute("call-1", { query: "test" }, undefined);
    const payload = parseResult(result);
    const results = payload.results as MemoryReference[];

    expect(results).toHaveLength(1);
    expect(results[0].snippet).toContain("\n\nSource: force_label");
  });
});

// ── Manager 不可用 ───────────────────────────────────────────────

describe("memory_search tool: manager 不可用", () => {
  it("manager 为 null 时返回初始化错误", async () => {
    const tool = createMemorySearchTool({ getManager: () => null });

    const result = await tool.execute("call-1", { query: "test" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("not initialized");
  });
});

// ── Manager 内部异常 ─────────────────────────────────────────────

describe("memory_search tool: manager 内部异常", () => {
  it("manager.search 抛错时返回错误，不抛未捕获异常", async () => {
    const tool = createMemorySearchTool(
      makeDeps({
        getManager: () => ({ search: vi.fn().mockRejectedValue(new Error("Search timeout")) }),
      }),
    );

    const result = await tool.execute("call-1", { query: "test" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toBe("Search timeout");
  });
});
