import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMemorySearchTool, type MemorySearchToolDeps } from "./tools.search.js";
import type { MemoryReference } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

// ── Mock supplements: mock listMemoryCorpusSupplements ────────────

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

// ── Schema guard ─────────────────────────────────────────────────

describe("memory_search tool: schema", () => {
  it("schema field set matches memory-core MemorySearchSchema", () => {
    const tool = createMemorySearchTool(makeDeps());
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    const fieldNames = Object.keys(props).sort();
    expect(fieldNames).toEqual(["corpus", "maxResults", "minScore", "query"]);
  });
});

// ── Parameter validation ────────────────────────────────────────

describe("memory_search tool: parameter validation", () => {
  it("returns error for empty query string", async () => {
    const tool = createMemorySearchTool(makeDeps());
    const result = await tool.execute("call-1", { query: "" }, undefined);
    const payload = parseResult(result);
    expect(payload.error).toContain("query is required");
  });

  it("returns error when query is missing", async () => {
    const tool = createMemorySearchTool(makeDeps());
    const result = await tool.execute("call-1", {}, undefined);
    const payload = parseResult(result);
    expect(payload.error).toContain("query is required");
  });
});

// ── Corpus routing ─────────────────────────────────────────────

describe("memory_search tool: corpus routing", () => {
  it("corpus=memory calls manager.search and returns results", async () => {
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

  it("defaults corpus to memory when not provided", async () => {
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

  it("corpus=sessions searches milvus with sessionKey filter, outputs corpus=sessions", async () => {
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

  it("corpus=wiki only queries supplements, returns empty when none registered", async () => {
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

    // wiki corpus does not call milvus
    expect(searchSpy).not.toHaveBeenCalled();
    expect(payload.results).toEqual([]);
    expect(payload.corpus).toBe("wiki");
  });

  it("corpus=all merges milvus + supplement results, outputs corpus=all", async () => {
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

  it("corpus=wiki with null manager does not throw (wiki skips milvus)", async () => {
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
  it("triggers recordRecall on search hit, passing refs and context", async () => {
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

  it("does not trigger recordRecall when search has no results", async () => {
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

  it("does not throw when manager has no recordRecall method", async () => {
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

// ── Citation decoration ─────────────────────────────────────────

describe("memory_search tool: citation decoration", () => {
  it("default (no cfg, no sessionKey) → auto mode → direct → includes citation", async () => {
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

  it("cfg.memory.citations='off' → no citation decoration", async () => {
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

  it("cfg.memory.citations='on' → force decoration", async () => {
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

// ── Manager unavailable ─────────────────────────────────────────

describe("memory_search tool: manager unavailable", () => {
  it("returns initialization error when manager is null", async () => {
    const tool = createMemorySearchTool({ getManager: () => null });

    const result = await tool.execute("call-1", { query: "test" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("not initialized");
  });
});

// ── Manager internal error ─────────────────────────────────────

describe("memory_search tool: manager internal error", () => {
  it("returns error when manager.search throws, no uncaught exception", async () => {
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
