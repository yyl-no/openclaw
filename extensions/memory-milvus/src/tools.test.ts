import { describe, expect, it, vi } from "vitest";
import { createMemoryWriteTool } from "./tools.js";
import { MEMORY_SOURCE_LABELS } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeArgs(params: Record<string, unknown>): [string, unknown] {
  return ["call-1", params];
}

function parseResult(raw: unknown): Record<string, unknown> {
  const result = raw as { details?: unknown };
  if (result.details) return result.details as Record<string, unknown>;
  return {};
}

// ── Tests ─────────────────────────────────────────────────────────

describe("memory_write tool", () => {
  // ── 成功路径 ──────────────────────────────────────────────────

  it("合法 label + 有效 text → 写入成功，返回 id 和 label", async () => {
    const writeSpy = vi.fn().mockResolvedValue({
      id: "42",
      provenance: { label: "chat_extract" },
    });
    const tool = createMemoryWriteTool({
      getManager: () => ({ write: writeSpy }),
    });

    const [, params] = makeArgs({ text: "Important fact", label: "chat_extract" });
    const result = await tool.execute("call-1", params, undefined);
    const payload = parseResult(result);

    expect(writeSpy).toHaveBeenCalledWith({
      text: "Important fact",
      provenance: { label: "chat_extract" },
    });
    expect(payload.id).toBe("42");
    expect(payload.label).toBe("chat_extract");
  });

  it("不传 label 时默认 chat_extract", async () => {
    const writeSpy = vi.fn().mockResolvedValue({
      id: "99",
      provenance: { label: "chat_extract" },
    });
    const tool = createMemoryWriteTool({
      getManager: () => ({ write: writeSpy }),
    });

    const [, params] = makeArgs({ text: "Default label test" });
    const result = await tool.execute("call-1", params, undefined);
    const payload = parseResult(result);

    expect(writeSpy).toHaveBeenCalledWith({
      text: "Default label test",
      provenance: { label: "chat_extract" },
    });
    expect(payload.id).toBe("99");
  });

  // ── 校验失败 ──────────────────────────────────────────────────

  it("非法 label 返回错误，不调用 manager.write", async () => {
    const writeSpy = vi.fn();
    const tool = createMemoryWriteTool({
      getManager: () => ({ write: writeSpy }),
    });

    const [, params] = makeArgs({ text: "Bad label test", label: "invalid_label_xyz" });
    const result = await tool.execute("call-1", params, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("Invalid memory source label");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("text 为空字符串返回错误", async () => {
    const writeSpy = vi.fn();
    const tool = createMemoryWriteTool({
      getManager: () => ({ write: writeSpy }),
    });

    const [, params] = makeArgs({ text: "", label: "chat_extract" });
    const result = await tool.execute("call-1", params, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("text is required");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("text 缺失返回错误", async () => {
    const writeSpy = vi.fn();
    const tool = createMemoryWriteTool({
      getManager: () => ({ write: writeSpy }),
    });

    const [, params] = makeArgs({ label: "chat_extract" });
    const result = await tool.execute("call-1", params, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("text is required");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  // ── Manager 不可用 ────────────────────────────────────────────

  it("manager 为 null 时返回初始化错误", async () => {
    const tool = createMemoryWriteTool({
      getManager: () => null,
    });

    const [, params] = makeArgs({ text: "No manager", label: "chat_extract" });
    const result = await tool.execute("call-1", params, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("not initialized");
  });

  // ── Manager write 内部异常 ────────────────────────────────────

  it("manager.write 抛错时返回错误，不抛未捕获异常", async () => {
    const writeSpy = vi.fn().mockRejectedValue(new Error("Milvus connection lost"));
    const tool = createMemoryWriteTool({
      getManager: () => ({ write: writeSpy }),
    });

    const [, params] = makeArgs({ text: "Crash test", label: "user_manual" });
    const result = await tool.execute("call-1", params, undefined);
    const payload = parseResult(result);

    expect(payload.error).toBe("Milvus connection lost");
  });

  // ── user_manual 标签 ──────────────────────────────────────────

  it("user_manual label 写入成功", async () => {
    const writeSpy = vi.fn().mockResolvedValue({
      id: "77",
      provenance: { label: "user_manual" },
    });
    const tool = createMemoryWriteTool({
      getManager: () => ({ write: writeSpy }),
    });

    const [, params] = makeArgs({ text: "Manual entry", label: "user_manual" });
    const result = await tool.execute("call-1", params, undefined);
    const payload = parseResult(result);

    expect(writeSpy).toHaveBeenCalledWith({
      text: "Manual entry",
      provenance: { label: "user_manual" },
    });
    expect(payload.label).toBe("user_manual");
  });

  // ── 确保不覆盖内置结果字段 ────────────────────────────────────

  it("返回结构不含额外字段", async () => {
    const writeSpy = vi.fn().mockResolvedValue({ id: "1", provenance: { label: "import" } });
    const tool = createMemoryWriteTool({
      getManager: () => ({ write: writeSpy }),
    });

    const [, params] = makeArgs({ text: "Import entry", label: "import" });
    const result = await tool.execute("call-1", params, undefined);
    const payload = parseResult(result);

    expect(Object.keys(payload).sort()).toEqual(["id", "label"]);
  });
});
