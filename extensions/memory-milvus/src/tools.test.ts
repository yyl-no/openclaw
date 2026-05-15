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
  // ── Happy path ───────────────────────────────────────────────

  it("valid label + valid text → write succeeds, returns id and label", async () => {
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

  it("defaults label to chat_extract when not provided", async () => {
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

  // ── Validation failures ──────────────────────────────────────

  it("invalid label returns error, does not call manager.write", async () => {
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

  it("empty text string returns error", async () => {
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

  it("missing text returns error", async () => {
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

  // ── Manager unavailable ──────────────────────────────────────

  it("returns initialization error when manager is null", async () => {
    const tool = createMemoryWriteTool({
      getManager: () => null,
    });

    const [, params] = makeArgs({ text: "No manager", label: "chat_extract" });
    const result = await tool.execute("call-1", params, undefined);
    const payload = parseResult(result);

    expect(payload.error).toContain("not initialized");
  });

  // ── Manager write internal error ──────────────────────────────

  it("returns error when manager.write throws, no uncaught exception", async () => {
    const writeSpy = vi.fn().mockRejectedValue(new Error("Milvus connection lost"));
    const tool = createMemoryWriteTool({
      getManager: () => ({ write: writeSpy }),
    });

    const [, params] = makeArgs({ text: "Crash test", label: "user_manual" });
    const result = await tool.execute("call-1", params, undefined);
    const payload = parseResult(result);

    expect(payload.error).toBe("Milvus connection lost");
  });

  // ── user_manual label ────────────────────────────────────────

  it("user_manual label writes successfully", async () => {
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

  // ── Ensure built-in result fields are not overwritten ────────

  it("result structure contains no extra fields", async () => {
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
