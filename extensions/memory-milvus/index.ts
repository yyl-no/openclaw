/**
 * memory-milvus 插件入口
 *
 * 依据：1-plan.md §Task8-9 + 2-decisions.md §6-9
 *
 * 与 memory-core 同构注册 MemoryPluginCapability，
 * 上层仅通过 plugins.slots.memory 切换即可完成互斥替换。
 */

import {
  type MemoryFlushPlan,
  type MemoryPluginRuntime,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getMemoryEmbeddingProvider,
  type MemoryEmbeddingProvider,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_COLLECTION_NAME } from "./src/schema.js";
import {
  MilvusSearchManager,
  createMilvusClient,
  type MilvusSearchConfig,
} from "./src/search.js";
import { ensureCollectionReady } from "./src/collection-bootstrap.js";
import { createMemoryWriteTool } from "./src/tools.js";

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
  if (params.availableTools.has("memory_write")) tools.push("memory_write");

  if (tools.length === 0) return [];

  return [
    "## Memory (Milvus)",
    "",
    `Your memory is stored in a Milvus vector database (collection: ${DEFAULT_COLLECTION_NAME}).`,
    "Each memory has a unique numeric id, text content, and metadata (agent, session, type, recall_count).",
    "",
    "- Use `memory_search` for semantic search across all indexed memories.",
    "- Use `memory_get` with a numeric id to read the full content of a specific memory entry.",
    "- Use `memory_write` to persist extracted memories with a text and optional source label.",
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

// ── Config Helpers ──────────────────────────────────────────────────

function readPluginConfig(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  const pluginEntry = cfg.plugins?.entries?.["memory-milvus"];
  if (!pluginEntry || typeof pluginEntry !== "object") return undefined;
  const config = (pluginEntry as Record<string, unknown>).config;
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : undefined;
}

function parseMilvusConfig(raw: Record<string, unknown>): MilvusSearchConfig {
  const milvus = (raw.milvus as Record<string, unknown>) ?? {};
  const embedding = (raw.embedding as Record<string, unknown>) ?? {};

  return {
    host: String(milvus.host ?? "localhost"),
    port: Number(milvus.port ?? 19530) || 19530,
    collectionName: String(milvus.collectionName ?? DEFAULT_COLLECTION_NAME),
    embedding: {
      provider: String(embedding.provider ?? "auto"),
      model: String(embedding.model ?? "text-embedding-v3"),
      dimensions:
        embedding.dimensions != null ? Number(embedding.dimensions) : undefined,
    },
  };
}

// ── Embedding Provider ─────────────────────────────────────────────

async function createEmbeddingProvider(
  cfg: OpenClawConfig,
  agentId: string,
  providerId: string,
  model: string,
  dimensions?: number,
): Promise<MemoryEmbeddingProvider> {
  const adapter = getMemoryEmbeddingProvider(providerId, cfg);
  if (!adapter) {
    throw new Error(
      `Unknown memory embedding provider: ${providerId}. Known providers: ${
        ["auto", "local", "alibaba", "openai"]
          .map((id) => (getMemoryEmbeddingProvider(id, cfg) ? id : null))
          .filter(Boolean)
          .join(", ")
      }`,
    );
  }

  const agentDir = resolveAgentWorkspaceDir(cfg, agentId);

  const result = await adapter.create({
    config: cfg,
    agentDir,
    provider: providerId,
    fallback: "none",
    model,
    ...(dimensions ? { outputDimensionality: dimensions } : {}),
  });

  if (!result.provider) {
    throw new Error(`Memory embedding provider ${providerId} is unavailable.`);
  }

  return result.provider;
}

// ── Runtime ────────────────────────────────────────────────────────

/** 持有活跃的 search manager 实例，用于 closeAllMemorySearchManagers */
let activeManager: MilvusSearchManager | null = null;

const milvusRuntime: MemoryPluginRuntime = {
  async getMemorySearchManager(params) {
    const { cfg, agentId } = params;

    let degraded = false;

    try {
      // 读取插件配置
      const rawConfig = readPluginConfig(cfg);
      if (!rawConfig) {
        return {
          manager: null,
          error:
            "memory-milvus plugin config not found. Set plugins.entries[\"memory-milvus\"].config in openclaw config.",
        };
      }

      const searchCfg = parseMilvusConfig(rawConfig);

      // 创建 Milvus 客户端
      const client = createMilvusClient(searchCfg.host, searchCfg.port);

      // Eager init: 确保 Collection 就绪
      try {
        await ensureCollectionReady(client, {
          collectionName: searchCfg.collectionName,
          embeddingDim: searchCfg.embedding.dimensions ?? 1024,
        });
      } catch (bootstrapErr) {
        // 连不上 / collection 创建失败 → warn + degraded，不阻止插件启用
        console.warn(
          "[memory-milvus] Collection bootstrap failed, operating in degraded mode:",
          (bootstrapErr as Error).message ?? bootstrapErr,
        );
        degraded = true;
      }

      // 创建 Embedding Provider
      const provider = await createEmbeddingProvider(
        cfg,
        agentId,
        searchCfg.embedding.provider,
        searchCfg.embedding.model,
        searchCfg.embedding.dimensions,
      );

      // 创建搜索管理器
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const manager = new MilvusSearchManager(
        client,
        searchCfg.collectionName,
        provider,
        agentId,
        searchCfg,
        workspaceDir,
        { degraded },
      );

      // 持有引用用于后续关闭
      activeManager = manager;

      return { manager };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { manager: null, error: `Failed to initialize Milvus search manager: ${message}` };
    }
  },

  resolveMemoryBackendConfig(_params) {
    return { backend: "qmd" };
  },

  async closeAllMemorySearchManagers() {
    await activeManager?.close();
    activeManager = null;
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

    // memory_write 工具：AI flush turn 调此写入，内部走 Manager.write()
    api.registerTool(() => createMemoryWriteTool({ getManager: () => activeManager }), {
      names: ["memory_write"],
    });

    // memory_search / memory_get 工具由 Task 11 注册
  },
});
