# 记忆系统接口抽象重构与 Milvus 接入 — 执行计划

## 总原则

- 不新增接口，而是**演化和收敛**现有接口
- `MemorySearchManager` → `MemoryDataBackend`（原地升级，不并存）
- `MemorySearchResult` → `MemoryReference`（path/line 编码进 id）
- `MemoryReadResult` → `MemoryEntry`（扩展为通用条目）
- `write` / `recordRecall` / `promote` 从散落各处收敛到接口
- 只新增 `extensions/memory-milvus/` 目录

---

## 第一部分：接口抽象重构（3.md 阶段1-6）

### Task 1: 梳理 memory-core 职责分布

- 记忆本体存储：`MEMORY.md` / `memory/YYYY-MM-DD.md`
- 记忆检索：`memory_search` 工具 → `manager.search()`
- 精确读取：`memory_get` 工具 → `manager.readFile()`
- flush 写入：`flush-plan.ts` → `pi-tools.ts` → `wrapToolMemoryFlushAppendOnlyWrite`
- 召回记录：`short-term-promotion.ts` → `short-term-recall.json`
- Dreaming 整理：`dreaming.ts` + `dreaming-phases.ts` → promotion
- 状态/CLI：`status()` / CLI 命令

### Task 2: 提取通用记忆概念

**现状**：系统默认记忆 = 文件路径 + 行号

**目标**：记忆 = 内容 + 来源 + 标识 + 元数据

- `MemorySearchResult`（path/startLine/endLine/snippet/score）→ 演化为 `MemoryReference`（id/snippet/score/provenance）
- `MemoryReadResult`（text/path/from/lines）→ 演化为 `MemoryEntry`（id/text/agentId/sessionKey/memoryType/recallCount/createdAt/metadata/provenance）
- `MemoryFlushPlan.relativePath` → optional + 新增 `backendKind`

### Task 3: 演化 MemorySearchManager → MemoryDataBackend

将现有 `MemorySearchManager` 接口**重命名**为 `MemoryDataBackend`，并收敛散落逻辑：

| 原接口方法 | 演化后 | 来源 |
|-----------|--------|------|
| `search()` | `search()` → 返回 `MemoryReference[]` | 保留，返回类型改名 |
| `readFile()` | `get(id: string)` → 返回 `MemoryEntry` | 演化，参数从 path+line 改为 id |
| — | `write(entry)` → 返回 `MemoryReference` | 从 flush-plan 逻辑收敛来 |
| — | `recordRecall(ids: string[])` | 从 short-term-promotion 收敛来 |
| — | `promote(ids: string[])` | 从 dreaming 收敛来 |
| `status()` | `status()` | 保留 |
| `sync()` | `sync()` | 保留 |
| `close()` | `close()` | 保留 |

**关键**：`get(id)` 只接受 id 字符串。

```
文件后端: id = "file:memory/2026-05-11.md:20:25" → 内部解析后读文件
Milvus:   id = "453218790342567891"（主键） → PK 查询
```

### Task 4: 重构 memory-core 实现 MemoryDataBackend

**改动文件及内容：**

1. `packages/memory-host-sdk/src/host/types.ts` — `MemorySearchManager`→`MemoryDataBackend`，`MemorySearchResult`→`MemoryReference`，`MemoryReadResult`→`MemoryEntry`

2. `extensions/memory-core/src/memory/manager.ts` — `MemoryIndexManager implements MemoryDataBackend`：
   - `search()` 返回 `MemoryReference[]`（provenance.kind="file"）
   - `get(id)` 解析 id 中的 path+line，读文件
   - `write(entry)` append 到 `memory/YYYY-MM-DD.md`
   - `recordRecall(ids)` 更新 `short-term-recall.json`
   - `promote(ids)` 升级到 `MEMORY.md`

3. `extensions/memory-core/src/tools.ts` — `memory_get` schema 改为 `{ id: string }`

4. `extensions/memory-core/src/flush-plan.ts` — `relativePath` 改为 optional，加 `backendKind: "file"`

5. `extensions/memory-core/src/short-term-promotion.ts` — key 从 `path:line` 改为 `MemoryReference.id`，删除 ShortTermRecallEntry 的 path/startLine/endLine 字段。rehydrate 改为调 `backend.get(id)` 而非自己读文件。评分算法不变。

6. `extensions/memory-core/src/dreaming-phases.ts` — 文件操作不变，底部 path/startLine/endLine 三字段合并为 MemoryReference.id。memory-milvus 独立实现数据采集。

### Task 5: 改造 memory_search / memory_get 语义

- `memory_search` 返回通用 `MemoryReference`，包含 `provenance` 元数据
- `memory_get` 接受 id，后端自行解析
- promptBuilder 根据后端类型告知 AI 参数格式

### Task 6: 重构 flush 写入流程

```typescript
type MemoryFlushPlan = {
  // ... 现有字段
  relativePath?: string;              // 仅文件后端，改为 optional
  backendKind?: "file" | "milvus";    // 新增
};
```

| 后端 | 返回 | pi-tools.ts 行为 |
|------|------|-----------------|
| 文件 | `{ relativePath, backendKind:"file" }` | wrapToolMemoryFlushAppendOnlyWrite（现逻辑不变） |
| Milvus | `{ backendKind:"milvus" }` | 不包装 write，走 plugin 的 memory_write 工具 |

> **[补充决策 2026-05-12]** 上表的"pi-tools.ts 行为"细化为**方案 H（统一 memory_write 工具）**：所有后端的 AI flush turn 均调用 `memory_write` 工具，文件后端和 milvus 后端仅在 `backend.write()` 内部实现不同。详见 `2-decisions.md` §11。
>
> 此细化连带影响 Task 3/4 的实现方式：
> - Task 3 的 `write/recordRecall/promote` 三方法通过公共原语 `appendMemoryFileSafe()` 和薄封装实现
> - Task 4 新增 `memory_write` 工具与 `memory-append-safe.ts` 两个文件
> - `recordRecall` 签名扩展为 `(refs: MemoryReference[], context?)` 以保留评分信号
> - 完整执行计划（含 H-A / H-B 拆分、阶段表、验证点）见本文件 §方案 H 执行计划

---

## 方案 H 执行计划（Task 3/4 遗留补丁 + Task 6 修订）

> 本节为方案 H 的完整执行计划，对应 `2-decisions.md` §11。
> 拆分为 **H-A**（Task 3/4 遗留填充）和 **H-B**（Task 6 修订）两段独立执行，降低回归风险。

### 总目标

切到 milvus 后端后，除 `backend.write()` / `backend.search()` 内部实现外，所有代码路径、AI 工具、prompt 完全相同。

### 决策要点（已确认）

- `recordRecall` 签名扩展为 `(refs: MemoryReference[], context?)`，保留评分信号
- 原 `recordShortTermRecalls` / `applyShortTermPromotions` 函数保留为 `@internal`，供既有测试与 backend 内部调用，不删除
- H-A 和 H-B 独立提交，H-B 延后执行

---

### H-A：Task 3/4 遗留填充（先执行）

**作用域**：填充三个空壳方法与内部调用方收敛，**不动 Task 6 的 flush turn 工具路径**。

| 阶段 | 任务 | 改动位置 |
|------|------|---------|
| A1 | 抽取公共落盘原语 `appendMemoryFileSafe` + 导出日期函数 | `extensions/memory-core/src/memory/memory-append-safe.ts`（新）+ `flush-plan.ts`（`formatDateStampInTimezone` 改 export） |
| A2 | 实现 `manager.write()`（调 A1 原语）、`recordRecall(refs, context?)`（薄封装 `recordShortTermRecalls`）、`promote(ids)`（薄封装 `rankShortTermPromotionCandidates` + `applyShortTermPromotions`） | `extensions/memory-core/src/memory/manager.ts` |
| A3 | 调用方收敛：`queueShortTermRecallTracking` 改调 `manager.recordRecall(refs)`；`dreaming.ts::L601` 改调 `manager.promote(ids)` | `extensions/memory-core/src/tools.ts`、`extensions/memory-core/src/dreaming.ts` |
| A4 | 接口签名扩展落地：`MemoryDataBackend.recordRecall(refs, context?)` | `packages/memory-host-sdk/.../types.ts` |

**改动规模**：~5 文件，~150 行代码。

**验证**：
- `pnpm tsgo`：类型通过
- 既有 `short-term-promotion.test.ts` / `memory-events.test.ts` / `dreaming` 相关测试全绿
- 新增 `manager-write.test.ts`：验证 write → 下一次 sync 后可 search 命中
- 新增 `memory-append-safe.test.ts`：验证路径白名单、保留文件拒写、并发 append 行号不错乱

**不做**：
- ❌ 不新增 `memory_write` 工具（归 H-B）
- ❌ 不改 flush prompt（归 H-B）
- ❌ 不改 `src/pi-tools.ts` 的 flush 分流（归 H-B）
- ❌ 不动 `wrapToolMemoryFlushAppendOnlyWrite`（归 H-B）

**完成后效果**：`manager.write()` 文件后端版可用但暂无调用方（只为 milvus 对接准备），AI flush turn 仍走老路径。这是**为 Task 10 / Part 2 准备的过渡态**，属于可接受的技术债。

---

### H-B：Task 6 修订（延后执行）

**作用域**：改造 flush turn 让所有后端 AI 都走 `memory_write` 工具，彻底消除双路径。

| 阶段 | 任务 | 改动位置 |
|------|------|---------|
| B1 | 新增 `memory_write` 工具 + schema + capability 注册 | `extensions/memory-core/src/tools.shared.ts`、`extensions/memory-core/src/tools.ts`、`extensions/memory-core/src/index.ts` |
| B2 | flush prompt 改写：引导 AI 调 `memory_write` 而非写文件 | `extensions/memory-core/src/flush-plan.ts` |
| B3 | pi-tools 工具白名单切换：flush turn 暴露 `memory_write`，`wrapToolMemoryFlushAppendOnlyWrite` 降级为兜底 | `src/agents/pi-tools.ts` |

**改动规模**：~5 文件，~200 行代码。

**风险点**（比 H-A 高）：
- AI 行为回归：AI 需识别新 `memory_write` 工具，可能需多轮 prompt 校准
- 跨仓修改（`src/`），涉及 flush turn 主路径
- 需独立提交 + 手工验证 flush turn 端到端

**执行时机选项**：
- **选项 α**：Part 2 开始前（Task 7 之前）独立执行
- **选项 β**：与 Task 10（milvus 重写 flush/capture）合并执行——Task 10 本来就要新增 `memory_write`，一起做最省事

**推荐**：选项 β。H-B 延后到 Task 10 一并处理，避免短期内重复改动 pi-tools。

---

### 保留不删项

| 函数 / 路径 | 保留原因 |
|------------|---------|
| `recordShortTermRecalls` | 被既有测试和 H-A 后的 manager 内部调用 |
| `applyShortTermPromotions` | 被既有 dreaming 测试和 H-A 后的 manager 内部调用 |
| `wrapToolMemoryFlushAppendOnlyWrite` | 即使 H-B 完成，也保留为兜底防 AI 误用 file write |
| `memory/*.md` 文件格式 | 不变，无数据迁移 |

---




## 第二部分：memory-milvus 实现

### Task 7: 确认 Milvus 替代记忆本体

- `plugins.slots.memory = "memory-milvus"` 时，记忆本体完全在 Milvus
- 与 memory-core 互斥，不同时运行

### Task 8: 设计 Memory Collection Schema

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | Int64（主键、自增） | Milvus 自动分配 |
| `embedding` | FloatVector(1024) | 阿里云 text-embedding-v3 |
| `text` | VarChar(65536) | 记忆内容，64k上限 |
| `snippet` | VarChar(4096) | 搜索预览片段 |
| `agent_id` | VarChar(256) | Agent 标识 |
| `session_key` | VarChar(512) | 会话标识 |
| `memory_type` | VarChar(32) | short_term / long_term / archived |
| `recall_count` | Int32 | 召回频次 |
| `provenance_kind` | VarChar(32) | milvus |
| `provenance_label` | VarChar(1024) | 来源描述 |
| `created_at` | VarChar(32) | ISO 时间 |
| `updated_at` | VarChar(32) | ISO 时间 |

- embedding 模型：text-embedding-v3（1024维）
- index 类型：IVF_FLAT 或 HNSW
- agent 隔离：共享 Collection，`agent_id` 字段过滤

### Task 9: 重写搜索（混合检索 ANN + scalar filter）

- 搜索行为、工具参数、返回格式与 memory-core 完全一致（仅底层从 sqlite-vec + FTS5 换为 Milvus ANN + scalar filter）
- **向量搜索**：`milvusClient.search({ anns_field: "embedding", vectors: [...] })`，复用已有 `EmbeddingProvider` 获取查询向量
- **文本搜索**：`milvusClient.query({ filter: 'text like "%keyword%"' })` + 客户端 TF-IDF 计算 textScore
- **评分融合**：`score = w1 × vectorScore + w2 × textScore` → MMR → 时间衰减
- embedding：不注册独立 provider，通过已有 `EmbeddingProvider` 接口透明调用
- **⚠️ 后期升级**：Milvus ≥ 2.4 部署并手动创建 BM25 Function 后，将 scalar filter 切换为原生 BM25 稀疏向量搜索，删除客户端 TF-IDF 计算（见 `2-decisions.md` §8.1）

### Task 10: 重写写入 capture/flush 流程

> 详细决策见 `2-decisions.md` §12。当下采用**路线 A 分阶段渐进**（双路径并存：文件后端继续 `write + wrap`，milvus 后端单独走 `memory_write`），Task 16 之后再合并到 §11 的统一目标（解读 B）。

**10.1 Collection 生命周期（Eager init 原子化）**
- 位置：`extensions/memory-milvus/src/search.ts` 或新文件 `collection-bootstrap.ts`
- 实现 `create_collection` → `create_index` → `load_collection` 三步原子化
- 幂等探测（describe / has_index）、重启检查 loaded 状态
- HNSW 参数从 config 读（`M` / `efConstruction` / `metric_type`）
- 固定 schema + `metadata JSON` 兜底字段（不启用 `enable_dynamic_field`）
- **验收**：插件二次启动不报"already exists"、Collection 处于 loaded、search/write 可用

**10.2 常量枚举与类型补齐**
- 在 `extensions/memory-milvus/src/types.ts` 导出 `MEMORY_SOURCE_LABELS` 与 `MEMORY_TYPES`（见 §12.3）
- 校验辅助函数：`assertValidSourceLabel(label)` / `assertValidMemoryType(t)`
- **验收**：types.ts 单元测试覆盖越界抛错

**10.3 `MilvusSearchManager.write(entry)` 实现**
- 位置：`extensions/memory-milvus/src/search.ts`
- 组装 metadata（agentId / session_key / memory_type=short_term / createdAt=UTC ms / provenance.label）
- 调 `EmbeddingProvider` 生成向量 → `collection.insert`
- 返回 `MemoryReference`（含 milvus PK）
- 失败（embed / insert）走 §10.4 fallback
- **验收**：能写入 milvus 并 search 命中

**10.4 Fallback 目录与回放**
- 位置：`extensions/memory-milvus/src/fallback.ts`（新建）
- 路径 `memory/.milvus-fallback/YYYY-MM-DD.ndjson`
- `writeFallback(entry)` / `replayFallback()`
- `write()` 入口先探 milvus 健康 → 健康则先回放再写新；不健康则直接 fallback
- Init 连不上时 `status()` 返回 `degraded`，不阻止插件启用
- **验收**：断 milvus 连接写入不丢数据，恢复后自动回灌

**10.5 `memory_write` 工具注册（仅 milvus 插件）**
- 位置：`extensions/memory-milvus/src/tools.ts` 或 `index.ts` 内联注册
- Schema：`{ text: string, label?: MemorySourceLabel }`（label 默认 `chat_extract`）
- Tool handler 调 `activeManager.write(entry)`
- 强校验 `label` 在 `MEMORY_SOURCE_LABELS` 内，越界抛错
- **验收**：AI 调 `memory_write` → milvus 写入成功；越界 label 返回错误

**10.6 pi-tools 白名单追加 `memory_write`**
- 位置：`src/agents/pi-tools.ts` L98 `MEMORY_FLUSH_ALLOWED_TOOL_NAMES`
- 改为 `new Set(["read", "write", "memory_write"])`
- 不动 wrap 装饰逻辑（write 继续走 wrap，memory_write 不包装）
- **验收**：flush turn milvus 后端下 AI 能调到 `memory_write`；文件后端行为不变

**10.7 `buildMilvusFlushPlan` prompt 对齐**
- 位置：`extensions/memory-milvus/index.ts` L60-71
- 确认 prompt 引导 AI 调 `memory_write(text)`，不是 `write({path, content})`
- 复用 `extensions/memory-core/src/flush-plan.ts` 的通用 hint 文案（如 `MEMORY_FLUSH_TARGET_HINT` 等）
- **验收**：real-run 下 AI 按 prompt 选中 `memory_write` 工具

**10.8 recordRecall 失败兜底**
- 召回埋点失败直接丢 + warn log（不走 fallback）
- Task 12 正式实现 milvus 的 `recordRecall` 时合并此策略

**10.9 Alpha / Experimental 标记**
- 位置：`extensions/memory-milvus/package.json` + README
- `package.json` 加标识字段（如 `"stability": "experimental"` 或等价 manifest 字段）
- README 明确"Alpha 状态：promotion 链路依赖 Task 12/13 完工，当前仅支持写入和检索"
- Task 13 完工时移除此标记（见 Task 13 验收）

**10.10 测试策略（对应 §12.8）**
- 单测文件 `extensions/memory-milvus/src/*.test.ts`：mock `@zilliz/milvus2-sdk-node` client，覆盖 write/fallback/枚举校验
- Live 测试文件 `extensions/memory-milvus/src/*.live.test.ts`：`OPENCLAW_LIVE_TEST=1` 下跑，需真实 Milvus
- 不引入 milvus-lite

**不在 Task 10 范围**：
- Task 12 的 `recordRecall` milvus 实现
- Task 16 的统一 `memory_write`（合并到解读 B）
- 文件后端改走 `memory_write`（等 Task 16）
- pi-tools 白名单下沉（见 §12.9，留技术债）

### Task 11: 重写 memory_search / memory_get（含 recordRecall hook）

> **状态**：✅ 完成于 2026-05-13

> **注**：`memory_recall` 是召回追踪机制的描述名词，**不是 AI 工具**；AI 可见工具仅 `memory_search` + `memory_get` + `memory_write`。详见 decisions §13.1。

- `memory_search`：Milvus ANN + BM25 混合检索 → `MemoryReference[]`，命中后内部触发 `recordRecall` hook（manager 实现仍为 warn 占位，落库由 Task 12 完成）
- `memory_get`：按 id 查询 PK → `MemoryEntry`（新增 `MilvusSearchManager.get(id)` 实现，**与现有 `readFile` 并存不动**；详见 decisions §14）
  - 一次性取全 12 个字段（含 `last_recalled_at`），返回完整 `MemoryEntry`，不支持切片
  - id 不存在 / closed / degraded 一律 `throw`，不触发 `recordRecall`
- **Schema 增量**：新增 `last_recalled_at` VarChar(32) 字段（详见 decisions §13.2）
- **工具注册互斥**（详见 decisions §13.4 方案 Y）：信赖 `src/plugins/slots.ts` 的 `applyExclusiveSlotSelection` 预处理阶段 entries disable 机制；两插件 `register()` 内**无条件**注册同名工具，memory-core/index.ts 不动
- **会话可见性**：复用 `filterMemorySearchHitsBySessionVisibility`（应用层）；backend 侧 expr 原生过滤推到 Task 16
- **多 corpus 范围**（详见 decisions §17）：schema 与 memory-core 一对一；`memory`/undefined 正常查询；`sessions`/`wiki`/`all` 返回空 + warnOnce，真正接入推 Task 16
- **degraded 行为**（详见 decisions §16）：`search()` 加 `if (this.degraded) return []`（与 closed 一致的静默降级语义）
- **citation 装饰 pipeline**（详见 decisions §18）：Task 11 不装饰也不复刻 memory-core 的 `decorateCitations`，`MemoryReference` 原样透传；首次命中 warnOnce；完整能力推 Task 16

#### 执行步骤（四步单线串行）

> 前置验证：R1/R4/R6 已解除——`OpenClawPluginApi.config` 可读、memory-core/index.ts L190/L194 为注册点、`slots.ts` `applyExclusiveSlotSelection` 自动 disable 非 selected 插件 entries。

**Step 1 —— Schema 扩展 + Manager 底层方法**

涉改：
- `extensions/memory-milvus/src/schema.ts` — 新增 `FIELD_LAST_RECALLED_AT = "last_recalled_at"`（VarChar(32)）
- `extensions/memory-milvus/src/collection-bootstrap.ts` — schema 字段列表追加 `last_recalled_at`
- `extensions/memory-milvus/src/search.ts` — `search()` 在 `if (this.closed) return [];` 之后新增 `if (this.degraded) { warnOnce(...); return []; }`
- `extensions/memory-milvus/src/search.ts` — 新增 `MilvusSearchManager.get(id): Promise<MemoryEntry>`（一次取全 12 字段，not-found / closed / degraded 一律 throw，不触发 recordRecall）
- `extensions/memory-milvus/src/warn-once.ts`（新建） — key-based 去重 warn helper

测试：
- `search.test.ts` — degraded case；`get(id)` 四态 case（found / not-found throw / closed throw / degraded throw）
- `collection-bootstrap.test.ts` — 字段集含 `last_recalled_at`

验收：`pnpm test extensions/memory-milvus/src/search.test.ts extensions/memory-milvus/src/collection-bootstrap.test.ts` 全绿 + `pnpm tsgo` 无新错。

**Step 2 —— 工具层（memory_search / memory_get）**

涉改：
- `extensions/memory-milvus/src/tools.search.ts`（新建） — `createMemorySearchTool(deps)`：
  - 复刻 `MemorySearchSchema` 结构（对象字面量，字段 `query` / `maxResults` / `minScore` / `corpus`，与 `tools.shared.ts` L30-42 一对一）
  - corpus 路由：`memory` / undefined → `manager.search()`；`sessions` / `wiki` / `all` → `warnOnce` + 返回空
  - 命中后 recordRecall hook：`void manager.recordRecall?.(refs, ctx)`（manager 实现仍为 warn 占位，Task 12 完工）
  - 首次命中 warnOnce（`"citations rendering not yet supported in milvus backend; deferred to Task 16"`）
  - 复用 `filterMemorySearchHitsBySessionVisibility`
  - 返回 `MemoryReference[]` 原样，**不**装饰 snippet
- `extensions/memory-milvus/src/tools.get.ts`（新建） — `createMemoryGetTool(deps)`：
  - 复刻 `MemoryGetSchema` 结构（`path` / `from` / `lines` / `corpus` / `id`）
  - 实际仅用 `id`，其他参数占位忽略
  - 调 `manager.get(id)` 返回 `MemoryEntry`，**不**触发 recordRecall

测试：
- `tools.search.test.ts` — query 必填；`corpus=memory` 走 `manager.search`；`sessions`/`wiki`/`all` 返空 + warnOnce 被调；命中 recordRecall 被调；返回 MemoryReference 不含 `\n\nSource:` 后缀；**schema 字段集反向守护断言**（硬编码 `["query","maxResults","minScore","corpus"]`）
- `tools.get.test.ts` — id 路径正常 / not-found throw / closed throw / degraded throw / 不触发 recordRecall

验收：`pnpm test extensions/memory-milvus/src/tools.search.test.ts extensions/memory-milvus/src/tools.get.test.ts` 全绿。

**Step 3 —— Plugin 注册集成**

涉改：
- `extensions/memory-milvus/index.ts` — `register(api)` 内在现有 `memory_write` 注册之后**无条件**追加：
  ```ts
  api.registerTool(() => createMemorySearchTool({ getManager: () => activeManager }), { names: ["memory_search"] });
  api.registerTool(() => createMemoryGetTool({ getManager: () => activeManager }), { names: ["memory_get"] });
  ```
  删除 L246 `// memory_search / memory_get 工具由 Task 11 注册` 占位注释
- `extensions/memory-core/index.ts` — **不动**（slots.ts 已保障互斥）

测试：
- `extensions/memory-milvus/src/register.test.ts`（新建或并入 `index.test.ts`） — mock `OpenClawPluginApi`，调 `pluginEntry.register(mockApi)`，断言 `registerTool` 被调用 3 次，names 依次为 `["memory_write"]` / `["memory_search"]` / `["memory_get"]`（对应 Q3.7 mock api 单测方案）

验收：`pnpm test extensions/memory-milvus` 全绿；手工回归配置 `slots.memory = "memory-milvus"`，确认工具清单含三件。

**Step 4 —— 全量回归 + 文档归档**

涉改：
- `refactor/0-progress.md` — 追加 Task 11 完工总结：工程动作清单 5 条、决策引用 §13-§18、测试矩阵、风险回顾（R1/R4/R6 解除）
- `refactor/1-plan.md` — Task 11 小节标记 `**状态**：✅ 完成于 YYYY-MM-DD`
- `CHANGELOG.md`（按需） — `### Changes` 加一条：“memory-milvus: register memory_search / memory_get tools backed by Milvus (Alpha)”

测试：
- `pnpm test extensions/memory-milvus` 全绿
- `pnpm tsgo` 全绿
- `pnpm check:changed` 全绿
- （可选）`OPENCLAW_LIVE_TEST=1 pnpm test extensions/memory-milvus/src/memory-milvus.live.test.ts` 真实 Milvus 端到端

验收：所有自动化检查通过、文档同步、准备进入 Task 12（recordRecall 真实落库）。

**精简原则 & 依赖一致性**：
- 每步自洽可编译可测试，无反向依赖（Step N+1 不回改 Step N 文件）
- Step 1 底层独立 → Step 2 仅依赖 Step 1 manager 方法 → Step 3 仅做“粘合”代码量最小 → Step 4 纯验收归档
- 每步工程动作均可追溯到 decisions §13-§18 决策，无交叉冲突

### Task 12: 重写 Short-term Recall Tracking

> **状态**：✅ 完成于 2026-05-13

- 替代 `short-term-recall.json`（仅当 slot=`memory-milvus` 时；`memory-core` 文件后端路径不动）
- `MilvusSearchManager.recordRecall` 真实落库：`query + upsert` 两步（Milvus 平台约束，不支持原子 update），同步更新 `recall_count += 1` 与 `last_recalled_at = now()`
- 触发时机：每次 `memory_search` **命中后**（不是 `memory_get`，与 memory-core 行为一致）
- **接口签名**：沿用 H 方案 A2/A4 已锁定的 `recordRecall(refs: MemoryReference[], context?: { query; timezone? })`，无须再改 SDK
- **批量策略**：单次 `client.query(ids=...)` 取全字段 → 内存累加 `recall_count` + 写入 `last_recalled_at` → 单次 `client.upsert(rows)`；N 条命中 1 次往返
- **失败策略**（详见 decisions §12.7）：失败直接丢 + warnOnce，**不走 fallback**（召回埋点可丢，与写入兜底区别对待）
- **context 处理**：`query` / `timezone` Alpha 不落库（schema 无对应列）；`queryHashes` 等 9 维信号推 Task 16（详见 decisions §13.2）
- **Task 11 衔接**：替换 `MilvusSearchManager.recordRecall` warn 占位为真实实现；`tools.search.ts` 命中 hook 调用点保持不变
- **测试**：mock client query+upsert 链路（命中累加 / 空 refs 短路 / closed-degraded throw 透传 / upsert 失败 warn 不抛）；live 测试在 Task 13 端到端回归时统一补
- **Alpha 退出半步**：本任务完工后 `recordRecall` 不再 warn，但 `experimental` / `alpha` 标记仍保留；Task 13 完工撤下
- 详见 decisions §13.3 / §12.7 / §13.2

### Task 13: 重写 Dreaming Promotion

> **状态**：✅ 完成于 2026-05-13

- **Light dreaming**：`backend.search({ memoryType: "short_term", createdAfter: todayStart })` 替代 fs 遍历（详见 decisions §5.2）
- **REM dreaming**：`backend.search({ sessionKey })` 替代 `listSessionFiles`；entry.text 直接可用不再切分
- **Deep dreaming**：复用 H 方案 A4 补落地的 SDK `rankPromotionCandidates(opts)` + `applyPromotions(opts)`（阈值由调用方透传，milvus 侧直接实现两方法，SDK 无须再改）
- **Cron 归属**（Q1α）：**复用 memory-core 的 `dreaming.ts` 外壳**，通过现有 capability 钩子注入 milvus 采集/promotion 实现；阶段调度逻辑不重复（符合 §5.3 “阶段调度 = 共用”）
- **LLM 合并写回语义**（Q2α）：LLM 总结产出后：（1）新 `write()` 1 条 `memory_type="long_term"`（重 embed、保留 provenance 指向源）；（2）参与合并的 N 条原 short_term 记录 upsert 为 `memory_type="archived"`（不物理删除，物理 delete 推 Task 16）
- **live 测试补齐**（§12.8/§12.12）：`memory-milvus.live.test.ts` 中 `cfg = {} as any` 替换为真实 `OpenClawConfig` 构造；扩充端到端用例：write → search 命中 → recordRecall 累加 → dreaming 触发 → 新 long_term + 原记录 archived
- **9 维高级信号**（详见 decisions §13.2）：本任务仅用 `recall_count` + `last_recalled_at` 两维打分；`dailyCount`/`groundedCount`/`totalScore` 等 9 维仍占位推 Task 16
- **测试**：mock 全链路（采集 → 打分 → LLM 合并（stub） → 双写新 long + 原条 archive）；`OPENCLAW_LIVE_TEST=1` 端到端由真实 Milvus 跑
- **完工条件 = Alpha 退出全步**：撤下 `package.json` 的 `"stability": "experimental"` + 移除 README 的 “Alpha status” 标注 + live 端到端回归全绿（详见 decisions §12.7/§12.12）
- 详见 decisions §5 / §13.2 / §12.12

### Task 14: Markdown ⊓ Milvus 双向迁移工具 ✅ 完成

> **状态**：✅ 完成于 2026-05-13

- **依赖**：Task 13 完工后启动（插件主体已退出 Alpha）
- **CLI 形态**（Q1α）：独立子命令 `openclaw memory migrate <dir> [--reverse] [--dry-run]`，注册到 memory-milvus 插件的 CLI 钩子（与 `memory_write` 同插件）；不走插件启动自动 bootstrap
- **正向（Markdown → Milvus）**：
  - 输入：`<dir>/MEMORY.md` + `<dir>/memory/YYYY-MM-DD.md` 递归扫描
  - 切分：沿用 memory-core 现有 chunk 边界（复用 `dreaming-phases` 的 chunker），不重新设计
  - embed：走现有 `EmbeddingProvider`（text-embedding-v3 / 1024 维）
  - 写入：`MilvusSearchManager.write()`，`provenance.kind="file"` + `provenance.label` 保留原始 `memory/YYYY-MM-DD.md:Lstart-Lend`；`memory_type="short_term"`；`provenance source label=IMPORT`（复用 `MEMORY_SOURCE_LABELS.IMPORT` 枚举，详见 §12.3）
  - 失败：复用 §10.4 ndjson fallback，批量任务结束后输出失败报告
- **反向（Milvus → Markdown）**：
  - `--reverse` 模式：query 全量（分页）→ 按 `memory_type` 分类 → 写到独立输出目录 `memory-export/<timestamp>/MEMORY.md` + `memory-export/<timestamp>/memory/YYYY-MM-DD.md`（**不覆盖**原 `memory/*.md`）
  - 范围：默认全量（含 archived），`--type=short_term|long_term|archived` 可过滤
- **去重**（Q2α、轻量临时实现）：
  - 写入前计算 `sha256(text + provenance_label)` 作为纯内存发现去重键，同一 batch 内重复跳过
  - 跨 batch（重跑迁移）：靠 `provenance_label` 唯一性 — 写入前 `client.query(filter='provenance_label == "..."')` 检查，存在则 skip + 计数
  - 本任务**不动 schema**（不新增 `content_hash` 字段），sha256 仅用于运行期内存去重；Task 16 推 schema 字段 + SDK 标准能力时收敛（并迁移存量数据）
- **进度 / dry-run**：`--dry-run` 仅输出计划不写入；实际运行输出 `[N/total] file=... action=insert|skip|fail` 并返回全局计数（插入 / 跳过重复 / 失败）
- **测试**：
  - 单测：mock client + EmbeddingProvider，验证 chunk 走口 / sha256 去重 / `--reverse` 输出目录结构 / dry-run 不调 client.insert / fallback 触发
  - 集成：临时 fixtures 目录含 2 个 `memory/YYYY-MM-DD.md` + 1 个 `MEMORY.md`，跑全流程验证改变量
  - live：`OPENCLAW_LIVE_TEST=1` 下跑一次 forward + reverse 往返，验证 reverse 输出可被 forward 重新导入（sha256 去重生效，跳过计数 == 原条数）
- **文档**：`extensions/memory-milvus/README.md` 增 “Migration” 小节（命令示例 + 去重说明 + reverse 输出路径约定）
- **遗留移交 Task 16**：`content_hash` schema 字段化 + SDK 去重能力抽取 + 存量数据迁移到 schema字段去重
- 详见 decisions §12.3（`MEMORY_SOURCE_LABELS.IMPORT`） / §10.4（fallback） / §8.1 + §15（BM25 归 Task 16，与本任务无关）

### Task 15: 接入 memory slot

- 注册 `memory-milvus` 插件（kind: "memory"）
- 实现 `MemoryPluginCapability` 全套
- 配置 `plugins.slots.memory = "memory-milvus"` 切换

### Task 16: 去重、更新、删除、版本、citation、agent 隔离

- 去重：sha256 查重
- 更新：update + 重 embed
- 删除：软删除 `memory_type="archived"`
- 版本：metadata 记录修改历史
- citation：MemoryReference 含 citation
- agent 隔离：`agent_id` 字段 + 查询过滤
- **SDK backend 枚举正式扩展**：`"builtin" \| "qmd"` → `"builtin" \| "qmd" \| "milvus"`（撤下 memory-milvus 中 `resolveMemoryBackendConfig` 伪装 qmd 的 stub）
- **`memory_write` 对称规划**：文件后端也走 `memory_write`，复用 Task 11 的 slot 条件 register 机制
- **backend 侧会话可见性 expr 原生过滤**（Milvus collection expr `session_key == "..."`），与应用层 `filterMemorySearchHitsBySessionVisibility` 双层叠加
- **BM25 原生升级**（详见 decisions §8.1 + §15）：当 Milvus ≥ 2.4 服务端已创建 BM25 Function 后，`searchKeyword()` 切 `hybridSearch + WeightedRanker`，删除客户端 TF-IDF；schema 加 `FIELD_SPARSE_BM25` + 索引；含融合权重 w1/w2 参数化与 `extractKeywords` 算法治理
- **多 corpus 全量支持**（详见 decisions §17）：`corpus=sessions` → milvus 存 session 转录方案 + memory_type 过滤；`corpus=wiki` / `all` → 接入 `searchMemoryCorpusSupplements` / `getMemoryCorpusSupplementResult` 机制，与 milvus 命中多路融合排序
- **citation 装饰完整接入**（详见 decisions §18）：Task 16 评估 SDK 共享抽取三选：X（提到 `packages/memory-host-sdk`）/ Y（memory-core runtime-api 导出）/ Z（milvus 复刻，不推荐）；接入 `cfg.memory.citations: "on"|"off"|"auto"`，覆盖 direct/group auto 模式
- **高级召回维度（对标 OpenClaw 官方 11 维打分）**：
  - 字段：`dailyCount` / `groundedCount` / `totalScore` / `maxScore` / `firstRecalledAt` / `queryHashes` / `recallDays` / `conceptTags` / `claimHash`
  - 状态：**待定**，评估是否采纳官方多维加权打分模型升级 Task 13 Deep Dreaming
  - 触发：`recordRecall` 扩展 + Collection schema 扩字段

---

## 执行顺序

```
任务1: 梳理职责           } 
任务2: 提取通用概念        }  第一部分：接口抽象重构
任务3: 演化接口            }
任务4: 重构 memory-core    }
任务5: 改造 search/get     }
任务6: 重构 flush          }
    ↓
任务7: 确认替代关系
任务8: 设计 Collection
任务9: 重写搜索（ANN+BM25）
任务10: 重写 flush/capture
任务11: 重写工具
任务12: 重写召回追踪       } 第二部分：memory-milvus 实现
任务13: 重写 Dreaming
任务14: 迁移工具（延后）
任务15: 接入 slot
任务16: 去重/隔离/版本
```

---

## Task 10 执行步骤总表（聚合版）

> 基于 `2-decisions.md` §12 全部决策与 Task 10 的 10.1–10.10 拆分，聚合为**单线串行**的 7 步执行清单。按 S1 → S7 顺序推进，每步独立 commit 与验收，禁止跳步或并行。

### S1. 类型契约与常量枚举打底

**依据**：§12.3 / §12.2 / 10.2

**做什么**：
1. 在 `extensions/memory-milvus/src/types.ts` 导出常量：
   - `MEMORY_SOURCE_LABELS`（`chat_extract` / `user_manual` / `recall_promotion` / `import`）
   - `MEMORY_TYPES`（`short_term` / `long_term` / `archived`）
2. 从常量派生类型别名：`MemorySourceLabel` / `MemoryType`
3. 新增校验函数：`assertValidSourceLabel(label)` / `assertValidMemoryType(t)`，越界立即抛错
4. 补充 `MilvusMemoryEntryMetadata` 类型（`agentId` / `session_key` / `memory_type` / `createdAt: number` / `provenance: { label: MemorySourceLabel }`）

**验收**：types.ts 单测覆盖枚举值和越界抛错；`pnpm build` 通过。

### S2. Collection 初始化基础设施（含 init 接入 + degraded 状态）

**依据**：§12.1 / §12.6 / 10.1

**做什么**：
1. 新建 `extensions/memory-milvus/src/collection-bootstrap.ts`，实现 `ensureCollectionReady(client, config)`：
   - `describe_collection` 探测 → 不存在则 `create_collection`（Task 8 schema + `metadata JSON` 兜底字段，不启用 `enable_dynamic_field`）
   - `has_index` 探测 → 不存在则 `create_index`（HNSW，`M` / `efConstruction` / `metric_type` 从 config 读）
   - `get_load_state` 探测 → 未加载则 `load_collection`
   - 每步幂等，"已存在"不视作错误
2. 在 `extensions/memory-milvus/index.ts` 的 `init` hook 里调用 `ensureCollectionReady`：
   - 成功 → `activeManager` 正常实例化
   - 失败（连不上等）→ warn 日志 + 仍实例化 `activeManager`，内部标记 `degraded = true`，**不** 抛错阻止启用
3. `MilvusSearchManager.status()` 返回值新增 `degraded` 字段（供上层/UI 感知）

**验收**：mock client 单测覆盖"全新创建 / 已存在 / 部分存在"三种 bootstrap 场景；"连通成功 init ok" / "连不上 init 不抛 + status degraded" 两种 init 场景。

### S3. Fallback 基础设施

**依据**：§12.5 / 10.4

**做什么**：
1. 新建 `extensions/memory-milvus/src/fallback.ts`
2. 常量：`FALLBACK_DIR = "memory/.milvus-fallback"`、文件命名 `YYYY-MM-DD.ndjson`
3. 实现 `writeFallback(entry)`：序列化 entry 为 JSON 追加到当日 ndjson，带行级文件锁
4. 实现 `replayFallback(writer)`：遍历目录待处理文件，逐条 `writer(entry)` 回放；成功条目移除或标记，失败保留
5. 实现 `pendingFallbackCount()`：供 `status()` 上报

**验收**：单测覆盖"写入 → 回放成功 → 文件清空"与"写入 → 回放部分失败 → 失败条目保留"两条路径。

### S4. MilvusSearchManager.write 核心实现（含 recordRecall 占位）

**依据**：§12.2 / §12.5 / §12.7 / 10.3 / 10.8（**核心步骤，单个 commit 最大**）

**做什么**（严格按顺序）：
1. 在 `extensions/memory-milvus/src/search.ts::MilvusSearchManager` 新增 `write(entry): Promise<MemoryReference>`
2. 入口组装 metadata：
   - `agentId`：从构造参数读（Host 注入）
   - `session_key`：从参数读；默认值待 Host 明确，暂留 TODO
   - `memory_type`：写死 `"short_term"`
   - `createdAt`：`Date.now()` UTC 毫秒
   - `provenance.label`：从调用方传入（默认由 tool 注入 `chat_extract`）
   - 调 `assertValidSourceLabel` / `assertValidMemoryType` 校验
3. 写入流程：
   - 探测 milvus 健康（`ping` 或轻量 `describe_collection`）
   - 健康 → 先 `replayFallback()` 批量回灌，再执行新写入
   - 新写入：`EmbeddingProvider.embed(text)` → `collection.insert`
   - 返回 `MemoryReference`（id 用 Milvus PK，字符串化）
4. 失败兜底：
   - embed 失败 / insert 失败 / 健康探测失败 → `writeFallback(entry)` + warn + 返回占位 `MemoryReference`（id 带 `fallback:` 前缀）
5. 同文件新增 `recordRecall(refs, context?)` 占位：
   - 实现仅为 `logger.warn("[memory-milvus] recordRecall not yet implemented (Task 12)")` + return
   - 方法上方加 `// TODO(Task 12): replace with real milvus recall_count update`
   - 不做任何持久化

**验收**：单测覆盖 write 四条路径（成功 / embed 失败 / insert 失败 / degraded 直 fallback）+ recordRecall 调用不抛错且仅 warn。

### S5. AI 调用链端到端打通（memory_write 工具 + 白名单 + prompt）

**依据**：10.5 / 10.6 / 10.7 / §12.3 / §12.9（跨包三件套，缺一不可）

**做什么**：
1. **工具注册**（`extensions/memory-milvus/src/tools.ts` 或内联 `index.ts`）：
   - 注册 `memory_write`，schema `{ text: string, label?: MemorySourceLabel }`
   - label 默认 `MEMORY_SOURCE_LABELS.CHAT_EXTRACT`
   - handler：`assertValidSourceLabel(label)` → `activeManager.write({ text, provenance: { label } })`
   - 仅在 milvus 后端激活时注册（通过现有 backend kind 判断）
2. **核心白名单**（`src/agents/pi-tools.ts` L98）：
   - 改为 `const MEMORY_FLUSH_ALLOWED_TOOL_NAMES = new Set(["read", "write", "memory_write"]);`
   - **不动** `wrapToolMemoryFlushAppendOnlyWrite` 装饰逻辑（`write` 仍走 wrap，`memory_write` 不包装）
3. **prompt 对齐验证**（`extensions/memory-milvus/index.ts::buildMilvusFlushPlan` L60-71）：
   - 确认 prompt 明确引导 AI 调 `memory_write(text)`，**不**引导调 `write({path, content})`
   - 如不一致，复用 `extensions/memory-core/src/flush-plan.ts` 的通用 hint 构造
   - 确保 `MemoryFlushPlan.backendKind === "milvus"`

**验收**：
- 工具单测：合法 label 写入成功 / 非法 label 抛错 / 非 milvus 后端不注册
- pi-tools：`pnpm check:changed` 通过；grep 确认 wrap 逻辑未被误改；文件后端 flush 行为零回归
- prompt snapshot 断言：包含 `memory_write` 字样，不含 `write(` / `path` 关键词

### S6. Alpha 标记 + 测试整合

**依据**：10.9 / §12.7 / §12.8 / 10.10

**做什么**：
1. **Alpha 标记**：
   - `extensions/memory-milvus/package.json` 加字段 `"stability": "experimental"`（或 OpenClaw manifest 对应字段）
   - 新增/更新 `extensions/memory-milvus/README.md`：
     - 明确标注"Alpha 状态"
     - 说明"promotion 链路依赖 Task 12 / 13 完工"
     - 列出当前支持 / 不支持的能力
   - 引用 plan.md Task 13 完工条件（撤标签）
2. **Live 测试骨架**：
   - 新建 `extensions/memory-milvus/src/*.live.test.ts`，至少覆盖 write → search 端到端一条用例
   - 用 `describe.skipIf(!process.env.OPENCLAW_LIVE_TEST)` 保护
   - README 说明本地启 Milvus 的方式
   - **不引入** milvus-lite 或其他 embedded 方案
3. **Mock 单测收口**：S1–S5 产出的所有 `*.test.ts` 能被 `pnpm test extensions/memory-milvus` 一把跑绿

**验收**：默认 CI 跳过 live 测试；`OPENCLAW_LIVE_TEST=1 pnpm test:live extensions/memory-milvus` 本地连通 Milvus 时全绿；package.json stability 字段可被插件 loader 读取。

### S7. 构建 / 验收 / 进度同步收尾

**依据**：常规验收 + AGENTS.md

**做什么**：
1. `pnpm build` 全绿
2. `pnpm test extensions/memory-milvus` 全绿
3. `pnpm check:changed` 全绿（lint / format / type）
4. 在 `refactor/0-progress.md` 末尾**追加** Task 10 完成记录（遵循项目文档约定，进度只写入 0-progress.md）
5. 记录内容：完成日期、S1–S6 对应改动文件清单、验收证据（测试数字）、遗留技术债（pi-tools 白名单归属 / `recordRecall` 占位 / `session_key` 默认值 TODO 等）

**验收**：三绿 + 进度文档更新。

### 关键不变式（贯穿 S1–S7）

- ✅ 文件后端零回归（S5 只追加白名单，不动 wrap 装饰）
- ✅ Milvus 不可用时写入不丢（S3 fallback 基础设施 + S4 写入兜底链路）
- ✅ Label / Type 越界即抛错（S1 校验函数 + S4/S5 入口复用）
- ✅ 插件标为 Alpha（S6），Task 13 完工时撤标签

### 不在 Task 10 范围（明确排除）

- Task 11：`memory_search` / `memory_get` / `memory_recall` 工具重写
- Task 12：`recordRecall` 正式实现（milvus 字段更新）
- Task 13：Dreaming promotion + 撤 Alpha 标签
- Task 16：sha256 去重、update / delete / 版本、citation
- 架构统一：pi-tools 白名单下沉、文件后端改走 `memory_write`
