/** `memory_write` tool for the Milvus backend. */

import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { assertValidSourceLabel, MEMORY_SOURCE_LABELS, type MemorySourceLabel } from "./types.js";

/** Public payload returned by memory_write. */
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

// ── Factory ────────────────────────────────────────────────────────

export interface MemoryWriteToolDeps {
  getManager: () => { write(entry: { text: string; provenance?: { label?: string } }): Promise<{ id: string; provenance?: { label?: string } }> } | null;
}

/**
 * Create the memory_write tool.
 * Uses a closure over getManager to avoid circular imports.
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
