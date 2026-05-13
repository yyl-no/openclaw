/**
 * memory-milvus live 端到端测试骨架
 *
 * 禁止 CI 自动运行，需要：
 * 1. 本地启动 Milvus（`docker run -d -p 19530:19530 milvusdb/milvus:v2.4.0 standalone`）
 * 2. 设置 embedding API key（OPENAI_API_KEY 或对应 provider 的环境变量）
 *
 * 运行：OPENCLAW_LIVE_TEST=1 pnpm test:live extensions/memory-milvus
 *
 * 完整 live 验证推迟到 Task 13（Alpha 退出条件）。
 */

import { describe, expect, it } from "vitest";
import { getMemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { ensureCollectionReady } from "./collection-bootstrap.js";
import { DEFAULT_COLLECTION_NAME } from "./schema.js";
import { createMilvusClient, MilvusSearchManager } from "./search.js";

const LIVE_HOST = process.env.OPENCLAW_MILVUS_HOST ?? "localhost";
const LIVE_PORT = Number(process.env.OPENCLAW_MILVUS_PORT ?? 19530);
const LIVE_EMBEDDING_PROVIDER = process.env.OPENCLAW_MILVUS_EMBED_PROVIDER ?? "openai";
const LIVE_EMBEDDING_MODEL = process.env.OPENCLAW_MILVUS_EMBED_MODEL ?? "text-embedding-3-small";

const describeLive = describe.skipIf(process.env.OPENCLAW_LIVE_TEST !== "1");

describeLive("memory-milvus live E2E", () => {
  it("write → memory_write → insert 一条记忆并断言返回值", async () => {
    // 1. 创建 Milvus 客户端
    const client = createMilvusClient(LIVE_HOST, LIVE_PORT);

    // 2. 确保 Collection 就绪
    await ensureCollectionReady(client, {
      collectionName: DEFAULT_COLLECTION_NAME,
      embeddingDim: 1536,
    });

    // 3. 创建 embedding provider
    const cfg = {} as any; // 真实 live 测试需构造 OpenClawConfig
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

    // 4. 创建 SearchManager
    const manager = new MilvusSearchManager(
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

    try {
      // 5. 写入一条记忆
      const ref = await manager.write({
        text: "Live E2E test: the sky is blue.",
        provenance: { kind: "milvus", label: "chat_extract" },
      });

      // 6. 断言返回合法
      expect(ref.id).toBeTruthy();
      expect(ref.provenance.kind).toBe("milvus");
    } finally {
      await manager.close();
    }
  });
});
