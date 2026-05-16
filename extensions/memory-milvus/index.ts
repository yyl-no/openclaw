/**
 * memory-milvus plugin entry.
 *
 * Registers a MemoryPluginCapability isomorphic with memory-core.
 * Switching backends is a single config change: plugins.slots.memory.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerBuiltInMemoryEmbeddingProviders } from "openclaw/plugin-sdk/memory-core-bundled-runtime";
import {
  getMemoryEmbeddingProvider,
  type MemoryEmbeddingProvider,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  type MemoryFlushPlan,
  type MemoryPluginRuntime,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { ensureCollectionReady } from "./src/collection-bootstrap.js";
import { setDreamingManagerResolver, registerShortTermPromotionDreaming } from "./src/dreaming.js";
import { DEFAULT_COLLECTION_NAME } from "./src/schema.js";
import { MilvusSearchManager, createMilvusClient, type MilvusSearchConfig } from "./src/search.js";
import { createMemoryGetTool } from "./src/tools.get.js";
import { createMemoryWriteTool } from "./src/tools.js";
import { createMemorySearchTool } from "./src/tools.search.js";

// ── Prompt Builder ─────────────────────────────────────────────────

/**
 * Build the system prompt section describing Milvus memory tools.
 */
function buildPromptSection(params: { availableTools: Set<string> }): string[] {
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
      dimensions: embedding.dimensions != null ? Number(embedding.dimensions) : undefined,
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
      `Unknown memory embedding provider: ${providerId}. Known providers: ${[
        "auto",
        "local",
        "alibaba",
        "openai",
      ]
        .map((id) => (getMemoryEmbeddingProvider(id, cfg) ? id : null))
        .filter(Boolean)
        .join(", ")}`,
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

/** Hold the active search manager reference for closeAllMemorySearchManagers. */
let activeManager: MilvusSearchManager | null = null;

const milvusRuntime: MemoryPluginRuntime = {
  async getMemorySearchManager(params) {
    const { cfg, agentId } = params;

    let degraded = false;

    try {
      // Read plugin config
      const rawConfig = readPluginConfig(cfg);
      if (!rawConfig) {
        return {
          manager: null,
          error:
            'memory-milvus plugin config not found. Set plugins.entries["memory-milvus"].config in openclaw config.',
        };
      }

      const searchCfg = parseMilvusConfig(rawConfig);

      // Create Milvus client
      const client = createMilvusClient(searchCfg.host, searchCfg.port);

      // Eager init: ensure the collection is ready
      try {
        await ensureCollectionReady(client, {
          collectionName: searchCfg.collectionName,
          embeddingDim: searchCfg.embedding.dimensions ?? 1024,
        });
      } catch (bootstrapErr) {
        // Unreachable / collection create failed → warn + degraded, do not block plugin init
        console.warn(
          "[memory-milvus] Collection bootstrap failed, operating in degraded mode:",
          (bootstrapErr as Error).message ?? bootstrapErr,
        );
        degraded = true;
      }

      // Create embedding provider
      const provider = await createEmbeddingProvider(
        cfg,
        agentId,
        searchCfg.embedding.provider,
        searchCfg.embedding.model,
        searchCfg.embedding.dimensions,
      );

      // Create search manager
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

      // Hold reference for later close
      activeManager = manager;

      return { manager };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { manager: null, error: `Failed to initialize Milvus search manager: ${message}` };
    }
  },

  resolveMemoryBackendConfig(_params) {
    return { backend: "milvus" };
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
    // Self-register built-in embedding providers (auto/local/openai etc.).
    // This avoids depending on memory-core load order — when the memory slot
    // points to memory-milvus, memory-core is not loaded.
    registerBuiltInMemoryEmbeddingProviders(api);

    api.registerMemoryCapability({
      promptBuilder: buildPromptSection,
      flushPlanResolver: buildMilvusFlushPlan,
      runtime: milvusRuntime,
      writeToolNames: ["memory_write"],
    });

    // memory_write tool: called by AI flush turn, delegates to manager.write()
    api.registerTool(() => createMemoryWriteTool({ getManager: () => activeManager }), {
      names: ["memory_write"],
    });

    // memory_search tool: Milvus ANN + BM25 hybrid search
    api.registerTool(() => createMemorySearchTool({ getManager: () => activeManager }), {
      names: ["memory_search"],
    });

    // memory_get tool: PK lookup → MemoryEntry
    api.registerTool(() => createMemoryGetTool({ getManager: () => activeManager }), {
      names: ["memory_get"],
    });

    // Dreaming orchestration — lazy-init factory resolver.
    // When activeManager is null or degraded, creates one via
    // milvusRuntime.getMemorySearchManager() on demand. This
    // avoids cron-isolated sessions failing because activeManager
    // was not initialized.
    setDreamingManagerResolver(async (cfg: OpenClawConfig, agentId: string) => {
      if (activeManager && !activeManager.degraded) return activeManager;
      const result = await milvusRuntime.getMemorySearchManager({ cfg, agentId });
      if (!result.manager && result.error) {
        api.logger.warn(`memory-milvus: dreaming manager lazy-init failed: ${result.error}`);
      }
      return result.manager as MilvusSearchManager | null;
    });
    registerShortTermPromotionDreaming(api);

    // CLI: memory-migrate <dir> [--reverse] [--dry-run]
    // Standalone command registration (no parentPath), independent of memory-core CLI
    api.registerCli(
      async ({ program, config }) => {
        const { registerMigrationCli } = await import("./src/migrate.js");
        registerMigrationCli(program, config);
      },
      {
        descriptors: [
          {
            name: "memory-migrate",
            description: "Migrate memory files between Markdown and Milvus",
            hasSubcommands: false,
          },
        ],
      },
    );
  },
});
