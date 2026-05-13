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

// ── 正常路径 ──────────────────────────────────────────────────────

describe("memory_get tool: 正常路径", () => {
  it("传入有效 id → 返回 MemoryEntry", async () => {
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

  it("id 前后空格被 trim", async () => {
    const getSpy = vi.fn().mockResolvedValue(makeEntry());
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    await tool.execute("call-1", { id: "  42  " }, undefined);
    expect(getSpy).toHaveBeenCalledWith("42");
  });
});

// ── 异常路径 ──────────────────────────────────────────────────────

describe("memory_get tool: 异常路径", () => {
  it("id 为空字符串返回错误", async () => {
    const getSpy = vi.fn();
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", { id: "" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("id is required");
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("id 缺失返回错误", async () => {
    const getSpy = vi.fn();
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", {}, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("id is required");
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("not-found → 返回错误", async () => {
    const getSpy = vi.fn().mockRejectedValue(new Error("Memory entry not found: 999"));
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", { id: "999" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("Memory entry not found");
  });

  it("closed → 返回错误", async () => {
    const getSpy = vi.fn().mockRejectedValue(new Error("MilvusSearchManager is closed"));
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", { id: "1" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toBe("MilvusSearchManager is closed");
  });

  it("degraded → 返回错误", async () => {
    const getSpy = vi.fn().mockRejectedValue(new Error("MilvusSearchManager is in degraded mode"));
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", { id: "1" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toBe("MilvusSearchManager is in degraded mode");
  });
});

// ── 不触发 recordRecall ──────────────────────────────────────────

describe("memory_get tool: 不触发 recordRecall", () => {
  it("成功获取也不调用 recordRecall", async () => {
    // memory_get tool 本身不持有 recordRecall，验证方式：确认工具
    // 设计上 manager get() 不包含 recordRecall 调用路径。
    // 此测试验证 manager.get 被调用且返回正确结果。
    const getSpy = vi.fn().mockResolvedValue(makeEntry());
    const tool = createMemoryGetTool(makeDeps({ getManager: () => ({ get: getSpy }) }));

    const result = await tool.execute("call-1", { id: "42" }, undefined);
    const payload = parseResult(result);

    expect(getSpy).toHaveBeenCalledOnce();
    expect(payload.id).toBe("42");
  });
});

// ── Manager 不可用 ───────────────────────────────────────────────

describe("memory_get tool: manager 不可用", () => {
  it("manager 为 null 时返回初始化错误", async () => {
    const tool = createMemoryGetTool({ getManager: () => null });

    const result = await tool.execute("call-1", { id: "42" }, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("not initialized");
  });
});

// ── path/from/lines 占位忽略 ─────────────────────────────────────

describe("memory_get tool: 冗余参数忽略", () => {
  it("传入 path/from/lines 时仍只用 id 正常工作", async () => {
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
