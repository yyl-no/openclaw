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
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
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
  const search = (raw.search as Record<string, unknown>) ?? {};
  const index = (raw.index as Record<string, unknown>) ?? {};

  return {
    host: String(milvus.host ?? "localhost"),
    port: Number(milvus.port ?? 19530) || 19530,
    collectionName: String(milvus.collectionName ?? DEFAULT_COLLECTION_NAME),
    token: milvus.token != null ? String(milvus.token) : undefined,
    username: milvus.username != null ? String(milvus.username) : undefined,
    password: milvus.password != null ? String(milvus.password) : undefined,
    ssl: milvus.ssl === true || milvus.ssl === "true",
    database: milvus.database != null ? String(milvus.database) : undefined,
    embedding: {
      provider: String(embedding.provider ?? "auto"),
      model: String(embedding.model ?? "text-embedding-v3"),
      dimensions: embedding.dimensions != null ? Number(embedding.dimensions) : undefined,
    },
    search: {
      vectorWeight: search.vectorWeight != null ? Number(search.vectorWeight) : undefined,
      textWeight: search.textWeight != null ? Number(search.textWeight) : undefined,
      useBM25: search.useBM25 === true || search.useBM25 === "true",
    },
    index: {
      metricType: index.metricType != null ? String(index.metricType) : undefined,
      hnswM: index.hnswM != null ? Number(index.hnswM) : undefined,
      efConstruction: index.efConstruction != null ? Number(index.efConstruction) : undefined,
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

// ── Manager Pool ───────────────────────────────────────────────────

interface ManagerPoolEntry {
  identityKey: string;
  manager: MilvusSearchManager;
}

/** scope-keyed cache of live MilvusSearchManager instances. Key: normalized agentId. */
const managerPool = new Map<string, ManagerPoolEntry>();

/**
 * Pending creates indexed by scopeKey to deduplicate concurrent first-time
 * lookups. Without this, dreaming cron + a user-triggered memory_search hitting
 * lazy-init at the same time would build two managers, leak one connection,
 * and bootstrap the collection twice.
 */
const pendingCreates = new Map<string, Promise<ManagerPoolEntry | null>>();

function normalizeAgentId(agentId: string | undefined | null): string {
  const trimmed = (agentId ?? "").trim();
  return trimmed || "main";
}

function buildScopeKey(agentId: string): string {
  return normalizeAgentId(agentId);
}

/**
 * identityKey covers all dimensions that should trigger manager rebuild when
 * changed: target Milvus instance + collection + embedding configuration.
 * Index parameters (efConstruction etc.) are intentionally excluded — they
 * should be migrated through `openclaw doctor --fix` rather than auto-rebuild.
 */
function buildIdentityKey(searchCfg: MilvusSearchConfig, agentId: string): string {
  return [
    normalizeAgentId(agentId),
    searchCfg.host,
    searchCfg.port,
    searchCfg.collectionName,
    searchCfg.embedding.provider,
    searchCfg.embedding.model,
    searchCfg.embedding.dimensions ?? "default",
  ].join("|");
}

async function buildMilvusManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  searchCfg: MilvusSearchConfig;
}): Promise<MilvusSearchManager> {
  const { cfg, agentId, searchCfg } = params;
  let degraded = false;

  const client = createMilvusClient(searchCfg);

  // Eager init: ensure the collection is ready (degrade on failure, do not throw)
  try {
    await ensureCollectionReady(client, {
      collectionName: searchCfg.collectionName,
      embeddingDim: searchCfg.embedding.dimensions ?? 1024,
      metricType: searchCfg.index?.metricType,
      hnswM: searchCfg.index?.hnswM,
      efConstruction: searchCfg.index?.efConstruction,
    });
  } catch (bootstrapErr) {
    console.warn(
      "[memory-milvus] Collection bootstrap failed, operating in degraded mode:",
      (bootstrapErr as Error).message ?? bootstrapErr,
    );
    degraded = true;
  }

  const provider = await createEmbeddingProvider(
    cfg,
    agentId,
    searchCfg.embedding.provider,
    searchCfg.embedding.model,
    searchCfg.embedding.dimensions,
  );

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return new MilvusSearchManager(
    client,
    searchCfg.collectionName,
    provider,
    agentId,
    searchCfg,
    workspaceDir,
    { degraded },
  );
}

// ── Runtime ────────────────────────────────────────────────────────

const milvusRuntime: MemoryPluginRuntime = {
  async getMemorySearchManager(params) {
    const { cfg, agentId } = params;

    const rawConfig = readPluginConfig(cfg);
    if (!rawConfig) {
      return {
        manager: null,
        error:
          'memory-milvus plugin config not found. Set plugins.entries["memory-milvus"].config in openclaw config.',
      };
    }

    let searchCfg: MilvusSearchConfig;
    try {
      searchCfg = parseMilvusConfig(rawConfig);
    } catch (err) {
      return {
        manager: null,
        error: `Failed to parse memory-milvus plugin config: ${(err as Error).message}`,
      };
    }

    const scopeKey = buildScopeKey(agentId);
    const identityKey = buildIdentityKey(searchCfg, agentId);

    // (1) Cache hit: same scope, same identity → reuse
    const cached = managerPool.get(scopeKey);
    if (cached && cached.identityKey === identityKey) {
      return { manager: cached.manager };
    }

    // (2) Identity changed (host/collection/embedding swap): evict & close old
    if (cached && cached.identityKey !== identityKey) {
      managerPool.delete(scopeKey);
      await cached.manager.close().catch(() => {});
    }

    // (3) Pending dedup: another caller is already building for this scope
    const pending = pendingCreates.get(scopeKey);
    if (pending) {
      const entry = await pending.catch(() => null);
      if (entry && entry.identityKey === identityKey) {
        return { manager: entry.manager };
      }
      // Pending finished with a different identity or failed — fall through
    }

    // (4) Build new manager; expose the in-flight promise so concurrent callers wait
    const createPromise: Promise<ManagerPoolEntry | null> = (async () => {
      const manager = await buildMilvusManager({ cfg, agentId, searchCfg });
      const entry: ManagerPoolEntry = { identityKey, manager };
      managerPool.set(scopeKey, entry);
      return entry;
    })();

    pendingCreates.set(scopeKey, createPromise);
    try {
      const entry = await createPromise;
      return entry
        ? { manager: entry.manager }
        : { manager: null, error: "Failed to initialize Milvus search manager: unknown error" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { manager: null, error: `Failed to initialize Milvus search manager: ${message}` };
    } finally {
      pendingCreates.delete(scopeKey);
    }
  },

  resolveMemoryBackendConfig(_params) {
    return { backend: "milvus" };
  },

  async closeAllMemorySearchManagers() {
    // Snapshot then clear so concurrent getMemorySearchManager calls rebuild fresh.
    const entries = Array.from(managerPool.values());
    managerPool.clear();
    await Promise.allSettled(entries.map((entry) => entry.manager.close()));
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

    // Per-tool-call manager resolver: pool ensures correct scope (agentId+identity).
    function makeGetManager(ctx: OpenClawPluginToolContext) {
      return async (): Promise<MilvusSearchManager | null> => {
        const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
        if (!cfg) return null;
        const agentId = ctx.agentId ?? "main";
        const result = await milvusRuntime.getMemorySearchManager({ cfg, agentId });
        return (result.manager as MilvusSearchManager | null) ?? null;
      };
    }

    // memory_write tool: called by AI flush turn, delegates to manager.write()
    api.registerTool(
      (ctx: OpenClawPluginToolContext) =>
        createMemoryWriteTool({ getManager: makeGetManager(ctx) }),
      { names: ["memory_write"] },
    );

    // memory_search tool: Milvus ANN + BM25 hybrid search
    api.registerTool(
      (ctx: OpenClawPluginToolContext) => {
        const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
        return createMemorySearchTool({
          getManager: makeGetManager(ctx),
          cfg,
          agentSessionKey: ctx.sessionKey,
          sandboxed: ctx.sandboxed,
        });
      },
      { names: ["memory_search"] },
    );

    // memory_get tool: PK lookup → MemoryEntry
    api.registerTool(
      (ctx: OpenClawPluginToolContext) => createMemoryGetTool({ getManager: makeGetManager(ctx) }),
      { names: ["memory_get"] },
    );

    // Dreaming orchestration — Manager Pool already handles cache / identity
    // changes / concurrent first-time creates, so the resolver is a thin wrapper.
    setDreamingManagerResolver(async (cfg: OpenClawConfig, agentId: string) => {
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
