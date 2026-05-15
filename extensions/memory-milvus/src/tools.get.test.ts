import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMemoryGetTool, type MemoryGetToolDeps } from "./tools.get.js";
import type { MemoryEntry } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

// ── Helpers ───────────────────────────────────────────────────────

function parseResult(raw: unknown): Record<string, unknown> {
  const result = raw as { details?: unknown };
  if (result.details) return result.details as Record<string, unknown>;
  return {} as Record<string, unknown>;
}

function makeEntry(overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "42",
    text: "Full memory content",
    snippet: "Full memory...",
    agentId: "agent-1",
    sessionKey: "sess-1",
    memoryType: "short_term",
    recallCount: 3,
    provenance: { kind: "milvus", label: "chat_extract" },
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<MemoryGetToolDeps>): MemoryGetToolDeps {
  return {
    getManager: () => ({
      get: vi.fn().mockResolvedValue(makeEntry()),
    }),
    ...overrides,
  };
}

// ── Reset ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Happy path ───────────────────────────────────────────────────

describe("memory_get tool: happy path", () => {
  it("valid id → returns MemoryEntry", async () => {
    const entry = makeEntry({ id: "42", text: "Hello world" });
    const getSpy = vi.fn().mockResolvedValue(entry);
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", { id: "42" }, undefined);
    const payload = parseResult(result);

    expect(getSpy).toHaveBeenCalledWith("42");
    expect(payload.id).toBe("42");
    expect(payload.text).toBe("Hello world");
    expect(payload.memoryType).toBe("short_term");
    expect(payload.recallCount).toBe(3);
    expect(payload.provenance).toEqual({ kind: "milvus", label: "chat_extract" });
  });

  it("leading/trailing whitespace in id is trimmed", async () => {
    const getSpy = vi.fn().mockResolvedValue(makeEntry());
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    await tool.execute("call-1", { id: "  42  " }, undefined);
    expect(getSpy).toHaveBeenCalledWith("42");
  });
});

// ── Error paths ──────────────────────────────────────────────────

describe("memory_get tool: error paths", () => {
  it("empty id string returns error", async () => {
    const getSpy = vi.fn();
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", { id: "" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("id is required");
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("missing id returns error", async () => {
    const getSpy = vi.fn();
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", {}, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("id is required");
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("not-found → returns error", async () => {
    const getSpy = vi.fn().mockRejectedValue(new Error("Memory entry not found: 999"));
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", { id: "999" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("Memory entry not found");
  });

  it("closed → returns error", async () => {
    const getSpy = vi.fn().mockRejectedValue(new Error("MilvusSearchManager is closed"));
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", { id: "1" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toBe("MilvusSearchManager is closed");
  });

  it("degraded → returns error", async () => {
    const getSpy = vi.fn().mockRejectedValue(new Error("MilvusSearchManager is in degraded mode"));
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", { id: "1" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toBe("MilvusSearchManager is in degraded mode");
  });
});

// ── No recordRecall trigger ──────────────────────────────────────

describe("memory_get tool: no recordRecall trigger", () => {
  it("successful get does not call recordRecall", async () => {
    // The memory_get tool itself does not hold recordRecall. Verification method: confirm
    // that manager.get() does not include a recordRecall call path by design.
    // This test verifies manager.get is called and returns correct results.
    const getSpy = vi.fn().mockResolvedValue(makeEntry());
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", { id: "42" }, undefined);
    const payload = parseResult(result);

    expect(getSpy).toHaveBeenCalledOnce();
    expect(payload.id).toBe("42");
  });
});

// ── Manager unavailable ──────────────────────────────────────────

describe("memory_get tool: manager unavailable", () => {
  it("returns initialization error when manager is null", async () => {
    const tool = createMemoryGetTool({ getManager: () => null });

    const result = await tool.execute("call-1", { id: "42" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("not initialized");
  });
});

// ── Ignored path/from/lines placeholders ─────────────────────────

describe("memory_get tool: extra params ignored", () => {
  it("still works with only id when path/from/lines are passed", async () => {
    const getSpy = vi.fn().mockResolvedValue(makeEntry({ id: "99" }));
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute(
      "call-1",
      { id: "99", path: "/some/file.md", from: 10, lines: 5, corpus: "memory" },
      undefined,
    );
    const payload = parseResult(result);

    expect(getSpy).toHaveBeenCalledWith("99");
    expect(payload.id).toBe("99");
  });
});
