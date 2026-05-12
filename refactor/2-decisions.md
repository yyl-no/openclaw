# 记忆系统接口重构 — 讨论决策记录

> 基于 `MEMORY_MILVUS_PLAN.md`（3.md）思路，不新增接口，演化现有接口。

---

## 1. 接口重构原则

- `MemorySearchManager` → `MemoryDataBackend`（重命名 + 扩展，不并存）
- `MemorySearchResult` → `MemoryReference`（path/line 编码进 id）
- `MemoryReadResult` → `MemoryEntry`（扩展为通用条目）
- `write` / `recordRecall` / `promote` 从散落各处收拢到接口

---

## 2. id 抽象

上层只认 `id`，后端各自解析：

| 后端 | id 格式 | get(id) 实现 |
|------|---------|-------------|
| 文件 | `"file:memory/2026-05-11.md:20:25"` | 解析 path+line，fs.readFile |
| Milvus | `"453218790342567891"`（主键） | collection.query(pk) |

```typescript
type MemoryReference = {
  id: string;
  snippet: string;
  score: number;
  provenance: {
    kind: "file" | "milvus";
    label: string;    // "memory/05-11.md L20-25" or "Milvus #abc123"
  };
};

type MemoryEntry = {
  id: string;
  text: string;
  agentId?: string;
  sessionKey?: string;
  memoryType?: "short_term" | "long_term" | "archived";
  provenance: { kind: "file" | "milvus"; label: string };
};

interface MemoryDataBackend {
  search(query, opts) → MemoryReference[];
  get(id: string) → MemoryEntry;
  write(entry) → MemoryReference;
  recordRecall(ids: string[]);
  promote(ids: string[]);
  status() / sync() / close();
}
```

**关键**：`get(id)` 只接受 id 字符串，不传整个 MemoryReference。

---

## 3. Flush 写入路径

```typescript
type MemoryFlushPlan = {
  relativePath?: string;              // 仅文件后端，改为 optional
  backendKind?: "file" | "milvus";    // 新增
};
```

| 后端 | 返回 | pi-tools.ts 行为 |
|------|------|-----------------|
| 文件 | `{ relativePath, backendKind:"file" }` | wrapToolMemoryFlushAppendOnlyWrite（现逻辑不变） |
| Milvus | `{ backendKind:"milvus" }` | 不包装 write，走 plugin 的 memory_write 工具 |

---

## 4. short-term-promotion 改动

### 4.1 核心变更：key 从 path+line 变为 id

```
改前：
  ShortTermRecallEntry.key = "memory:memory/05-11.md:20:25:abc"
  ShortTermRecallEntry 存 path / startLine / endLine 三个独立字段

改后：
  ShortTermRecallEntry.key = "file:memory/05-11.md:20:25" 或 "267839287"（Milvus PK）
  ShortTermRecallEntry 只存 id，删除 path/startLine/endLine 字段
```

### 4.2 recordShortTermRecalls 改参数

| | 改前 | 改后 |
|---|------|------|
| 输入 | `results: MemorySearchResult[]` | `results: MemoryReference[]` |
| 取 key | `buildEntryKey(path, startLine, endLine)` | `result.id` |
| 评分逻辑 | recallCount/totalScore/maxScore 累计 | **不变** |

### 4.3 rehydratePromotionCandidate 改读取方式

```
改前：rehydrate 自己直接读文件
  fs.readFile(candidate.path, "utf-8") → split → 按行号截取

改后：rehydrate 走后端统一接口
  backend.get(candidate.id)
    ├─ 文件后端：内部解析 id → fs.readFile
    └─ Milvus后端：PK 查询 → 直接返回
```

### 4.4 改动范围

- 受影响：约15%（1991行中 ~300行）
- 不动：评分算法（频率/相关性/多样性/衰减）、queryHash 去重、概念标签
- 不向后兼容：short-term-recall.json 格式变化

---

## 5. Dreaming 改动

### 5.1 接口抽象阶段：只改输出

dreaming-phases.ts 保留文件操作不变，只在末尾把 path+line 编码成 id：

```
改前：
  fs.readFile → MemorySearchResult[] → recordShortTermRecalls
                  { path, startLine, endLine }

改后：
  fs.readFile → MemoryReference[] → recordShortTermRecalls
                  { id: "file:memory/05-11.md:20:25" }
```

### 5.2 memory-milvus 版：全新实现数据采集

| | memory-core | memory-milvus |
|---|---|---|
| Light 采集 | fs.readdir + fs.readFile + chunk | backend.search({ memoryType, createdAfter }) |
| REM 采集 | listSessionFiles + 读文件 | backend.search({ sessionKey }) |
| 切分 | 按行数切 chunk | 不需要，entry.text 直接可用 |

### 5.3 共用与独立

| | promotion | dreaming |
|---|---|---|
| 共用 | 评分算法（频率/衰减/去重） | 阶段调度（Light/REM/Deep触发、Cron、配置） |
| 独立 | 存储读写（JSON vs Milvus字段） | 数据采集（fs遍历 vs backend.search） |

---

## 6. Milvus 部署与切换

- 本地 Docker 部署
- 通过 `plugins.slots.memory` 互斥切换：

```json5
{ "plugins": { "slots": { "memory": "memory-core" } } }
{ "plugins": { "slots": { "memory": "memory-milvus" } } }
```

---

## 7. Agent 隔离

| | memory-core（官方） | memory-milvus |
|---|---|---|
| 隔离方式 | 文件系统物理隔离 | Collection 内逻辑隔离 |
| 实现 | 每个 agent 独立 workspace 目录，独立 MEMORY.md + memory/*.md + SQLite DB | 共享 Collection，`agent_id` 字段过滤 |
| 搜索 | 仅搜索当前 workspace 目录 | `filter: agent_id == "xxx"` |
| 效果 | 完全物理隔离，互不可见 | 逻辑等价，隔离效果一致 |

---

## 8. 搜索方式

memory-milvus 采用**混合检索（ANN + 关键词）**，与 memory-core 行为对应：

| | memory-core | memory-milvus |
|---|---|---|
| 向量搜索 | sqlite-vec | Milvus ANN |
| 文本搜索 | SQLite FTS5 | Milvus scalar filter / BM25 |
| 评分融合 | vectorScore + textScore | 同样加权融合 |

**除底层向量数据库不同外，搜索行为、工具参数、返回格式与 memory-core 完全一致。**

### 8.1 BM25 现状与临时策略（2026-05-12 确认）

`@zilliz/milvus2-sdk-node` v2.4.11 **不提供** `createFunction` / `BM25EmbeddingFunction` API，
无法通过 Node.js 代码创建 BM25 Function。BM25 Function 需在 Milvus 服务端通过 RESTful
API v2 或管理工具（pymilvus / Attu）手动创建后再对接。

**当前实现（第一阶段）**：

| 检索路 | 方式 | 评分 |
|--------|------|------|
| 向量 ANN | `search({ anns_field: "embedding" })` | 原生 cosine/L2 距离 |
| 文本关键词 | `query({ filter: 'text like "%keyword%"' })` | 客户端 TF-IDF 计算 textScore |
| 融合 | `WeightedRanker` 或客户端加权 | `score = w1 × vectorScore + w2 × textScore` |

**⚠️ TODO — 迁移到原生 BM25**：

> 当 Milvus 实例 ≥ 2.4 且已创建 BM25 Function 后：
> 1. 在 `memory-milvus/src/search.ts` 中将 `searchKeyword()` 的 `query(filter)` 替换为
>    `hybridSearch({ data: [{ anns_field: "sparse_bm25" }], rerank: WeightedRanker(...) })`
> 2. 删除客户端 TF-IDF 计算逻辑
> 3. 跑一遍 `pnpm test extensions/memory-milvus` 确认 textScore 仍然正常产出加权融合结果

---

## 9. Collection Schema

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

- embedding 模型：阿里云 text-embedding-v3（1024维）
- index 类型：IVF_FLAT 或 HNSW（根据数据量选择）
- agent 隔离：一个 Collection 存所有 agent，通过 `agent_id` 字段过滤

### 9.1 Embedding Provider 策略（2026-05-12 确认）

`memory-milvus` 本身不注册独立的 Embedding Provider，而是复用项目已有的
`MemoryEmbeddingProvider` 基础设施。embed + search 代码通过 `EmbeddingProvider.embedSingle()` /
`EmbeddingProvider.embedBatch()` 获取向量，不与任何具体模型 API 耦合。

**⚠️ TODO — 切换到目标模型**：

> 当需要切换到最终使用的 embedding 模型时：
> 1. 新增对应的 embedding provider adapter（参考 `extensions/openai/` 的模式），
>    注册为 `registerMemoryEmbeddingProvider(adapter)`
> 2. `memory-milvus` 的 search / write 代码**零改动** — provider 层对上层透明
> 3. 跑 `pnpm test extensions/memory-milvus` 确认对应维度向量读写正常

---

## 10. 改动文件清单

| 文件 | 改动 |
|------|------|
| `packages/memory-host-sdk/.../types.ts` | MemorySearchManager→MemoryDataBackend，类型演化 |
| `extensions/memory-core/src/memory/manager.ts` | `implements MemoryDataBackend` |
| `extensions/memory-core/src/tools.ts` | memory_get schema 改为 id |
| `extensions/memory-core/src/flush-plan.ts` | 加 backendKind |
| `extensions/memory-core/src/short-term-promotion.ts` | key 改为 id |
| `extensions/memory-core/src/dreaming-phases.ts` | 底部 path/startLine/endLine 三字段合并为 MemoryReference.id |
| `src/plugins/memory-state.ts` | MemoryFlushPlan 加字段 |
| `src/agents/pi-tools.ts` | flush 工具路由分流 |
| `extensions/memory-milvus/` | **全部新建** |

---

## 11. Flush 路径统一方案（方案 H）— 补充决策

> 本节为第 3 节 "Flush 写入路径" 的**细化决策**，不替换原表格，仅明确最终实现方式。

### 11.1 背景：原表格的歧义

原第 3 节表格：

| 后端 | pi-tools.ts 行为 |
|------|-----------------|
| 文件 | wrapToolMemoryFlushAppendOnlyWrite（现逻辑不变） |
| Milvus | 不包装 write，走 plugin 的 memory_write 工具 |

该表格允许两种解读：

- **解读 A（双路径并存）**：文件后端 AI 调 `file write`，milvus 后端 AI 调 `memory_write` → 切换后端时 AI 工具链改变
- **解读 B（单路径统一）**：所有后端 AI 都调 `memory_write`，文件后端的 `memory_write` 底层调 `backend.write()` → 切换后端时 AI 工具链不变

### 11.2 最终决策：采用解读 B（方案 H）

**决策**：AI flush turn 统一调用 `memory_write` 工具，文件后端和 milvus 后端只在 `backend.write()` 内部的"最后一公里"实现上不同。

**原因**：核心目标是"切到 milvus 后仅数据库不同，其他都保持相同"。只有解读 B 能做到 AI 工具集 / prompt / 调用方代码全部一致。

### 11.3 统一调用链

```
[AI flush turn]
    ↓ 调用 memory_write(text)
[memory_write 工具]
    ↓ backend.write(entry)
[MemoryDataBackend.write]
    ├─ 文件后端 → appendMemoryFileSafe() → fs.appendFile 到 memory/YYYY-MM-DD.md
    └─ Milvus   → embed + collection.insert
```

对比原 `wrapToolMemoryFlushAppendOnlyWrite` 路径：保留为**兜底**（AI 意外调用 file write 时仍受保护），但不再是 flush turn 主路径。

### 11.4 对现有决策的细化

| 第 3 节原决策 | 方案 H 细化 |
|-------------|-----------|
| 文件：`wrapToolMemoryFlushAppendOnlyWrite`（现逻辑不变） | 拆为公共函数 `appendMemoryFileSafe()`，由 `backend.write()` 和 wrap 工具**共享调用** |
| Milvus：走 plugin 的 `memory_write` 工具 | **所有后端**（含文件）的 flush turn 都走 `memory_write` 工具 |
| `MemoryFlushPlan.relativePath` 仅文件后端有 | 保留；`memory_write` 工具内部自行计算路径，不依赖此字段 |

### 11.5 新增基础设施

- **公共原语**：`extensions/memory-core/src/memory/memory-append-safe.ts::appendMemoryFileSafe()` —— 封装路径白名单、保留文件拒写、文件锁、append-only、行号返回
- **新工具**：`extensions/memory-core/src/tools.ts::createMemoryWriteTool()` —— AI flush turn 调用入口
- **日期函数导出**：`flush-plan.ts::formatDateStampInTimezone` 改为 export

### 11.6 接口方法签名细化

| 方法 | 签名决策 | 原因 |
|------|---------|------|
| `write(entry)` | `write(entry: Omit<MemoryEntry, "id">): Promise<MemoryReference>` | 文件后端忽略元数据只写 text；milvus 完整使用 |
| `recordRecall(refs, context?)` | 参数从 `ids: string[]` **扩展为 `refs: MemoryReference[]` + 可选 context** | 保留 score/snippet/query 用于 promotion 评分，否则信号退化 |
| `promote(ids)` | `promote(ids: string[]): Promise<void>` | 保持简单，内部自行 rank+apply |

### 11.7 调用方收敛

- `tools.ts::queueShortTermRecallTracking` → 改调 `manager.recordRecall(refs)`（替代直调 `recordShortTermRecalls`）
- `dreaming.ts::L601` → 改调 `manager.promote(ids)`（替代直调 `applyShortTermPromotions`）
- 原 `recordShortTermRecalls` / `applyShortTermPromotions` 函数保留为 `@internal`，供现有测试和 backend 内部调用

### 11.8 风险与兜底

- `wrapToolMemoryFlushAppendOnlyWrite` **保留**，作为 AI 误用 file write 时的安全兜底
- 旧 `memory/*.md` 文件格式不变，无数据迁移
- 分阶段实施降低回归风险（详细执行计划见 `1-plan.md` §方案 H 执行计划，拆分为 H-A / H-B 两段独立执行）

## 12. Task 10 实施细节决策

> 本节为 Task 10「重写写入 capture/flush 流程」的实施细节决策。
> **与 §11 的关系**：§11 的"解读 B（单路径统一）"是最终目标；Task 10 当下采用**路线 A 分阶段渐进**——先让 milvus 后端可用（双路径并存），Task 16 之后再合并到 B。

### 12.1 Milvus Collection 生命周期

- **Eager init**：插件 `init` 阶段即创建 Collection，不延迟到首次写入
- **原子化三步**：`create_collection` → `create_index`（向量字段 HNSW）→ `load_collection`
- **幂等**：每一步前先 `describe_collection` / `has_index` 探测存在，已存在则跳过
- **重启检查**：每次 init 必检 loaded 状态，未 loaded 则补 `load_collection`
- **动态字段策略**：采用"固定 schema + 一个 `metadata JSON` 兜底字段"方案，**不启用** `enable_dynamic_field=True`（避免 schema 污染，保持索引策略可控）
- **索引参数**：`HNSW` 的 `M` / `efConstruction` / `metric_type` 从插件 config 读取，不写死

### 12.2 Metadata 字段来源分工

| 字段 | 来源层 | 说明 |
|------|--------|------|
| `agentId` | Host | Host 知道当前 agent 身份，不由插件猜测 |
| `session_key` | Host/Manager | 会话标识，用于隔离同一 agent 的不同聊天窗口 |
| `memory_type` | Manager | 默认写死 `"short_term"`，Task 16 短时→长时升级时改为 `"long_term"` / `"archived"` |
| `createdAt` | Manager | 统一 UTC 毫秒数，抛弃本地时区依赖 |
| `provenance.label` | Tool/Manager | 按 §12.3 溯源字典注入 |

### 12.3 常量枚举与防呆

在 `extensions/memory-milvus/src/types.ts` 强制导出两个常量：

```ts
export const MEMORY_SOURCE_LABELS = {
  CHAT_EXTRACT: 'chat_extract',         // AI flush 时提取
  USER_MANUAL: 'user_manual',           // 用户在 UI 上手动添加
  RECALL_PROMOTION: 'recall_promotion', // Dreaming 升级产生
  IMPORT: 'import',                     // 老数据迁移导入
} as const;

export const MEMORY_TYPES = {
  SHORT_TERM: 'short_term',
  LONG_TERM: 'long_term',
  ARCHIVED: 'archived',
} as const;
```

- **校验策略**：`memory_write` 工具执行前强校验 `provenance.label`，越界即抛错（label 由代码注入，越界即 bug，应早暴露）
- `memory_type` 同样受枚举约束

### 12.4 Timezone 字段去留

- **决策**：底层 `MemoryEntry` 不存 timezone 字段，`createdAt` / `updatedAt` 统一 UTC 毫秒数
- **UI 转换**：本地时间展示由前端按浏览器时区自行转换，或在更高层业务逻辑处理，不污染底层数据结构
- 与 Task 8 Schema 一致（Task 8 本就未定义 timezone）

### 12.5 写入兜底（方案 4B）

- **兜底目录**：`memory/.milvus-fallback/YYYY-MM-DD.ndjson`（独立于 file backend 主目录，避免耦合）
- **写入流程**：milvus 不可用时，整条 entry 序列化为 ndjson 追加
- **回放时机**：每次 `write()` 调用前先探测 milvus 健康：
  1. 健康 → 批量回放 fallback 目录待处理条目
  2. 回放成功 → 从 ndjson 移除（或标记已处理）
  3. 回放失败 → 保留条目等下次重试
  4. 最后写新记录
- **回放粒度**：按文件批处理，单条失败不影响其他条目

### 12.6 Milvus Init 连不上的行为

- **决策**：warn + 不阻止插件启用 + 写入自动走 §12.5 fallback
- `MilvusSearchManager.status()` 上报 `degraded` 状态
- 每次 `write()` 前尝试 reconnect（复用已有连接池/客户端）
- 不采用"拒绝启用"方案，避免 milvus 短暂不可用时用户完全无法写记忆

### 12.7 recordRecall 失败策略

- **决策**：失败直接丢 + warn 日志，**不走 fallback**
- 理由：召回埋点非关键数据，丢了只影响 Task 16 短时→长时升级信号密度，不会丢失用户记忆主体
- 与 §12.5 写入兜底区别对待：写入必须零丢失，召回可容忍丢失
- **过渡期（Task 10 完成到 Task 12/13 完工前）**：memory-milvus 插件标注为 `experimental` / `alpha` 状态，通过 manifest 与 README 明确说明 promotion 链路依赖后续任务完工。Alpha 期间 recordRecall 仅 warn，不做任何持久化；Task 13 完工时撤下标签并做端到端回归。

### 12.8 测试策略

- **单元测试（默认 CI）**：mock `@zilliz/milvus2-sdk-node` 的 client，覆盖 `MilvusSearchManager` 各方法的逻辑分支、metadata 组装、label/type 枚举校验、fallback 触发条件
- **集成/Live 测试**：需真实 Milvus 实例的测试放在 `*.live.test.ts` 或通过 `OPENCLAW_LIVE_TEST=1` 开关运行，默认 CI 跳过
- **不引入 milvus-lite**：embedded 方案复杂度过高，成本不匹配收益
- **Fallback 测试**：在单测里 mock client 抛错模拟断连，验证 ndjson 写入与回放逻辑
- 文件定位：`extensions/memory-milvus/src/*.test.ts` 与 `extensions/memory-milvus/src/*.live.test.ts`

### 12.9 pi-tools 白名单归属（务实决策）

- **现状**：`MEMORY_FLUSH_ALLOWED_TOOL_NAMES` 硬编码在 `src/agents/pi-tools.ts` L98，Task 10 会追加 `memory_write`
- **决策**：暂时接受硬编码，不做架构下沉（manifest 注册 / 核心注册 API 等方案）
- **理由**：
  - memory 能力是核心通用能力，不是纯业务 owner 专属，白名单放核心可接受
  - 架构下沉改动面涉及 plugin 系统基础设施，成本高、收益有限
  - 当前只追加一个 `memory_write`，未来如果出现更多 memory 相关插件工具，再统一重构
- **遗留事项**：记录为技术债，留待 Task 16 之后的架构统一阶段评估是否下沉

