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

