/**
 * memory-milvus 工具注册
 *
 * 依据：1-plan.md §S5 + 2-decisions.md §12.3/12.9
 *
 * memory_write 工具：将 AI flush turn 提取的记忆写入 Milvus。
 * 统一走 MemorySearchManager.write()，degraded/健康探测失败/fatal → fallback 兜底。
 */

import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { assertValidSourceLabel, MEMORY_SOURCE_LABELS, type MemorySourceLabel } from "./types.js";

/** 工具返回的公开 payload 类型 */
export interface MemoryWriteResult {
  id: string;
  label: MemorySourceLabel;
}

const MEMORY_WRITE_DESCRIPTION =
  "Write a memory entry extracted from the conversation. " +
  "Use this to persist facts, decisions, preferences, and learnings. " +
  "Each entry is stored in Milvus with a numeric id, text content, and metadata.";

const MEMORY_WRITE_SCHEMA = {
  type: "object" as const,
  properties: {
    text: {
      type: "string" as const,
      description: "The memory text to persist as a standalone, self-contained entry.",
    },
    label: {
      type: "string" as const,
      enum: Object.values(MEMORY_SOURCE_LABELS) as readonly string[],
      description:
        "Source label for the memory. Defaults to chat_extract for AI-flushed memories.",
      default: MEMORY_SOURCE_LABELS.CHAT_EXTRACT,
    },
  },
  required: ["text"],
};

// ── 工厂 ──────────────────────────────────────────────────────────

export interface MemoryWriteToolDeps {
  /** 获取当前活跃的 search manager（可能为 null，如插件未初始化完成） */
  getManager: () => { write(entry: { text: string; provenance?: { label?: string } }): Promise<{ id: string; provenance?: { label?: string } }> } | null;
}

/**
 * 创建 memory_write 工具。
 *
 * 工具通过闭包持有 getManager 引用，避免循环导入。
 * 管理器未初始化时返回明确错误，不抛异常。
 */
export function createMemoryWriteTool(deps: MemoryWriteToolDeps): AnyAgentTool {
  return {
    name: "memory_write",
    label: "memory_write",
    description: MEMORY_WRITE_DESCRIPTION,
    parameters: MEMORY_WRITE_SCHEMA,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as Record<string, unknown>;
      const text = typeof params.text === "string" ? params.text.trim() : "";
      if (!text) {
        return jsonResult({ error: "text is required and must be a non-empty string" });
      }

      const rawLabel = typeof params.label === "string" ? params.label : undefined;
      const label: string = rawLabel ?? MEMORY_SOURCE_LABELS.CHAT_EXTRACT;

      try {
        assertValidSourceLabel(label);
      } catch (err) {
        return jsonResult({ error: (err as Error).message });
      }

      const manager = deps.getManager();
      if (!manager) {
        return jsonResult({
          error:
            "Milvus search manager is not initialized. Ensure the memory-milvus plugin is configured and the Milvus server is reachable.",
        });
      }

      try {
        const ref = await manager.write({
          text,
          provenance: { label },
        });
        const result: MemoryWriteResult = {
          id: ref.id,
          label: (ref.provenance?.label ?? label) as MemorySourceLabel,
        };
        return jsonResult(result);
      } catch (err) {
        return jsonResult({ error: (err as Error).message });
      }
    },
  };
}
