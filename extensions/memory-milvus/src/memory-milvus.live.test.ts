/**
 * memory-milvus live end-to-end tests
 *
 * CI auto-run is disabled. Prerequisites:
 * 1. Local Milvus running (`docker run -d -p 19530:19530 milvusdb/milvus:v2.4.0 standalone`)
 * 2. Set embedding API key (OPENAI_API_KEY or corresponding provider env var)
 *
 * Run: OPENCLAW_LIVE_TEST=1 pnpm test:live extensions/memory-milvus
 */

import { describe, expect, it } from "vitest";
import { getMemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { ensureCollectionReady } from "./collection-bootstrap.js";
import { DEFAULT_COLLECTION_NAME } from "./schema.js";
import { createMilvusClient, MilvusSearchManager } from "./search.js";
import { MEMORY_TYPES } from "./types.js";

const LIVE_HOST = process.env.OPENCLAW_MILVUS_HOST ?? "localhost";
const LIVE_PORT = Number(process.env.OPENCLAW_MILVUS_PORT ?? 19530);
const LIVE_EMBEDDING_PROVIDER = process.env.OPENCLAW_MILVUS_EMBED_PROVIDER ?? "openai";
const LIVE_EMBEDDING_MODEL = process.env.OPENCLAW_MILVUS_EMBED_MODEL ?? "text-embedding-3-small";

const describeLive = describe.skipIf(process.env.OPENCLAW_LIVE_TEST !== "1");

/** Build a minimal OpenClawConfig for live tests. */
function makeLiveConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: ".openclaw/workspace",
      },
    },
  };
}

async function createLiveManager(client: ReturnType<typeof createMilvusClient>) {
  const cfg = makeLiveConfig();
  const adapter = getMemoryEmbeddingProvider(LIVE_EMBEDDING_PROVIDER, cfg);
  if (!adapter) {
    throw new Error(
      `Embedding provider "${LIVE_EMBEDDING_PROVIDER}" not registered. ` +
        `Set OPENCLAW_MILVUS_EMBED_PROVIDER or ensure the provider plugin is loaded.`,
    );
  }
  const agentDir = resolveAgentWorkspaceDir(cfg, "live-test-agent");
  const result = await adapter.create({
    config: cfg,
    agentDir,
    provider: LIVE_EMBEDDING_PROVIDER,
    fallback: "none",
    model: LIVE_EMBEDDING_MODEL,
  });
  if (!result.provider) {
    throw new Error(`Embedding provider "${LIVE_EMBEDDING_PROVIDER}" is unavailable.`);
  }

  return new MilvusSearchManager(
    client,
    DEFAULT_COLLECTION_NAME,
    result.provider,
    "live-test-agent",
    {
      host: LIVE_HOST,
      port: LIVE_PORT,
      collectionName: DEFAULT_COLLECTION_NAME,
      embedding: {
        provider: LIVE_EMBEDDING_PROVIDER,
        model: LIVE_EMBEDDING_MODEL,
        dimensions: 1536,
      },
    },
    agentDir,
    { degraded: false },
  );
}

describeLive("memory-milvus live E2E", () => {
  it("write → writes a memory entry and asserts return value", async () => {
    const client = createMilvusClient(LIVE_HOST, LIVE_PORT);
    await ensureCollectionReady(client, {
      collectionName: DEFAULT_COLLECTION_NAME,
      embeddingDim: 1536,
    });

    const manager = await createLiveManager(client);

    try {
      const ref = await manager.write({
        text: "Live E2E test: the sky is blue.",
        provenance: { kind: "milvus", label: "chat_extract" },
      });

      expect(ref.id).toBeTruthy();
      expect(ref.provenance.kind).toBe("milvus");
    } finally {
      await manager.close();
    }
  });

  it("write → search hit → recordRecall accumulates", async () => {
    const client = createMilvusClient(LIVE_HOST, LIVE_PORT);
    await ensureCollectionReady(client, {
      collectionName: DEFAULT_COLLECTION_NAME,
      embeddingDim: 1536,
    });

    const manager = await createLiveManager(client);

    try {
      // 1. Write unique content
      const uniqueText = `Live E2E recall test: ${Date.now()} - ${Math.random().toString(36).slice(2)}`;
      const ref = await manager.write({
        text: uniqueText,
        provenance: { kind: "milvus", label: "chat_extract" },
      });
      expect(ref.id).toBeTruthy();

      // 2. Search for it
      const results = await manager.search(uniqueText, { maxResults: 5 });
      const found = results.find((r) => r.id === ref.id);
      expect(found).toBeTruthy();

      // 3. Record recall
      if (found) {
        await manager.recordRecall([found], {
          query: uniqueText,
        });
      }

      // 4. Verify recall_count incremented
      const entry = await manager.get(ref.id);
      expect(entry.recallCount).toBeGreaterThanOrEqual(1);
    } finally {
      await manager.close();
    }
  });

  it("promotion full pipeline: rank → apply → new long_term + original archived", async () => {
    const client = createMilvusClient(LIVE_HOST, LIVE_PORT);
    await ensureCollectionReady(client, {
      collectionName: DEFAULT_COLLECTION_NAME,
      embeddingDim: 1536,
    });

    const manager = await createLiveManager(client);

    try {
      // 1. Write a short_term memory with high recall_count
      const uniqueText = `Live E2E promotion: ${Date.now()}`;
      const ref = await manager.write({
        text: uniqueText,
        memoryType: "short_term",
        provenance: { kind: "milvus", label: "chat_extract" },
      });
      expect(ref.id).toBeTruthy();

      // 2. Simulate multiple recalls (build up recall_count)
      await manager.recordRecall(
        [{ ...ref, snippet: uniqueText.slice(0, 200), score: 0.8 }],
        { query: "promotion test" },
      );
      await manager.recordRecall(
        [{ ...ref, snippet: uniqueText.slice(0, 200), score: 0.8 }],
        { query: "promotion test" },
      );
      await manager.recordRecall(
        [{ ...ref, snippet: uniqueText.slice(0, 200), score: 0.8 }],
        { query: "promotion test" },
      );

      // 3. Rank candidates
      const candidates = await manager.rankPromotionCandidates({
        minRecallCount: 1,
      });
      const target = candidates.find((c) => c.id === ref.id);
      expect(target).toBeTruthy();
      expect(target!.recallCount).toBeGreaterThanOrEqual(3);

      // 4. Apply promotion
      if (target) {
        const result = await manager.applyPromotions({
          candidates: [target],
        });
        expect(result.applied).toBe(1);
        expect(result.appliedCandidates[0]!.id).toBe(ref.id);
      }

      // 5. Verify original is now archived
      const archivedEntry = await manager.get(ref.id);
      expect(archivedEntry.memoryType).toBe(MEMORY_TYPES.ARCHIVED);

      // 6. Verify new long_term entry exists (search for it)
      const longTermResults = await manager.search(uniqueText, {
        memoryType: MEMORY_TYPES.LONG_TERM,
        maxResults: 5,
      });
      const longTermFound = longTermResults.find(
        (r) => r.provenance.label === "recall_promotion",
      );
      expect(longTermFound).toBeTruthy();
    } finally {
      await manager.close();
    }
  });

  it("get → reads full MemoryEntry by id", async () => {
    const client = createMilvusClient(LIVE_HOST, LIVE_PORT);
    await ensureCollectionReady(client, {
      collectionName: DEFAULT_COLLECTION_NAME,
      embeddingDim: 1536,
    });

    const manager = await createLiveManager(client);

    try {
      const ref = await manager.write({
        text: "Live E2E get test content",
        snippet: "get test snippet",
        memoryType: "short_term",
        provenance: { kind: "milvus", label: "chat_extract" },
      });

      const entry = await manager.get(ref.id);
      expect(entry.id).toBe(ref.id);
      expect(entry.text).toBe("Live E2E get test content");
      expect(entry.snippet).toBe("get test snippet");
      expect(entry.memoryType).toBe(MEMORY_TYPES.SHORT_TERM);
      expect(entry.provenance.kind).toBe("milvus");
      expect(entry.agentId).toBe("live-test-agent");
    } finally {
      await manager.close();
    }
  });
});
