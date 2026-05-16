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

| 后端   | id 格式                             | get(id) 实现                |
| ------ | ----------------------------------- | --------------------------- |
| 文件   | `"file:memory/2026-05-11.md:20:25"` | 解析 path+line，fs.readFile |
| Milvus | `"453218790342567891"`（主键）      | collection.query(pk)        |

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
  relativePath?: string; // 仅文件后端，改为 optional
  backendKind?: "file" | "milvus"; // 新增
};
```

| 后端   | 返回                                   | pi-tools.ts 行为                                 |
| ------ | -------------------------------------- | ------------------------------------------------ |
| 文件   | `{ relativePath, backendKind:"file" }` | wrapToolMemoryFlushAppendOnlyWrite（现逻辑不变） |
| Milvus | `{ backendKind:"milvus" }`             | 不包装 write，走 plugin 的 memory_write 工具     |

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

|          | 改前                                      | 改后                         |
| -------- | ----------------------------------------- | ---------------------------- |
| 输入     | `results: MemorySearchResult[]`           | `results: MemoryReference[]` |
| 取 key   | `buildEntryKey(path, startLine, endLine)` | `result.id`                  |
| 评分逻辑 | recallCount/totalScore/maxScore 累计      | **不变**                     |

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

|            | memory-core                      | memory-milvus                                |
| ---------- | -------------------------------- | -------------------------------------------- |
| Light 采集 | fs.readdir + fs.readFile + chunk | backend.search({ memoryType, createdAfter }) |
| REM 采集   | listSessionFiles + 读文件        | backend.search({ sessionKey })               |
| 切分       | 按行数切 chunk                   | 不需要，entry.text 直接可用                  |

### 5.3 共用与独立

|      | promotion                      | dreaming                                   |
| ---- | ------------------------------ | ------------------------------------------ |
| 共用 | 评分算法（频率/衰减/去重）     | 阶段调度（Light/REM/Deep触发、Cron、配置） |
| 独立 | 存储读写（JSON vs Milvus字段） | 数据采集（fs遍历 vs backend.search）       |

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

|          | memory-core（官方）                                                       | memory-milvus                        |
| -------- | ------------------------------------------------------------------------- | ------------------------------------ |
| 隔离方式 | 文件系统物理隔离                                                          | Collection 内逻辑隔离                |
| 实现     | 每个 agent 独立 workspace 目录，独立 MEMORY.md + memory/\*.md + SQLite DB | 共享 Collection，`agent_id` 字段过滤 |
| 搜索     | 仅搜索当前 workspace 目录                                                 | `filter: agent_id == "xxx"`          |
| 效果     | 完全物理隔离，互不可见                                                    | 逻辑等价，隔离效果一致               |

---

## 8. 搜索方式

memory-milvus 采用**混合检索（ANN + 关键词）**，与 memory-core 行为对应：

|          | memory-core             | memory-milvus               |
| -------- | ----------------------- | --------------------------- |
| 向量搜索 | sqlite-vec              | Milvus ANN                  |
| 文本搜索 | SQLite FTS5             | Milvus scalar filter / BM25 |
| 评分融合 | vectorScore + textScore | 同样加权融合                |

**除底层向量数据库不同外，搜索行为、工具参数、返回格式与 memory-core 完全一致。**

### 8.1 BM25 现状与临时策略（2026-05-12 确认）

`@zilliz/milvus2-sdk-node` v2.4.11 **不提供** `createFunction` / `BM25EmbeddingFunction` API，
无法通过 Node.js 代码创建 BM25 Function。BM25 Function 需在 Milvus 服务端通过 RESTful
API v2 或管理工具（pymilvus / Attu）手动创建后再对接。

**当前实现（第一阶段）**：

| 检索路     | 方式                                         | 评分                                        |
| ---------- | -------------------------------------------- | ------------------------------------------- |
| 向量 ANN   | `search({ anns_field: "embedding" })`        | 原生 cosine/L2 距离                         |
| 文本关键词 | `query({ filter: 'text like "%keyword%"' })` | 客户端 TF-IDF 计算 textScore                |
| 融合       | `WeightedRanker` 或客户端加权                | `score = w1 × vectorScore + w2 × textScore` |

**⚠️ TODO — 迁移到原生 BM25**：

> 当 Milvus 实例 ≥ 2.4 且已创建 BM25 Function 后：
>
> 1. 在 `memory-milvus/src/search.ts` 中将 `searchKeyword()` 的 `query(filter)` 替换为
>    `hybridSearch({ data: [{ anns_field: "sparse_bm25" }], rerank: WeightedRanker(...) })`
> 2. 删除客户端 TF-IDF 计算逻辑
> 3. 跑一遍 `pnpm test extensions/memory-milvus` 确认 textScore 仍然正常产出加权融合结果

---

## 9. Collection Schema

| 字段               | 类型                | 说明                              |
| ------------------ | ------------------- | --------------------------------- |
| `id`               | Int64（主键、自增） | Milvus 自动分配                   |
| `embedding`        | FloatVector(1024)   | 阿里云 text-embedding-v3          |
| `text`             | VarChar(65536)      | 记忆内容，64k上限                 |
| `snippet`          | VarChar(4096)       | 搜索预览片段                      |
| `agent_id`         | VarChar(256)        | Agent 标识                        |
| `session_key`      | VarChar(512)        | 会话标识                          |
| `memory_type`      | VarChar(32)         | short_term / long_term / archived |
| `recall_count`     | Int32               | 召回频次                          |
| `provenance_kind`  | VarChar(32)         | milvus                            |
| `provenance_label` | VarChar(1024)       | 来源描述                          |
| `created_at`       | VarChar(32)         | ISO 时间                          |
| `updated_at`       | VarChar(32)         | ISO 时间                          |

- embedding 模型：阿里云 text-embedding-v3（1024维）
- index 类型：IVF_FLAT 或 HNSW（根据数据量选择）
- agent 隔离：一个 Collection 存所有 agent，通过 `agent_id` 字段过滤

### 9.1 Embedding Provider 策略（2026-05-12 确认）

`memory-milvus` 本身不注册独立的 Embedding Provider，而是复用项目已有的
`MemoryEmbeddingProvider` 基础设施。embed + search 代码通过 `EmbeddingProvider.embedSingle()` /
`EmbeddingProvider.embedBatch()` 获取向量，不与任何具体模型 API 耦合。

**⚠️ TODO — 切换到目标模型**：

> 当需要切换到最终使用的 embedding 模型时：
>
> 1. 新增对应的 embedding provider adapter（参考 `extensions/openai/` 的模式），
>    注册为 `registerMemoryEmbeddingProvider(adapter)`
> 2. `memory-milvus` 的 search / write 代码**零改动** — provider 层对上层透明
> 3. 跑 `pnpm test extensions/memory-milvus` 确认对应维度向量读写正常

---

## 10. 改动文件清单

| 文件                                                 | 改动                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `packages/memory-host-sdk/.../types.ts`              | MemorySearchManager→MemoryDataBackend，类型演化             |
| `extensions/memory-core/src/memory/manager.ts`       | `implements MemoryDataBackend`                              |
| `extensions/memory-core/src/tools.ts`                | memory_get schema 改为 id                                   |
| `extensions/memory-core/src/flush-plan.ts`           | 加 backendKind                                              |
| `extensions/memory-core/src/short-term-promotion.ts` | key 改为 id                                                 |
| `extensions/memory-core/src/dreaming-phases.ts`      | 底部 path/startLine/endLine 三字段合并为 MemoryReference.id |
| `src/plugins/memory-state.ts`                        | MemoryFlushPlan 加字段                                      |
| `src/agents/pi-tools.ts`                             | flush 工具路由分流                                          |
| `extensions/memory-milvus/`                          | **全部新建**                                                |

---

## 11. Flush 路径统一方案（方案 H）— 补充决策

> 本节为第 3 节 "Flush 写入路径" 的**细化决策**，不替换原表格，仅明确最终实现方式。

### 11.1 背景：原表格的歧义

原第 3 节表格：

| 后端   | pi-tools.ts 行为                                 |
| ------ | ------------------------------------------------ |
| 文件   | wrapToolMemoryFlushAppendOnlyWrite（现逻辑不变） |
| Milvus | 不包装 write，走 plugin 的 memory_write 工具     |

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

| 第 3 节原决策                                            | 方案 H 细化                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 文件：`wrapToolMemoryFlushAppendOnlyWrite`（现逻辑不变） | 拆为公共函数 `appendMemoryFileSafe()`，由 `backend.write()` 和 wrap 工具**共享调用** |
| Milvus：走 plugin 的 `memory_write` 工具                 | **所有后端**（含文件）的 flush turn 都走 `memory_write` 工具                         |
| `MemoryFlushPlan.relativePath` 仅文件后端有              | 保留；`memory_write` 工具内部自行计算路径，不依赖此字段                              |

### 11.5 新增基础设施

- **公共原语**：`extensions/memory-core/src/memory/memory-append-safe.ts::appendMemoryFileSafe()` —— 封装路径白名单、保留文件拒写、文件锁、append-only、行号返回
- **新工具**：`extensions/memory-core/src/tools.ts::createMemoryWriteTool()` —— AI flush turn 调用入口
- **日期函数导出**：`flush-plan.ts::formatDateStampInTimezone` 改为 export

### 11.6 接口方法签名细化

| 方法                           | 签名决策                                                                   | 原因                                                       |
| ------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `write(entry)`                 | `write(entry: Omit<MemoryEntry, "id">): Promise<MemoryReference>`          | 文件后端忽略元数据只写 text；milvus 完整使用               |
| `recordRecall(refs, context?)` | 参数从 `ids: string[]` **扩展为 `refs: MemoryReference[]` + 可选 context** | 保留 score/snippet/query 用于 promotion 评分，否则信号退化 |
| `promote(ids)`                 | `promote(ids: string[]): Promise<void>`                                    | 保持简单，内部自行 rank+apply                              |

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

| 字段               | 来源层       | 说明                                                                              |
| ------------------ | ------------ | --------------------------------------------------------------------------------- |
| `agentId`          | Host         | Host 知道当前 agent 身份，不由插件猜测                                            |
| `session_key`      | Host/Manager | 会话标识，用于隔离同一 agent 的不同聊天窗口                                       |
| `memory_type`      | Manager      | 默认写死 `"short_term"`，Task 16 短时→长时升级时改为 `"long_term"` / `"archived"` |
| `createdAt`        | Manager      | 统一 UTC 毫秒数，抛弃本地时区依赖                                                 |
| `provenance.label` | Tool/Manager | 按 §12.3 溯源字典注入                                                             |

### 12.3 常量枚举与防呆

在 `extensions/memory-milvus/src/types.ts` 强制导出两个常量：

```ts
export const MEMORY_SOURCE_LABELS = {
  CHAT_EXTRACT: "chat_extract", // AI flush 时提取
  USER_MANUAL: "user_manual", // 用户在 UI 上手动添加
  RECALL_PROMOTION: "recall_promotion", // Dreaming 升级产生
  IMPORT: "import", // 老数据迁移导入
} as const;

export const MEMORY_TYPES = {
  SHORT_TERM: "short_term",
  LONG_TERM: "long_term",
  ARCHIVED: "archived",
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

**Live 测试执行档位**（S6 落地决策）：

- **选型**：方案 A — 最小骨架。1 条 `describe.skipIf(!process.env.OPENCLAW_LIVE_TEST)` 保护的 `write → insert` 端到端用例，README 中提供 Docker 启动 Milvus 说明
- **真实 Milvus 回归推迟到 Task 13**（Alpha 退出条件）。当前 skeleton 的 `cfg` 参数为 `{} as any` 占位，Task 13 需补齐完整 `OpenClawConfig` 构造
- **文件**：`extensions/memory-milvus/src/memory-milvus.live.test.ts`（94行）

### 12.12 Alpha 标记与 S6 交付

- **Alpha 标记**：`package.json` 新增 `"stability": "experimental"` 字段（元数据，非机械消费）
- **README.md**（95行）：标注 Alpha 状态 + 当前支持/不支持能力清单 + Docker 快速启动 + 测试说明
- **S6 交付**：Alpha 标记 / README / live 测试骨架 / Mock 单测收口（58 tests 全绿）
- **Alpha 退出条件（Task 13）**：`recordRecall` 正式实现 + Dreaming promotion + `stability` 字段撤下

### 12.9 pi-tools 白名单归属（务实决策）

- **现状**：`MEMORY_FLUSH_ALLOWED_TOOL_NAMES` 硬编码在 `src/agents/pi-tools.ts` L98，Task 10 会追加 `memory_write`
- **决策**：暂时接受硬编码，不做架构下沉（manifest 注册 / 核心注册 API 等方案）
- **理由**：
  - memory 能力是核心通用能力，不是纯业务 owner 专属，白名单放核心可接受
  - 架构下沉改动面涉及 plugin 系统基础设施，成本高、收益有限
  - 当前只追加一个 `memory_write`，未来如果出现更多 memory 相关插件工具，再统一重构
- **遗留事项**：记录为技术债，留待 Task 16 之后的架构统一阶段评估是否下沉

---

## 13. Task 11 实施细节决策

### 13.1 memory_recall 语义澄清（Q1）

**问题**：plan 原文把 `memory_recall` 列为 Task 11 三件套之一，但 SDK `MemoryDataBackend` 把 `recordRecall` 定义为 backend 方法，与"AI 工具"语义冲突。

**结论**：`memory_recall` 是 OpenClaw 召回追踪机制的**描述性名词**，**不是 AI 可调工具**。

- AI 可见工具集仅三个：`memory_search` + `memory_get` + `memory_write`
- 召回追踪走 `MemoryDataBackend.recordRecall` 方法，由 `memory_search` 工具内部 hook 自动触发（与 `extensions/memory-core/src/tools.ts::queueShortTermRecallTracking` 行为一致）
- **触发时机**：search 命中后**自动**执行（与 plan Task 12 原文 "每次 get() 记录召回" 不一致，以本决策为准）

### 13.2 last_recalled_at 字段新增（β 方案）

**对标依据**：OpenClaw 官方 memory 升级机制有 11 维统计（`recallCount` / `dailyCount` / `groundedCount` / `totalScore` / `maxScore` / `firstRecalledAt` / `lastRecalledAt` / `queryHashes` / `recallDays` / `conceptTags` / `claimHash`），当前 Milvus 只有 `recall_count` 一维。

**Task 11 范围内顺手加 1 维**：

- 字段名：`last_recalled_at`
- 类型：`VarChar(32)`（与 `created_at` / `updated_at` 同构 ISO 字符串）
- 写入：每次 search 命中由 `recordRecall` 同步更新为 `now()`
- 用途：Task 13 Deep Dreaming 区分"最近热"vs"历史总热"
- Schema 增量：`extensions/memory-milvus/src/schema.ts` 新增 `FIELD_LAST_RECALLED_AT = "last_recalled_at"` 常量

**其余 9 维**（`dailyCount` / `groundedCount` / `totalScore` / `maxScore` / `firstRecalledAt` / `queryHashes` / `recallDays` / `conceptTags` / `claimHash`）→ **Task 16 占位待定**，评估是否采纳官方多维加权打分模型升级 Task 13 Deep Dreaming。

### 13.3 Task 11 vs Task 12 边界（Q2）

**问题**：plan 原文 Task 11 写"更新 recall_count"，Task 12 又写"recordRecall 正式实现"，重叠不清。

**结论**：

| Task        | 范围                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Task 11** | `memory_search` 工具内**接入 recordRecall hook 调用点**（与 memory-core 同构）；`MilvusSearchManager.recordRecall` **维持 warn 占位**（不写库）              |
| **Task 12** | `recordRecall` **真实落库**（`query + upsert` 两步），同步更新 `recall_count += 1` 与 `last_recalled_at = now()`；同时替代 `short-term-recall.json` 文件存储 |

### 13.4 工具注册互斥与槽位机制（Q3）

**背景**：方案 H（§6 / §11）已锁“通过 `plugins.slots.memory` 互斥切换”。capability 层（promptBuilder / flushPlanResolver / runtime）由 `registerMemoryCapability` 单槽位覆盖天然互斥；**工具注册层**的互斥由 `src/plugins/slots.ts` 的 `applyExclusiveSlotSelection` 提供：选定 `slots.memory = "memory-milvus"` 时自动将所有其他 `kind:"memory"` 插件的 `entries[id].enabled = false`，loader **不会调用**被禁用插件的 `register()`。默认 slot 为 `"memory-core"`（`DEFAULT_SLOT_BY_KEY.memory`），设 `slots.memory = "none"` 时两边均被禁用。

**核心决策**：**单层信赖 slots.ts**——两插件 `register()` 内部**无条件**注册同名工具，不再重复判断 slot。register() 被调用这事本身就证明本插件是当前 slot 选中者，与现有 memory-milvus `memory_write` 无条件注册风格一致。

**Q3 子项决策表**：

| 子项                            | 决策                                                                                                                                            | 备注                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Q3.1 激活模型                   | 沿用方案 H（互斥），不重新决策                                                                                                                  | Task 7 已锁                          |
| Q3.2 SDK backend 枚举扩展       | **Alpha 期继续伪装 `qmd`**（保留 `resolveMemoryBackendConfig` stub），Task 16 正式扩 `"builtin" \| "qmd" \| "milvus"`                           | 最小改动                             |
| Q3.3 register 条件判断          | **不做**。两插件 `register()` 内**无条件** `api.registerTool`，注册互斥全部交给 `src/plugins/slots.ts` 预处理阶段的 entries disable 机制        | 信赖核心机制，避免双保险冷捷扇       |
| Q3.4 host loader 互斥跳过（P1） | **推到 Task 15**，Task 11 不动 host 代码                                                                                                        | 越界规避                             |
| Q3.5 Manifest contract 声明     | **两份保留**（声明能力不等于实际注册），不改 manifest JSON                                                                                      | 解耦声明与运行时                     |
| Q3.6 memory_write 对称规划      | **不在 Task 11 处理**，Task 16 待定（届时文件后端也走 `memory_write`）                                                                          | 延后                                 |
| Q3.7 测试形态                   | **mock api 单测**（α 方案）：mock `OpenClawPluginApi`，断言 `register()` 内 `registerTool` 的调用次数与 names（单一情形：一次调用对应一次注册） | 不需覆盖不同 slot 组合因为无条件注册 |
| Q3.8 会话可见性过滤             | **应用层复用**（Task 11）：search tool 内部调 `filterMemorySearchHitsBySessionVisibility`；**backend 侧 expr 原生过滤**推到 Task 16             | 两层方案分阶段                       |

**Task 11 工程动作清单**：

1. `extensions/memory-core/index.ts` — **不动**（现有无条件注册 memory_search/memory_get 即为正确行为，由 slots.ts disable 其他插件不走到此分支）
2. `extensions/memory-milvus/index.ts` — `register()` 内**无条件**注册 `memory_search` / `memory_get`（与现有 `memory_write` 风格一致）
3. `extensions/memory-milvus/src/tools.search.test.ts` — mock api 验证 register() 被调用后三个工具均被注册（names 正确 / 调用次数 = 3）
4. `extensions/memory-milvus/src/schema.ts` — 新增 `FIELD_LAST_RECALLED_AT` 字段常量（β 方案）
5. `extensions/memory-milvus/src/search.ts` — 新增 `MilvusSearchManager.get(id)` 实现 + `recordRecall` hook 调用点接入

**与 slots.ts 的信赖边界**：本决策不介入 slot 预处理机制本身；若未来 slots.ts 语义变更，影响面收敛到核心模块，不沿 memory 系插件扩散。

## 14. `MilvusSearchManager.get(id)` 实施细节决策（Q4）

**背景**：SDK `MemoryDataBackend.get(id): Promise<MemoryEntry>`（`packages/memory-host-sdk/src/host/types.ts` L160）已声明，待 memory-milvus 实现。当前 `MilvusSearchManager.readFile(relPath, from?, lines?)` 是为兼容旧 `MemorySearchManager` 接口（已 `@deprecated`）保留的入口，**Task 11 后会变孤儿但暂不可删**（接口契约约束，等 Q10 治理）。

**Q4 子项决策表**：

| 子项                      | 决策                                                                              | 备注                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Q4.1 实现关系             | **B 独立新写**：`get(id)` 全新实现，`readFile` 维持现状不动                       | 两者并存到 Q10                                                                              |
| Q4.2 `output_fields` 范围 | **一次性取全 12 字段**（含 §13.2 新增 `last_recalled_at`）                        | 简单可靠，性能差异可忽略                                                                    |
| Q4.3 not found 行为       | **`throw new Error("Memory entry not found: ${id}")`**                            | 与 `readFile` / memory-core `manager.get` 一致；SDK 签名 `Promise<MemoryEntry>` 不允许 null |
| Q4.4 closed 状态          | **`throw new Error("MilvusSearchManager is closed")`**                            | 与现有 search/write/readFile/recordRecall 全一致                                            |
| Q4.5 degraded 状态        | **throw**（不查 fallback ndjson）                                                 | fallback 是 write-only 兜底无 id 索引；Q6 时再统一                                          |
| Q4.6 `readFile` 去留      | **保留**（接口契约约束），Task 11 不动；Q10 删除                                  | 见下文清理路径                                                                              |
| Q4.7 测试形态             | mock `client.get` 单测（命中/空/异常/closed 四态）+ live 写-取回归（skipIf 保护） | 单测不依赖 Milvus                                                                           |
| Q4.8 `from`/`lines` 切片  | **不支持**，返回完整 entry；切片由调用方处理                                      | `MemoryEntry` 无切片字段                                                                    |

**`get(id)` 必须查询的 Milvus 字段（12 个）**：

| 类型   | 字段常量                                                                                                                                        | `MemoryEntry` 映射                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 必返回 | `FIELD_ID` / `FIELD_TEXT` / `FIELD_PROVENANCE_KIND` / `FIELD_PROVENANCE_LABEL`                                                                  | `id` / `text` / `provenance.kind` / `provenance.label` |
| 可选   | `FIELD_SNIPPET` / `FIELD_AGENT_ID` / `FIELD_SESSION_KEY` / `FIELD_MEMORY_TYPE` / `FIELD_RECALL_COUNT` / `FIELD_CREATED_AT` / `FIELD_UPDATED_AT` | 同名映射                                               |
| β 新增 | `FIELD_LAST_RECALLED_AT`（§13.2）                                                                                                               | （MemoryEntry 暂无对应字段，先取不映射，等 SDK 扩）    |

**`readFile` 与 `get(id)` 命运对照**：

| 阶段                 | `readFile` 状态                                                     | `get(id)` 状态                                         |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| Task 11 之前（当前） | 活代码（`memory-core/tools.ts` L496 调用）                          | 不存在                                                 |
| Task 11 之后         | 半死代码（无调用方，但 `implements MemorySearchManager` 强制保留）  | 主入口（memory-milvus 自注册的 `memory_get` 工具调用） |
| Q10 治理后           | 删除（`MilvusSearchManager` 不再 `implements MemorySearchManager`） | 唯一入口                                               |

**`get(id)` 不触发 `recordRecall`** —— §13.1 已明确触发时机仅为 `memory_search` 命中后（与 memory-core 行为一致），`get(id)` 是按 PK 直查不计入召回统计。

## 15. Task 11 期间 BM25 / 混合检索算法范围（Q5）

**背景**：BM25 优先决策已锁（决策记忆 + §8.1）；`@zilliz/milvus2-sdk-node` v2.4.11 不支持代码创建 BM25 Function，过渡方案 `ANN + scalar filter + 客户端 TF-IDF + 加权融合 + MMR + 时间衰减`已在 Task 9 完成。

**Q5 核心结论**：Task 11 **完全不动 `search.ts` 检索算法**，仅在工具壳层包装。

**Q5 子项决策表**：

| 子项                                  | 决策                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Q5.1 是否动算法                       | **不动**。Task 11 仅把现有 `manager.search()` 包装成 `memory_search` 工具                                                                |
| Q5.2 TF-IDF 实现细节                  | **不对 AI 暴露**（工具描述只说"混合检索"），仅源码注释 + decisions §8.1 标注                                                             |
| Q5.3 BM25 自动检测                    | **Task 11 不做**，未来需要时配置项手动 toggle，推 Task 16                                                                                |
| Q5.4 融合权重 w1 / w2                 | Task 11 不动，保留 Task 9 既定值；参数化推 Task 16                                                                                       |
| Q5.5 `extractKeywords` 算法           | Task 11 不动，复用现有实现；Q10 治理时统一                                                                                               |
| Q5.6 BM25 切换运维文档                | Task 11 不写，Task 16 / 真有切换需求时再补                                                                                               |
| Q5.7 Task 11 测试范围                 | **仅工具壳层**：mock `manager.search` → 校验 `MemoryReference[]` 透传 / 字段映射 / `recordRecall` hook 调用 / 会话可见性过滤；不重测算法 |
| Q5.8 与 §13.2 `last_recalled_at` 互动 | **正交**，BM25 升级仅扩 `sparse_bm25` 字段 + 改 search 路径，不影响                                                                      |

**BM25 升级路径**（保留 §8.1 TODO，移交 Task 16）：

> 当 Milvus ≥ 2.4 部署且服务端已创建 BM25 Function 后：
>
> 1. `searchKeyword()` 的 `query(filter)` → `hybridSearch({ data:[{anns_field:"sparse_bm25"}], rerank: WeightedRanker(...) })`
> 2. 删除客户端 TF-IDF 计算（`computeTfIdfScores` / `extractKeywords` / `buildKeywordFilter`）
> 3. schema.ts 新增 `FIELD_SPARSE_BM25` + 索引声明
> 4. 跑 `pnpm test extensions/memory-milvus` 回归

## 16. degraded 状态下方法行为统一（Q6）

**背景**：`MilvusSearchManager.degraded` 属性（search.ts L240）在启动时 `ensureCollectionReady` 失败即置 true（§12.6），但当前只有 `write()` 主动检查 degraded 走 fallback（L516），`search()` / `readFile()` 未检查，会发请求失败冒泡。Task 11 需把 `search()` 与新增 `get(id)` 行为对齐已有决策。

**三分法原则**：

| 语义               | 行为                 | 适用方法         |
| ------------------ | -------------------- | ---------------- |
| 可容忍丢失（读）   | **静默降级**，返回空 | `search()`       |
| 可容忍丢失（埋点） | **直接丢 + warn**    | `recordRecall()` |
| 必须零丢失（写）   | **fallback 兜底**    | `write()`        |
| 强一致读（按 PK）  | **throw**            | `get(id)`        |

**Q6 子项决策表**：

| 子项                           | 现状                 | 决策                                                                | 依据                                            |
| ------------------------------ | -------------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| Q6.1 `search()` degraded       | 未检查，请求冒泡     | **`return []`** + 首次 warn（放 `if (this.closed) return []` 之后） | 与 L238 注释一致；AI 调 search 不被底层故障中断 |
| Q6.2 `search()` closed         | `return []`          | **保持不变**                                                        | 向后兼容 Task 9                                 |
| Q6.3 `recordRecall()` degraded | Task 11 仍 warn-only | Task 12 落库时加 `if (this.degraded) return` + warn                 | §12.7 "直接丢"一致                              |
| Q6.4 `write()` degraded        | 走 fallback          | **不动**                                                            | §12.5 / §12.6                                   |
| Q6.5 `get(id)` degraded        | ——                   | **throw**                                                           | §14 Q4.5 已定                                   |
| Q6.6 `readFile()` degraded     | 未检查               | **不动**（Task 11 后孤儿）                                          | §14 Q4.6                                        |

**Task 11 工程动作清单（Q6 追加）**：

1. `extensions/memory-milvus/src/search.ts` — `search()` 方法在 `if (this.closed) return [];` 之后新增 `if (this.degraded) { warnOnce("..."); return []; }`
2. `extensions/memory-milvus/src/search.test.ts` — 新增 degraded case：构造 `degraded:true` manager，断言 `search()` 返回 `[]` 且**未调用** `client.search`

## 17. 多 corpus 支持范围（Q7）

**背景**：memory-core `memory_search` / `memory_get` 已有 `corpus: "memory" | "wiki" | "all" | "sessions"` 参数（`tools.shared.ts` L34-50），通过 `registerMemoryCorpusSupplement` 动态注册（`memory-wiki` 典型注册者）。memory-milvus 当前零 corpus 痕迹。§13.4 锁定 slot=memory-milvus 时 memory-milvus 自注册工具，需决策 corpus 范围。

**核心原则**：**schema 对齐 + 能力最小化**——所有参数与 memory-core `MemorySearchSchema` / `MemoryGetSchema` 一对一，AI 切换 slot 无感知；某些值行为受限时**返空 + warnOnce**，不 throw。

**Q7 子项决策表**：

| 子项                                    | 决策                                                                                                    | Task         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------ |
| Q7.1 暴露 corpus 参数                   | **暴露**（schema 与 memory-core 一对一）4 值全列                                                        | Task 11      |
| Q7.2 `corpus=memory`（默认）/ undefined | **正常查询**（不过滤 `memory_type`）                                                                    | Task 11      |
| Q7.3 `corpus=sessions`                  | **返回空 + warnOnce**（`"corpus=sessions not yet supported in milvus backend"`）                        | Task 11 占位 |
| Q7.4 `corpus=wiki`                      | **返回空 + warnOnce**（`"wiki supplement integration deferred"`），不调 `searchMemoryCorpusSupplements` | Task 11 占位 |
| Q7.5 `corpus=all`                       | **退化为 `corpus=memory`** + warn "wiki part deferred"                                                  | Task 11 占位 |
| Q7.6 Task 11 工程边界                   | schema 完整暴露；仅 `memory` / undefined 走完整 milvus 查询；其余 3 值降级占位                          | Task 11      |
| Q7.7 Schema 对齐原则                    | **与 memory-core `MemorySearchSchema` / `MemoryGetSchema` 一对一**                                      | Task 11      |
| Q7.8 `memory_get` corpus                | schema 暴露但**实际忽略**（按 PK 查 corpus 无义）                                                       | Task 11      |

**边界问题（Task 16 待定）**：

- `corpus=sessions` 真正支持：milvus 存 session 转录条目方案 + `memory_type="session"` 或新字段 + 查询时按会话过滤
- `corpus=wiki` 真正支持：milvus 工具接入 `searchMemoryCorpusSupplements` / `getMemoryCorpusSupplementResult` 机制，与 milvus 命中融合排序
- `corpus=all` 真正支持：milvus + wiki supplement 并查后统一打分并多路融合

**Task 11 工程动作清单（Q7 追加）**：

1. `extensions/memory-milvus/src/tools.search.ts`（新建） / `tools.ts` — schema **复刻** memory-core `MemorySearchSchema` 结构（AGENTS 规范禁止跨插件 import `memory-core/src/**`），以 `tools.shared.ts` L34-50 为唯一参考，字段名 / 类型 / 默认值 / 可选性严格一对一；SDK 级别抽取共享评估合并入§18.Q9.7 三选移交 Task 16
2. `tools.search.ts` — `corpus` 分支处理：`memory`/undefined → `manager.search()`；`sessions`/`wiki`/`all` → `warnOnce` + 返回空结果
3. `extensions/memory-milvus/src/tools.search.test.ts` — 覆盖 4 种 corpus 值与 undefined 的一致性，添加**schema 与 memory-core 定义字段集一致性断言**（反向守护：防止未来 memory-core 改 schema 后 milvus 侧遗漏同步）

## 18. citation 装饰 pipeline 范围（Q9）

**背景**：memory-core 的 citation 是**后处理装饰**（`tools.citations.ts` `decorateCitations` · `formatCitation`），基于 `provenance.label` 在 snippet 后追加 `\n\nSource: ...`，受 `cfg.memory.citations: "on"|"off"|"auto"` 控制。memory-milvus `MemoryReference` 底层已携 `provenance: { kind: "milvus", label }`，**但装饰 pipeline 不可复用**（AGENTS 规范禁止跨插件 import `memory-core/src/**`）。

**核心原则**：Task 11 **不在 milvus 插件里重复 / 实现 citation 装饰**，保证 Alpha 范围不膨胀；MemoryReference 原样透传，完整 citation 能力（含 SDK 共享抽取评估）移交 Task 16。

**Q9 子项决策表**：

| 子项                                 | 决策                                                                                                                | Task    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------- |
| Q9.1 Task 11 是否装饰 citation       | **不装饰**（跨插件 import 禁止 + 不复刻）                                                                           | Task 11 |
| Q9.2 `cfg.memory.citations` 是否生效 | **不读取**，配置保留但对 milvus 无效果                                                                              | Task 11 |
| Q9.3 citation 字段位置               | N/A（Task 11 不装饰）；Task 16 多件 memory-core：snippet 追加                                                       | Task 16 |
| Q9.4 `auto` 模式（direct/group）     | 推 Task 16（需 `agentSessionKey` 解析）                                                                             | Task 16 |
| Q9.5 `formatCitation` 复用方式       | 推 Task 16（评估 SDK 共享抽取）                                                                                     | Task 16 |
| Q9.6 Task 11 工程范围                | 零装饰 + warnOnce + MemoryReference 原样透传                                                                        | Task 11 |
| Q9.7 SDK 共享抽取方案                | Task 16 评估三选：X（提到 `packages/memory-host-sdk`）/ Y（memory-core runtime-api 导出）/ Z（milvus 复刻，不推荐） | Task 16 |

**Task 11 工程动作清单（Q9 追加）**：

1. `extensions/memory-milvus/src/tools.search.ts` — `memory_search` 返回 `MemoryReference[]` 原样，**不**调用任何 citation 装饰函数
2. `tools.search.ts` — 首次命中时 `warnOnce("citations rendering not yet supported in milvus backend; deferred to Task 16")`
3. `tools.search.test.ts` — 断言返回 `MemoryReference` 不含追加的 `\n\nSource:` 后缀（证明原样透传）

**与§13.4（工具注册互斥）的关系**：slot=memory-milvus 时 memory-core 不注册 `memory_search`，装饰 pipeline 随之不发生；本决策只是完整锁定“milvus 侧也不装饰”的语义。
