/**
 * memory-milvus 插件入口
 *
 * 依据：1-plan.md §Task8 + 2-decisions.md §6-9
 *
 * 与 memory-core 同构注册 MemoryPluginCapability，
 * 上层仅通过 plugins.slots.memory 切换即可完成互斥替换。
 */

import {
  type MemoryFlushPlan,
  type MemoryPluginRuntime,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_COLLECTION_NAME } from "./src/schema.js";

// ── Prompt Builder ─────────────────────────────────────────────────

/**
 * 构建系统提示词中的记忆说明区段。
 * 告知 AI 使用 memory_search / memory_get 工具，Milvus 后端使用数字 id。
 */
function buildPromptSection(params: {
  availableTools: Set<string>;
}): string[] {
  const tools: string[] = [];
  if (params.availableTools.has("memory_search")) tools.push("memory_search");
  if (params.availableTools.has("memory_get")) tools.push("memory_get");

  if (tools.length === 0) return [];

  return [
    "## Memory (Milvus)",
    "",
    `Your memory is stored in a Milvus vector database (collection: ${DEFAULT_COLLECTION_NAME}).`,
    "Each memory has a unique numeric id, text content, and metadata (agent, session, type, recall_count).",
    "",
    "- Use `memory_search` for semantic search across all indexed memories.",
    "- Use `memory_get` with a numeric id to read the full content of a specific memory entry.",
    "- Memory entries can be `short_term`, `long_term`, or `archived`.",
  ];
}

// ── Flush Plan Resolver ────────────────────────────────────────────

function buildMilvusFlushPlan(): MemoryFlushPlan {
  return {
    softThresholdTokens: 4096,
    forceFlushTranscriptBytes: 64_000,
    reserveTokensFloor: 1024,
    prompt:
      "Extract standalone memories from this conversation. Write each memory using `memory_write`.",
    systemPrompt:
      "You are a memory extraction assistant. Identify facts, decisions, preferences, and learnings that should be persisted.",
    backendKind: "milvus",
  };
}

// ── Runtime ────────────────────────────────────────────────────────

const milvusRuntime: MemoryPluginRuntime = {
  async getMemorySearchManager(_params) {
    // Task 9 实现
    return { manager: null, error: "Milvus search manager not yet implemented" };
  },
  resolveMemoryBackendConfig(_params) {
    return { backend: "builtin" };
  },
};

// ── Plugin Entry ──────────────────────────────────────────────────

export default definePluginEntry({
  id: "memory-milvus",
  name: "Memory (Milvus)",
  description: "Milvus-backed memory search tools with vector ANN + BM25 hybrid search",
  kind: "memory",
  register(api: OpenClawPluginApi) {
    api.registerMemoryCapability({
      promptBuilder: buildPromptSection,
      flushPlanResolver: buildMilvusFlushPlan,
      runtime: milvusRuntime,
    });

    // memory_search / memory_get 工具由 Task 11 注册
  },
});
