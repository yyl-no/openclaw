# 重构执行进度

> 每完成一个 Task 更新。

---

## 第一部分：接口抽象重构

### Task 1: 梳理 memory-core 职责分布 ✅ 完成

**日期**：2026-05-11

**产出**：
- SDK 层：`MemorySearchManager` 接口（search/readFile/status/close），`MemorySearchResult`/`MemoryReadResult` 类型
- 实现层：`MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager`（manager.ts 938行）
- 工具层：`memory_search`（调 manager.search + recordShortTermRecalls），`memory_get`（调 manager.readFile）
- Flush 链路：`buildMemoryFlushPlan() → relativePath → pi-tools.ts → wrapToolMemoryFlushAppendOnlyWrite`
- Recall/Promotion/Dreaming：`queueShortTermRecallTracking → recordShortTermRecalls → short-term-recall.json → dreaming cron → applyShortTermPromotions`
- 外部调用方：`memory-state.ts`（类型+注册）、`pi-tools.ts`（flush包装）、`agent-runner-memory.ts`（flush触发）
- 插件注册：`memory-core/index.ts` → `registerMemoryCapability({ promptBuilder, flushPlanResolver, runtime })`

**涉及文件**：8个，分布在 SDK 包、memory-core 扩展、src 核心代码三层

---

### Task 2: 提取通用记忆概念 ✅ 完成

**日期**：2026-05-11

**依据**：`2-decisions.md` §2～3

① `MemorySearchResult` → `MemoryReference`
- 删除：path, startLine, endLine, source, citation
- 新增：id（"file:memory/05-11.md:20:25" 或 Milvus PK）, provenance（{ kind, label }）
- 保留：snippet, score, vectorScore, textScore

② `MemoryReadResult` → `MemoryEntry`（干净版，不分页）
- 删除：path, from, lines, nextFrom, truncated
- 新增：id, agentId, sessionKey, memoryType, provenance
- 保留：text

③ `MemoryFlushPlan` 扩展
- relativePath 改为 optional
- 新增 backendKind?: "file" | "milvus"

---

### Task 3: 演化 MemorySearchManager → MemoryBackend ✅ 完成

**日期**：2026-05-11

**依据**：`1-plan.md` §Task3 + `2-decisions.md` §2

| 旧方法 | 新方法 | 变化 |
|--------|--------|------|
| search() → MemorySearchResult[] | search() → MemoryReference[] | 返回类型改名 |
| readFile({ relPath, from, lines }) | get(id: string) | path+line → id |
| — | write(entry) | 从 flush-plan 收敛 |
| — | recordRecall(ids: string[]) | 从 short-term-promotion 收敛 |
| — | promote(ids: string[]) | 从 dreaming 收敛 |
| status/sync/close | 保留 | 不变 |

---

### Task 4: 重构 memory-core 实现 MemoryBackend ✅ 完成

**日期**：2026-05-11

**依据**：`1-plan.md` §Task4 + `2-decisions.md` §2～5

**改动文件及内容**：

1. `packages/memory-host-sdk/.../types.ts` — 新增 `MemoryBackend`、`MemoryReference`、`MemoryEntry` 类型，旧类型标记 `@deprecated`
2. `engine-storage.ts` / `runtime-files.ts` — 导出新类型
3. `manager.ts` — `implements MemoryBackend`，`search()` 返回 `MemoryReference[]`，新增 `get(id)`/`write()`/`recordRecall()`/`promote()` 
4. `tools.shared.ts` — `MemoryGetSchema` 加 `id` 字段，`path` 改为 optional
5. `tools.ts` — `memory_get` 处理 `id` 参数（解析为 path+line）
6. `memory-state.ts` — `MemoryFlushPlan` 的 `relativePath` 改为 optional，加 `backendKind`
7. `flush-plan.ts` — 返回值加 `backendKind: "file"`
8. `short-term-promotion.ts` — `ShortTermRecallEntry` 删 path/startLine/endLine，`buildEntryKey` 返回 id，`recordShortTermRecalls` 接受 `MemoryReference[]`
9. `dreaming-phases.ts` — chunk 结果增加 `id` + `provenance` 字段

**注意**：`tools.ts` 中 `memory_search` 的处理逻辑仍引用 `MemorySearchResult` 类型，Task 5 将完成语义迁移。

---

## 第二部分：memory-milvus 实现

尚未开始。
