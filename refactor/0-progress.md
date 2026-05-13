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

### Task 3: 演化 MemorySearchManager → MemoryDataBackend ✅ 完成

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

### Task 4: 重构 memory-core 实现 MemoryDataBackend ✅ 完成

**日期**：2026-05-11

**依据**：`1-plan.md` §Task4 + `2-decisions.md` §2～5

**改动文件及内容**：

1. `packages/memory-host-sdk/.../types.ts` — 新增 `MemoryDataBackend`、`MemoryReference`、`MemoryEntry` 类型，旧类型标记 `@deprecated`
2. `engine-storage.ts` / `runtime-files.ts` — 导出新类型
3. `manager.ts` — `implements MemoryDataBackend`，`search()` 返回 `MemoryReference[]`，新增 `get(id)`/`write()`/`recordRecall()`/`promote()` 
4. `tools.shared.ts` — `MemoryGetSchema` 加 `id` 字段，`path` 改为 optional
5. `tools.ts` — `memory_get` 处理 `id` 参数（解析为 path+line）
6. `memory-state.ts` — `MemoryFlushPlan` 的 `relativePath` 改为 optional，加 `backendKind`
7. `flush-plan.ts` — 返回值加 `backendKind: "file"`
8. `short-term-promotion.ts` — `ShortTermRecallEntry` 删 path/startLine/endLine，`buildEntryKey` 返回 id，`recordShortTermRecalls` 接受 `MemoryReference[]`
9. `dreaming-phases.ts` — chunk 结果增加 `id` + `provenance` 字段

**注意**：`tools.ts` 中 `memory_search` 语义迁移由 Task 5 完成。

---

### Task 5: 改造 memory_search / memory_get 语义 ✅ 完成

**日期**：2026-05-11

**依据**：`1-plan.md` §Task5 + `2-decisions.md` §2

**改动**：
1. `tools.citations.ts` — `decorateCitations`/`clampResultsByInjectedChars` 改为泛型，`formatCitation` 优先使用 `provenance.label`，兼容旧的 `path/startLine/endLine`
2. `session-search-visibility.ts` — 接受 `MemoryReference | MemorySearchResult` 联合，`hitFilePath` 从 `id` 或 `path` 提取
3. `tools.ts` — `rawResults` → `MemoryReference[]`，`buildRecallKey` 支持 id，`resolveRecallTrackingResults` 泛型化，`queueShortTermRecallTracking` 接受 `MemoryReference[]`，`surfacedMemoryResults` 从 `provenance.label` 派生 `displayPath`

`promptBuilder` 暂不变动，memory-milvus 阶段根据后端类型调整。

---

### Task 6: 重构 flush 写入流程 ✅ 完成

**日期**：2026-05-11

**依据**：`1-plan.md` §Task6 + `2-decisions.md` §3

**改动**：
1. `pi-tools.ts` — 新增 `memoryFlushBackendKind` 选项；验证仅在非 milvus 时要求 `memoryFlushWritePath`；milvus 时跳过 `wrapToolMemoryFlushAppendOnlyWrite`（write 工具原生通过）；flush 时始终过滤工具白名单
2. `params.ts` — 新增 `memoryFlushBackendKind?: "file" | "milvus"`
3. `attempt.tool-run-context.ts` — 转发 `memoryFlushBackendKind`
4. `run.ts` — 转发 `memoryFlushBackendKind` 到 backend
5. `agent-runner-memory.ts` — 从 `activeMemoryFlushPlan.backendKind` 提取并传递

**编译**：tsdown 通过，仅预存路径空格 bug（`build:plugin-sdk:dts`）与本次无关。

---

### 修复: 接口命名冲突 → MemoryDataBackend ✅ 完成

**日期**：2026-05-12

**问题**：`engine.ts` 中 `export *` 同时从 `engine-foundation.ts`（config `MemoryBackend = "builtin" | "qmd"`）和 `engine-storage.ts`（新 interface `MemoryBackend`）导入，TS 编译器报 TS2308 命名歧义。

**决策**：不动 config 端（系统基础类型，引用广泛），仅将新 interface 重命名为 `MemoryDataBackend`。

**改动 5 个文件**：
- `types.ts` — interface `MemoryDataBackend`，deprecation 注释同步
- `engine-storage.ts` / `runtime-files.ts` — export type 改名
- `memory-core-host-engine-storage.ts` — re-export 改名
- `manager.ts` — `import type` + `implements` 改名

**同步文档**：`1-plan.md`（6处）、`2-decisions.md`（4处）、`0-progress.md`（4处）中接口引用全部更新。

**编译验证**：`tsconfig.plugin-sdk.dts.json` 通过，TS2308 消除。

---

### 补充任务 H-A: Task 3/4 遗留填充 ✅ 完成

**日期**：计划定稿 2026-05-12，A1 完成 2026-05-12

**背景**：Task 3/4 虽已标记 ✅ 完成，但 `manager.write/recordRecall/promote` 三方法实际仍是空壳。经讨论确定采用**方案 H** 填充，拆分为 H-A / H-B 两阶段执行，本条为 H-A。

**执行范围**：仅填充 Task 3/4 三个空壳方法 + 内部调用方收敛，**不改动已 ✅ 完成的 Task 6**（flush turn 工具路径）。

**详细计划**：见 `1-plan.md` §方案 H 执行计划。

**执行记录**：

- ✅ **A1**（2026-05-12）：抽取 `appendMemoryFileSafe` 公共原语 + 导出 `formatDateStampInTimezone`
  - 新文件：`extensions/memory-core/src/memory/memory-append-safe.ts`（204 行）
  - 修改：`extensions/memory-core/src/flush-plan.ts`（`formatDateStampInTimezone` 改 export）
  - 导出：`appendMemoryFileSafe()`、`resolveDailyMemoryRelativePath()`、`RESERVED_MEMORY_FILES`
  - 特性：路径白名单（`memory/YYYY-MM-DD.md`）、保留文件拒写、per-path 并发锁、append-only、返回 1-based 行号区间
  - 类型：`tsgo` 验证无新增错误

- ✅ **A2**（2026-05-12，初版）：实现 `manager.write/recordRecall/promote` 三方法
  - `write(entry)`：调 `resolveDailyMemoryRelativePath` + `appendMemoryFileSafe`，`dirty = true`，返回 `MemoryReference`
  - `recordRecall(ids: string[])`：用旧签名，内部做 `file:path:start:end` ID 解析 → `readFile` 读取 snippet → 构造 refs → 调 `recordShortTermRecalls`（query 回退为 `refs[0]!.id`）
  - `promote(ids)`：解析 ID → `rankShortTermPromotionCandidates` → 过滤匹配 → `applyShortTermPromotions`

- ⚠️ **发现问题**（2026-05-12）：验证发现 `recordRecall(ids: string[])` 与计划预期不符。计划要求 `recordRecall(refs: MemoryReference[], context?: { query: string; timezone?: string })`——薄封装而非 ID 反解析。且接口未改、实现无法编译新签名（报 TS2416）。

- 🔧 **决策**（2026-05-12）：将 A4（接口签名）前置到 A2 修正之前。执行顺序调整为：A1 → A4 → A2修正 → A3。

- ✅ **A4**（2026-05-12）：接口签名扩展落地
  - `packages/memory-host-sdk/src/host/types.ts`：`recordRecall(ids: string[])` → `recordRecall(refs: MemoryReference[], context?: { query: string; timezone?: string })`

- ✅ **A2 修正**（2026-05-12）：`recordRecall` 换新签名 + 删冗余
  - 签名改为 `(refs: MemoryReference[], context?: { query: string; timezone?: string })`
  - 变成纯薄封装 `recordShortTermRecalls`（fire-and-forget），query 优先使用 `context.query`，timezone 透传
  - 删去 ID 解析/readFile 冗余逻辑（-33行）
  - 类型：TS2416 消除

- ⚠️ **发现问题（2）**（2026-05-12）：执行 A3 前发现 `promote(ids: string[])` 签名也不完整——manager 内部硬编码默认阈值（DEFAULT_PROMOTION_MIN_SCORE 等），会导致 milvus 后端丢失 dreaming 的用户配置阈值（minScore/minRecallCount/maxAgeDays/recencyHalfLifeDays…）。接口签名 `promote(ids)` 没有阈值传递通道。

- 🔧 **决策**（2026-05-12，方式3）：拆 `promote` 为 `rankPromotionCandidates(opts)` + `applyPromotions(opts)` 两方法，与现有两阶段链路同构。阈值由调用方显式传入。执行顺序：A4补 → A2补 → A3。

- ✅ **A4 补**（2026-05-12）：接口 `promote` 拆分为两方法 + 新增 SDK `PromotionCandidate` 类型
  - `packages/memory-host-sdk/src/host/types.ts`：`promote(ids)` → `rankPromotionCandidates(opts)` + `applyPromotions(opts)`，新增 `export interface PromotionCandidate { id, snippet, score, recallCount, uniqueQueries }`
  - `packages/memory-host-sdk/src/engine-storage.ts`：导出 `PromotionCandidate`
  - `src/plugin-sdk/memory-core-host-engine-storage.ts`：re-export `PromotionCandidate`

- ✅ **A2 补**（2026-05-12）：`manager.promote(ids)` → `rankPromotionCandidates` + `applyPromotions` 两方法
  - `rankPromotionCandidates(opts)`：透传参数到 `rankShortTermPromotionCandidates`，返回 SDK `PromotionCandidate[]`
  - `applyPromotions(opts)`：SDK 候选 ID 反解析 → 内部格式 → `applyShortTermPromotions` → 结果映射回 SDK 类型
  - 删去 `includePromoted:true` 硬编码和 ID filter 逻辑（-34行 → +95行），无新增 tsgo 错误

- ✅ **A3**（2026-05-12）：调用方收敛完成
  - `tools.ts`：`queueShortTermRecallTracking` → 接受 `recordRecall` 函数参数，调 `manager.recordRecall(refs, context?)`，删去直调 `recordShortTermRecalls`；`MemorySearchManager` 加过渡 `recordRecall?` 方法
  - `dreaming.ts`：L575-611 `rankShortTermPromotionCandidates` + `applyShortTermPromotions` → `manager.rankPromotionCandidates(opts)` + `manager.applyPromotions(opts)`，保留 fallback 兜底路径；verbose log 改用 `candidate.id` 替代 `path:startLine:endLine`
  - 唯一遗留错误：既有 TS2322 `MemorySearchResult[]` vs `MemoryReference[]`（非 H-A 引入）

**H-A 完成状态**：8 文件改动，无新增 tsgo 错误。管理端三方法 + 调用方收敛完毕，AI flush turn 仍走老路径（H-B 处理）。


---

### TS2322 类型错误清理 ✅ 完成

**日期**：2026-05-12

**背景**：Part 1 全部 Task 1~6 + H-A 完成后，tsgo 仍残留 9 个 TS2322 错误，均涉及 `MemorySearchResult[]` 与 `MemoryReference[]` 类型不兼容。同时 `MemoryIndexManager` 在 `implements MemoryDataBackend` 后（`search()` → `MemoryReference[]`）无法赋值给旧接口 `MemorySearchManager`（`search()` → `MemorySearchResult[]`），导致 `search-manager.ts` 中两处 TS2322。

**核心修复**：

1. **`packages/memory-host-sdk/src/host/types.ts`** — 拓宽 `MemorySearchManager.search()` 返回类型，从 `Promise<MemorySearchResult[]>` 改为 `Promise<MemorySearchResult[] | MemoryReference[]>`。这使得 `MemoryIndexManager`（`search() → MemoryReference[]`）与 `MemorySearchManager` 结构兼容，同时兼容各调用方返回的 `MemorySearchResult[]`。

2. **`extensions/memory-core/src/memory/search-manager.ts`** — 添加 `toMemoryReference()` 辅助函数，将 `MemorySearchResult` 转为 `MemoryReference`（`id = file:path:startLine:endLine`，`provenance = { kind: "file", ... }`）。

3. **调用方适配**（6 个文件）：
   - `tools.ts` — `manager.search()` 结果加 `as MemoryReference[]`
   - `cli.runtime.ts` — 加 `as MemoryReference[]`，`result.path/startLine/endLine` 改为 `"provenance" in result` 类型守卫兼容两类型
   - `tools.citations.ts` — 泛型约束 `MemorySearchResult[]` → `T[]`
   - `dreaming-phases.ts` — 3 处加 `as unknown as MemoryReference[]`，`ShortTermRecallEntry` 旧字段 `path/startLine/endLine` → `key`
   - `memory-wiki/src/query.ts` — 加 `as MemorySearchResult[]`
   - `fast-context-runtime.ts` — 加 `as MemorySearchHit[]`

4. **`src/memory-host-sdk/events.ts`** — `MemoryHostRecallRecordedEvent.results` 元素改为 `id?/path?/startLine?/endLine?`（全部 optional），消除 `short-term-promotion.ts` 的 TS2322。

5. **dist 声明文件重建**：tsdown 完整构建在 Windows 上 OOM，改用 `npx tsc --project tsconfig.plugin-sdk.dts.json` 直接生成 dist 声明。

**最终状态**：
- ✅ TS2322：**零错误**（原有 9 个 + 修复过程中新暴露的 2 个全部消除）
- ⚠️ TS2353（~20 个）：test 文件中的测试 fixture 仍使用旧 `path` 字段，不阻塞 Task 7（设计确认），可在 Task 9（回归测试）前清理
- ⚠️ TS2339/TS2305（少量）：预存错误，非本次引入

**改动文件**：11 个（核心 6 个调用方 + search-manager + types + events + dist 声明 + 2 个外部调用方）

---

## 第二部分：memory-milvus 实现

### Task 7: 确认 Milvus 替代记忆本体 ✅ 完成

**日期**：2026-05-12

**性质**：纯设计确认（不涉及编码）

**确认要点**：

1. **互斥切换**：`plugins.slots.memory` 单一配置键，`memory-state.ts::registerMemoryCapability()` 单槽位覆盖写入，`memory-runtime.ts` 只解析一个 pluginId，天然互斥。`registry.ts` 中 `memorySlotSelected` 检查防止双 kind 插件误注册。

2. **接口契约**：`memory-milvus` 实现 `MemoryPluginRuntime`（`getMemorySearchManager` / `resolveMemoryBackendConfig` / `closeAllMemorySearchManagers`）+ `MemoryPluginCapability`（`promptBuilder` / `flushPlanResolver` / `runtime`），与 memory-core 完全同构。

3. **Agent 隔离**：memory-milvus 用共享 Collection + `agent_id` 字段过滤，与 memory-core 的文件系统物理隔离语义等效。`getMemorySearchManager({ agentId })` 已传入 agentId。

4. **Flush 分流**：`MemoryFlushPlan.backendKind` 已支持 `"file" | "milvus"`，milvus 的 `flushPlanResolver` 返回 `{ backendKind: "milvus" }` 即可触发方案 H 的 `memory_write` 路径。

**待后续关注**：
- `RegisteredMemorySearchManager` 仍引用旧 `MemorySearchManager` 类型，Task 8 实施时迁移到 `MemoryDataBackend`
- 阿里云 text-embedding-v3 可用性需 Task 8 前验证

---

### Task 8: 设计 Memory Collection Schema ✅ 完成

**日期**：2026-05-12

**落地文件**（新建 `extensions/memory-milvus/`）：

| 文件 | 内容 |
|------|------|
| `package.json` | 依赖 `@zilliz/milvus2-sdk-node` ^2.5.0 |
| `tsconfig.json` | 继承 `../tsconfig.package-boundary.base.json` |
| `api.ts` | re-export `definePluginEntry` |
| `openclaw.plugin.json` | kind: "memory"，配置 milvus host/port + embedding provider/model |
| `src/schema.ts` | 完整 Schema 定义（12字段 + 3个映射函数 + 15个常量） |
| `index.ts` | `definePluginEntry` 骨架，注册 `MemoryPluginCapability`（promptBuilder/flushPlanResolver/runtime） |

**Schema 字段与 MemoryEntry/MemoryReference 映射**：

| Milvus 字段 | 类型 | MemoryEntry | MemoryReference |
|-------------|------|-------------|-----------------|
| `id` | Int64 PK 自增 | `id` | `id` |
| `embedding` | FloatVector(1024) | —（内部） | —（内部） |
| `text` | VarChar(65536) | `text` | — |
| `snippet` | VarChar(4096) | `snippet` | `snippet` |
| `agent_id` | VarChar(256) | `agentId` | — |
| `session_key` | VarChar(512) | `sessionKey` | — |
| `memory_type` | VarChar(32) | `memoryType` | — |
| `recall_count` | Int32 | `recallCount` | — |
| `provenance_kind` | VarChar(32) | `provenance.kind` | `provenance.kind` |
| `provenance_label` | VarChar(1024) | `provenance.label` | `provenance.label` |
| `created_at` | VarChar(32) | `createdAt` | — |
| `updated_at` | VarChar(32) | `updatedAt` | — |

**映射函数**：
- `rowToMemoryReference(row)` — Milvus 行 → `MemoryReference`
- `rowToMemoryEntry(row)` — Milvus 行 → `MemoryEntry`
- `entryToInsertData(entry)` — `Omit<MemoryEntry, "id">` → Milvus insert JSON

**索引入口**：`buildPromptSection`（告诉 AI Milvus 后端语义）、`buildMilvusFlushPlan`（`backendKind: "milvus"`）、`milvusRuntime`（`getMemorySearchManager` 占位，Task 9 实现）。

**编译**：tsgo 零错误（memory-milvus 文件无任何 TypeScript 错误）。

---

### Task 9: 重写搜索（混合检索 ANN + scalar filter）✅ 完成

**日期**：2026-05-12

**依据**：`1-plan.md` §Task9 + `2-decisions.md` §8/8.1

**改动文件**：
- `extensions/memory-milvus/src/search.ts`（新建，527行）— `MilvusSearchManager` 类，实现 `MemorySearchManager` 接口
- `extensions/memory-milvus/index.ts`（修改）— 接入 `getMemoryEmbeddingProvider` + `MilvusSearchManager` 组装

**实现要点**：

| 检索路 | 方式 | 评分 |
|--------|------|------|
| 向量 ANN | `milvusClient.search({ anns_field: "embedding" })` | 原生 cosine/L2 距离 → 归一化 |
| 文本关键词 | `milvusClient.query({ filter: 'text like "%keyword%"' })` | 客户端 TF-IDF 计算 textScore |
| 融合 | 客户端加权 | `score = 0.7 × vectorScore + 0.3 × textScore` |
| 重排 | MMR (λ=0.7) | 去冗余 |
| 衰减 | temporalDecayFactor(30天半衰期) | 旧记忆降权 |

- **EmbeddingProvider**：通过 `getMemoryEmbeddingProvider(id, cfg)` → `adapter.create(options)` 透明调用，与 memory-lancedb 模式一致
- **`MilvusSearchManager` 方法**：`search()`（混合检索入口）、`readFile()`、`status()`、`probeEmbeddingAvailability()`、`probeVectorAvailability()`、`close()`
- **辅助函数**：`extractKeywords()`、`buildKeywordFilter()`、`computeTfIdfScores()`、`normalizeVectorScore()`、`temporalDecayFactor()`、`applyMMR()`、`createMilvusClient()`

**编译验证**：`tsgo` memory-milvus 零错误，`pnpm build` 通过。

**⚠️ 问题记录**：
- TS6133: `TEXT_FETCH_MULTIPLIER` 声明未使用 → 🔧 删除未使用常量
- TS2304: `FIELD_CREATED_AT` 未导入 → 🔧 在 search.ts 中添加 `FIELD_CREATED_AT` 导入
- tsdown optional peerDependency `unrun` 缺失导致 `pnpm build` 失败 → 🔧 `pnpm add -D unrun -w` 修复

---

### Task 10-S1: 类型契约与常量枚举打底 ✅ 完成

**日期**：2026-05-13

**依据**：`1-plan.md` §Task10-S1 + `2-decisions.md` §12.2/12.3/10.2

**改动文件**：

| 文件 | 内容 |
|------|------|
| `extensions/memory-milvus/src/types.ts`（新建，96行） | `MEMORY_SOURCE_LABELS`（4个常量）、`MEMORY_TYPES`（3个常量）、`MemorySourceLabel`/`MemoryType` 类型别名、`assertValidSourceLabel()`/`assertValidMemoryType()` 校验函数、`MilvusMemoryEntryMetadata` 接口 |
| `extensions/memory-milvus/src/types.test.ts`（新建，228行） | 28个单测用例：覆盖枚举值正确性、合法/越界校验、类型收窄、`MilvusMemoryEntryMetadata` 结构兼容性 |

**验收证据**：
- `pnpm test extensions/memory-milvus/src/types.test.ts` → 28 tests passed，1 file，138ms
- `pnpm build` → 全绿（tsdown + plugin-sdk dts + exports check 通过）
- `pnpm tsgo:extensions` → memory-milvus **零错误**（报告的 11 个错误全部在 memory-core 预存错误中）

**MilvusMemoryEntryMetadata 字段来源分工**（`2-decisions.md` §12.2）：

| 字段 | 来源 | 类型 |
|------|------|------|
| `agentId` | Host 注入 | `string` |
| `sessionKey` | Host/Manager 注入（optional） | `string \| undefined` |
| `memoryType` | Manager 默认 `"short_term"` | `MemoryType` |
| `createdAt` | Manager UTC 毫秒数 | `number` |
| `provenance.label` | Tool/Manager 注入 | `MemorySourceLabel` |

---

### Task 10-S2: Collection 初始化基础设施（含 init 接入 + degraded 状态）✅ 完成

**日期**：2026-05-13

**依据**：`1-plan.md` §Task10-S2 + `2-decisions.md` §12.1/12.6

**改动文件**：

| 文件 | 改动 |
|------|------|
| `extensions/memory-milvus/src/collection-bootstrap.ts`（新建，254行） | `ensureCollectionReady(client, config)` — eager init 原子化三步（create_collection → create_index → load_collection），每步幂等。Schema 字段 13 个（12业务字段 + metadata JSON兜底），`enable_dynamic_field: false`。HNSW 参数 `M`/`efConstruction`/`metric_type` 从 config 读取 |
| `extensions/memory-milvus/src/search.ts`（修改） | `MilvusSearchManager` 构造函数新增 `opts?: { degraded?: boolean }`，`status()` 的 `custom` 输出加 `degraded` 字段 |
| `extensions/memory-milvus/index.ts`（修改） | `getMemorySearchManager` 中接入 `ensureCollectionReady`：成功 → 正常实例化；失败 → `console.warn` + `degraded=true`，不阻止插件启用 |
| `extensions/memory-milvus/src/collection-bootstrap.test.ts`（新建，212行） | 8 个单测用例：覆盖全新创建 / 已存在全跳过 / 部分存在 / create失败抛出 / HNSW参数透传 / 网络错误上抛 |

**验收证据**：
- `pnpm test extensions/memory-milvus` → 2 files, 36 tests passed（types 28 + bootstrap 8）
- `pnpm build` → 全绿
- `pnpm tsgo:extensions` → memory-milvus 零错误（预存 memory-core 错误非本次引入）

**degraded 行为契约**（`2-decisions.md` §12.6）：
- Milvus 连不上时 `ensureCollectionReady` 抛出 → `index.ts` 捕获 → warn + `degraded=true` → 仍实例化 manager
- `MilvusSearchManager.status().custom.degraded` 上报供上层/UI 感知
- 后续 S3/S4 的 fallback/write 路径会先检查 `degraded` 决定是否走 ndjson 兜底

---

### Task 10-S3: Fallback 基础设施 ✅ 完成

**日期**：2026-05-13

**依据**：`1-plan.md` §Task10-S3 + `2-decisions.md` §12.5

**改动文件**：

| 文件 | 改动 |
|------|------|
| `extensions/memory-milvus/src/fallback.ts`（新建，275行） | `writeFallback(workspaceDir, entry)` — 序列化 `Omit<MemoryEntry, "id">` 为 JSON 追加到 `memory/.milvus-fallback/YYYY-MM-DD.ndjson`；`replayFallback(workspaceDir, writer)` — 遍历目录待处理文件，逐条 `writer(entry)` 回放，成功条目移除（重写文件），失败条目保留；`pendingFallbackCount(workspaceDir)` — 统计剩余条目总数供 `status()` 上报。全部写入/回放操作持有 in-process 文件锁，防止并发交错 |
| `extensions/memory-milvus/src/fallback.test.ts`（新建，269行） | 7 个单测用例：覆盖写入→全部回放成功→文件清空、写入→部分失败→失败条目保留+第二轮补放成功、空目录不抛错、10条并发写入无交错、无效JSON行被丢弃、元数据字段保真 |

**验收证据**：
- `pnpm test extensions/memory-milvus` → 3 files, 43 tests passed（types 28 + bootstrap 8 + fallback 7）
- `pnpm build` → 全绿

**关键设计**：
- `FALLBACK_DIR = "memory/.milvus-fallback"` 独立于 file backend 主目录
- `FallbackEntry = Omit<MemoryEntry, "id">` — 不含 id，Milvus 自增主键
- `withFileLock` — 复用 `memory-append-safe.ts` 的 in-process lock 模式
- `deserializeEntry` — 宽松解析，无效行直接丢弃，缺失字段补默认值
- `replaySingleFile` — 按文件批处理：全部回放→重写文件仅保留失败条目→文件变空则删除

---

### Task 10-S4: MilvusSearchManager.write 核心实现（含 recordRecall 占位）✅ 完成

**日期**：2026-05-13

**依据**：`1-plan.md` §Task10-S4 + `2-decisions.md` §12.2/12.5/12.7/10.3/10.8

**改动文件**：

| 文件 | 改动 |
|------|------|
| `extensions/memory-milvus/src/search.ts`（修改，+147行） | `MilvusSearchManager` 新增：`write(entry)` — 完整写入链路（元数据组装→健康探测→回放积压→embed+insert→fallback兜底）；`insertEntry()` — 私有 embed+insert 方法；`healthCheck()` — `describe_collection` 轻量探测；`fallbackWrite()` — 失败兜底；`recordRecall()` — 占位 warn。构造函数新加 `workspaceDir` 参数 |
| `extensions/memory-milvus/index.ts`（修改，+2行） | `getMemorySearchManager` 中通过 `resolveAgentWorkspaceDir` 获取 `workspaceDir` 并传递给 `MilvusSearchManager` 构造函数 |
| `extensions/memory-milvus/src/search.test.ts`（新建，286行） | 6 个单测用例：覆盖成功写入 / embed失败→fallback / insert失败→fallback / degraded直fallback / 健康探测失败→fallback / recordRecall仅warn不抛错 |

**验收证据**：
- `pnpm test extensions/memory-milvus` → 4 files, **49 tests** passed（types 28 + bootstrap 8 + fallback 7 + search 6）
- `pnpm build` → 全绿
- `pnpm tsgo:extensions` → memory-milvus **零错误**

**write() 五路分治流程**：
1. **元数据组装**：`agentId`(Host) / `sessionKey`(TODO) / `memoryType`(`"short_term"`) / `createdAt`(ISO now) / `provenance.label`(caller) → `assertValidSourceLabel`+`assertValidMemoryType` 校验
2. **degraded / 健康探测失败** → 直接 `fallbackWrite()`，返回 `fallback:<ts>` 占位 id
3. **健康** → `replayFallback(workspaceDir, insertEntry)` 批量回灌积压
4. **新写入** → `embedQuery(text)` + `entryToInsertData()` + `client.insert()`，返回 Milvus 自增 PK
5. **embed/insert 异常** → `fallbackWrite()` 兜底

**fixup**（2026-05-13）：`search.test.ts` 中三处 provider mock 的 `dimensions: 1024` 多余字段清理——`MemoryEmbeddingProvider` 接口不含 `dimensions` 属性，改补 `id`+`model` 必选字段。

---

### S5 · AI 调用链端到端打通（2026-05-13）

**改动文件**：

| 文件 | 变更 |
|------|------|
| `extensions/memory-milvus/src/tools.ts`（新建，102行） | `createMemoryWriteTool` 工厂：schema `{text, label?}`，校验→manager.write()，5种错误路径覆盖 |
| `extensions/memory-milvus/src/tools.test.ts`（新建，173行） | 9 单测：合法写入 / 默认label / 非法label / text为空 / text缺失 / manager null / write内部异常 / user_manual / 返回结构 |
| `extensions/memory-milvus/index.ts`（+8行） | 导入 `createMemoryWriteTool`；`register()` 中注册 `memory_write` 工具；`buildPromptSection` 新增 `memory_write` 说明行 |
| `extensions/memory-milvus/openclaw.plugin.json`（+1/-1） | `contracts.tools` 增加 `"memory_write"` |
| `src/agents/pi-tools.ts`（+1/-1） | `MEMORY_FLUSH_ALLOWED_TOOL_NAMES` 白名单新增 `"memory_write"` |

**S5-1 工具注册**：
- `memory_write` 工具：`{ name:"memory_write", label:"memory_write", parameters:{text(required), label(optional, default chat_extract)} }`
- `label` 枚举取自 `MEMORY_SOURCE_LABELS` 常量值，`assertValidSourceLabel` 越界即返回错误
- 通过闭包持有 `activeManager` getter，manager null → 返回明确初始化错误
- `api.registerTool(..., { names: ["memory_write"] })` 注册

**S5-2 白名单**：
- `MEMORY_FLUSH_ALLOWED_TOOL_NAMES` → `Set(["read", "write", "memory_write"])`
- **不变式确认**：`memory_write` tool.name ≠ `"write"`，不进入 `wrapToolMemoryFlushAppendOnlyWrite` 分支，原样传给 AI flush turn
- 文件后端 `write` 工具行为零变更

**S5-3 Prompt 对齐**：
- `buildMilvusFlushPlan` 已含 `"Write each memory using \`memory_write\`."` ✅
- `buildPromptSection` 新增 `"- Use \`memory_write\` to persist extracted memories..."` ✅

**验收证据**：
- `pnpm test extensions/memory-milvus` → 5 files, **58 tests** passed（+9 tools.test）
- `pnpm tsgo:extensions` → memory-milvus **零错误**（仅 memory-core 11 预存）
- `pnpm build` → 全绿

---

### S6 · Alpha 标记 + 测试整合（2026-05-13）

**改动文件**：

| 文件 | 变更 |
|------|------|
| `extensions/memory-milvus/package.json`（+1行） | 新增 `"stability": "experimental"` 字段 |
| `extensions/memory-milvus/README.md`（新建，95行） | Alpha 标注 / 能力清单 / Docker Milvus 快速启动 / 测试说明 / 架构图 |
| `extensions/memory-milvus/src/memory-milvus.live.test.ts`（新建，94行） | 1 条 `describe.skipIf(OPENCLAW_LIVE_TEST !== "1")` 保护的 `write → insert` E2E 用例 |
| `refactor/2-decisions.md`（+12行） | §12.8 追加 Live 测试执行档位决策（方案A），§12.12 Alpha 标记与 S6 交付 |

**S6-1 Alpha 标记**：
- `package.json` `"stability": "experimental"` — 元数据字段，当前未被插件 loader 机械消费
- `README.md` 明确标注"Alpha status — production use not recommended until Task 13"
- 能力清单：✅ memory_write / Collection bootstrap / degraded / 校验 / prompt vs ❌ memory_search / memory_get / recordRecall / promotion / BM25 / dedup

**S6-2 Live 测试骨架**：
- `memory-milvus.live.test.ts`：1 条端到端用例，验证 write 返回合法 id + provenance
- 通过 `OPENCLAW_LIVE_TEST` + `OPENCLAW_MILVUS_HOST/PORT` + `OPENCLAW_MILVUS_EMBED_PROVIDER/MODEL` 环境变量控制
- 真实 Milvus 回归 **推迟到 Task 13**（Alpha 退出条件），当前 skeleton 的 `OpenClawConfig` 为 `{} as any` 占位
- README 提供 `docker run -d -p 19530:19530 milvusdb/milvus:v2.4.0 standalone` 启动说明

**S6-3 Mock 单测收口**：5 files, **58 tests** 全绿（默认 CI `pnpm test extensions/memory-milvus` 一把跑绿）

**验收证据**：
- `pnpm test extensions/memory-milvus` → 5 files, **58 tests** passed（live test 被 skipIf 正确跳过）
- `pnpm tsgo:extensions` → memory-milvus **零错误**（仅 memory-core 11 预存）
- `pnpm build` → 全绿

**Task 10 进度总览**：
| 步骤 | 状态 | 测试数 |
|------|------|--------|
| S1 类型契约 | ✅ | 28 |
| S2 初始化基础设施 | ✅ | 8 |
| S3 Fallback | ✅ | 7 |
| S4 write 核心 | ✅ | 6 |
| S5 AI 调用链 | ✅ | 9 |
| S6 Alpha+测试 | ✅ | — |
| S7 收尾 | ✅ | — |

---

## ✅ Task 10 完成（2026-05-13）

### 验收证据

| 检查项 | 结果 |
|--------|------|
| `pnpm test extensions/memory-milvus` | 5 files, **58 tests** passed |
| `pnpm tsgo:extensions` | memory-milvus **0 错误** |
| `pnpm build` | 全绿 |
| `pnpm check:changed` | 全绿 |

### S1–S7 改动文件总清单

| 步骤 | 文件 | 行数 |
|------|------|------|
| S1 | `src/types.ts`（新建） | 96 |
| S1 | `src/types.test.ts`（新建） | 228 |
| S2 | `src/collection-bootstrap.ts`（新建） | 254 |
| S2 | `src/collection-bootstrap.test.ts`（新建） | 212 |
| S2 | `src/search.ts`（新建，含 degraded） | 692 |
| S2 | `index.ts`（重写，接入 degraded） | 241 |
| S3 | `src/fallback.ts`（新建） | 149 |
| S3 | `src/fallback.test.ts`（新建） | 306 |
| S4 | `src/search.ts`（+write 5路分治） | （含 S2） |
| S4 | `src/search.test.ts`（新建） | 287 |
| S5 | `src/tools.ts`（新建） | 102 |
| S5 | `src/tools.test.ts`（新建） | 173 |
| S5 | `index.ts`（+工具注册+prompt） | +8 |
| S5 | `openclaw.plugin.json`（+memory_write） | +1/-1 |
| S5 | `src/agents/pi-tools.ts`（白名单） | +1/-1 |
| S6 | `package.json`（+stability） | +1 |
| S6 | `README.md`（新建） | 95 |
| S6 | `src/memory-milvus.live.test.ts`（新建） | 94 |
| S6 | `refactor/2-decisions.md`（+§12.8/12.12） | +12 |

**核心文件**：`extensions/memory-milvus/` 下 14 个文件（源码 9 + 测试 5），约 3100 行。

### 关键不变式验证

| 不变式 | 状态 |
|--------|------|
| 文件后端零回归（S5 只追加白名单，不动 wrap） | ✅ `pi-tools.ts` L855 分支不受 `memory_write` 影响 |
| Milvus 不可用时写入不丢（degraded → fallback） | ✅ 4 条 write 路径覆盖 |
| Label/Type 越界即抛错（S1校验+S4/S5入口复用） | ✅ tools.test 8 条覆盖 |
| 插件 Alpha 标记（S6 stability:experimental） | ✅ |

### 遗留技术债

| 项目 | 说明 | 目标 |
|------|------|------|
| `memory_search` / `memory_get` 工具 | 🟡 Task 11 Step2 完成（工具层），待 Step3-4 | Task 11 |
| `recordRecall` 正式实现 | 当前仅 console.warn 占位 | Task 12 |
| Dreaming promotion（短→长） | Task 13，Alpha 退出条件 | memory-milvus |
| live 测试真实回归 | `OpenClawConfig` 为 `{} as any` 占位 | Task 13 |
| pi-tools 白名单架构下沉 | 当前硬编码，未来多后端时评估 | Task 16+ |
| `session_key` 默认值 | write() 中 TODO：Host 注入默认 sessionKey | Task 16 |
| BM25 全文本搜索 | Task 14 | memory-milvus |
| sha256 去重 / update / delete / 版本 | Task 16 | memory-milvus |

---

## 第三部分：memory_search / memory_get 工具

### Task 11 Step 1: Schema 扩展 + Manager 底层方法 ✅ 完成

**日期**：2026-05-13

**依据**：`1-plan.md` §Task11 Step1 + `2-decisions.md` §13-16

**改动文件**：

| 文件 | 变更 |
|------|------|
| `extensions/memory-milvus/src/schema.ts` | + `FIELD_LAST_RECALLED_AT` 常量；入 `ALL_SCHEMA_FIELDS` / `entryToInsertData` |
| `extensions/memory-milvus/src/warn-once.ts`（新建） | key-based 去重 `warnOnce(key, message)` helper |
| `extensions/memory-milvus/src/collection-bootstrap.ts` | `buildCollectionFields` 追加 `last_recalled_at` (VarChar(32), β) |
| `extensions/memory-milvus/src/collection-bootstrap.test.ts` | fields 计数 13→14；`last_recalled_at` 字段名断言 |
| `extensions/memory-milvus/src/search.ts` | `search()` 追加 `degraded` 静默降级 + `warnOnce`；新增 `get(id): Promise<MemoryEntry>`（13 字段取全，close/degraded/not-found → throw） |
| `extensions/memory-milvus/src/search.test.ts` | +5 tests：1 degraded search + 4 get 四态（found / not-found throw / closed throw / degraded throw） |

**验收证据**：
- `pnpm test extensions/memory-milvus` → 5 files, **63 tests** passed（58→63，+5）
- `pnpm tsgo:extensions` → memory-milvus **0 错误**

**Task 11 进度**：
| 步骤 | 状态 |
|------|------|
| Step 1 Schema+Manager | ✅ |
| Step 2 工具层 | ✅ |
| Step 3 Plugin 注册 | ⬜ |
| Step 4 全量回归 | ⬜ |

### Task 11 Step 2: 工具层（memory_search / memory_get）✅ 完成

**日期**：2026-05-13

**依据**：`1-plan.md` §Task11 Step2 + `2-decisions.md` §13/§17/§18

**改动文件**：

| 文件 | 变更 |
|------|------|
| `extensions/memory-milvus/src/tools.search.ts`（新建） | `createMemorySearchTool(deps)`：schema 与 memory-core 一对一（query/maxResults/minScore/corpus）；corpus 路由（memory/undefined→search；sessions/wiki→空+warnOnce；all→退化为memory+warnOnce）；recordRecall hook；citation warnOnce；MemoryReference 原样透传 |
| `extensions/memory-milvus/src/tools.get.ts`（新建） | `createMemoryGetTool(deps)`：schema 与 memory-core 一对一（path/from/lines/corpus/id）；仅用 id；不触发 recordRecall；异常透传 |
| `extensions/memory-milvus/src/tools.search.test.ts`（新建） | 15 tests：schema 字段集守护 + query 必填 + 5 种 corpus 路由 + recordRecall hook（命中/无命中/无方法）+ citation 无装饰 + manager 不可用/异常 |
| `extensions/memory-milvus/src/tools.get.test.ts`（新建） | 10 tests：正常获取 + id trim + 空id/缺失id 错误 + not-found/closed/degraded 错误 + 不触发 recordRecall + manager 不可用 + 冗余参数忽略 |

**验收证据**：
- `pnpm test extensions/memory-milvus` → 7 files, **88 tests** passed（63→88，+25）
- `pnpm tsgo:extensions` → memory-milvus **0 错误**（11 错误均在 memory-core，全部预存）

**偏离说明**：
- `filterMemorySearchHitsBySessionVisibility` 因 tsconfig rootDir 跨插件导入限制，暂缺集成。当前 milvus 结果无 session source 故为 no-op，Task 16 时接入（已留注释）