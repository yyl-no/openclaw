# memory-milvus 与官方 memory-core 架构对齐说明

> 按**功能维度**对比官方架构与 memory-milvus 架构，逐项说明对齐原因与设计取舍。

---

## 1. 记忆存储本体

### 官方架构 (memory-core)

记忆以 Markdown 文件形式存储在工作区目录下：

```
workspace/
  MEMORY.md                          ← 长期记忆（通过 dreaming 从 short-term 升级）
  memory/
    2026-05-11.md                    ← 短期记忆（每日一个文件）
    2026-05-12.md
  short-term-recall.json             ← 召回频次统计（用于 dreaming 升级评分）
```

- **搜索**：sqlite-vec 做向量检索 + SQLite FTS5 做全文检索，索引文件在 `memory/` 目录下
- **读取**：`memory_get` 按 `path + startLine + endLine` 定位文件切片
- **写入**：AI flush turn 调 `file write` 工具 → `wrapToolMemoryFlushAppendOnlyWrite` 装饰器拦截 → 强制 append 到 `memory/YYYY-MM-DD.md`
- **Agent 隔离**：每个 agent 独立 workspace 目录，文件系统物理隔离

### memory-milvus 架构

记忆以行记录形式存储在 Milvus 向量数据库中：

```
Milvus Collection: openclaw_memory
  ├─ id (Int64 PK, 自增)
  ├─ embedding (FloatVector 1024维)     ← 语义向量
  ├─ text (VarChar 65536)               ← 记忆全文
  ├─ snippet (VarChar 4096)             ← 搜索预览
  ├─ agent_id (VarChar 256)             ← Agent 隔离字段
  ├─ session_key (VarChar 512)          ← 会话隔离字段
  ├─ memory_type: short_term | long_term | archived
  ├─ recall_count (Int32)               ← 召回频次
  ├─ provenance_kind / provenance_label ← 来源追溯
  ├─ created_at / updated_at            ← 时间戳
  ├─ last_recalled_at                   ← 最近召回时间
  ├─ content_hash (SHA-256)             ← 去重键
  └─ sparse_bm25 (SparseFloatVector)    ← BM25 稀疏向量
```

- **搜索**：Milvus HNSW 向量索引 + BM25 稀疏向量索引（或 scalar filter 降级）
- **读取**：`memory_get` 按自增主键 `id` 直接 query
- **写入**：AI flush turn 调 `memory_write` 工具 → `EmbeddingProvider.embed()` → `collection.insert()`
- **Agent 隔离**：共享一个 Collection，所有查询自动追加 `agent_id == "xxx"` 过滤条件

### 为什么这样设计

文件存储受限于单机 I/O，语义搜索依赖外部索引重建；Milvus 原生支持向量索引持久化、水平扩展、高并发查询。我们用 **Milvus 行记录 1:1 映射 Markdown 文件切片**，保持语义对等——每条短期记忆对应一行，升级后通过 `memory_type` 字段标记 `short_term → long_term → archived`，等价于文件后端的文件迁移（`memory/YYYY-MM-DD.md → MEMORY.md`）。

---

## 2. 接口抽象层

### 官方架构

记忆系统对外暴露的是插件级别的 capability 注册——`registerMemoryCapability({ promptBuilder, flushPlanResolver, runtime })`。但**内部没有统一的存储后端接口**：

- 搜索和读取通过 `MemorySearchManager` 接口（`search()` / `readFile()`）
- 写入逻辑散布在 `flush-plan.ts` → `pi-tools.ts` → `wrapToolMemoryFlushAppendOnlyWrite`
- 召回追踪在 `short-term-promotion.ts` 直接读写 `short-term-recall.json`
- Dreaming promotion 在 `dreaming.ts` 直接调 `rankShortTermPromotionCandidates` + `applyShortTermPromotions`

各个环节之间没有抽象层——它们直接操作文件系统和 JSON 文件，换一个存储后端意味着所有环节都要重写。

### memory-milvus 架构

我们**新增了 `MemoryDataBackend` 统一接口**，将散落在各处的存储操作收敛为 9 个方法：

```
MemoryDataBackend
  ├─ search(query, opts) → MemoryReference[]       ← 统一搜索
  ├─ get(id) → MemoryEntry                        ← 统一读取
  ├─ write(entry) → MemoryReference               ← 统一写入
  ├─ recordRecall(refs, context?) → void           ← 统一召回追踪
  ├─ rankPromotionCandidates(opts) → Candidate[]   ← 统一升级打分
  ├─ applyPromotions(opts) → Result[]              ← 统一升级执行
  └─ status() / sync() / close()                  ← 生命周期
```

同时将数据模型从"文件坐标"抽象为"通用标识"：

| 旧概念                       | 新概念            | 变化                                                                 |
| ---------------------------- | ----------------- | -------------------------------------------------------------------- |
| `path + startLine + endLine` | `id: string`      | 文件后端编码为 `"file:memory/05-11.md:20:25"`；Milvus 后端为自增 PK  |
| `MemorySearchResult`         | `MemoryReference` | 删 path/startLine/endLine，新增 id/provenance                        |
| `MemoryReadResult`           | `MemoryEntry`     | 删 path/from/lines，新增 id/agentId/sessionKey/memoryType/provenance |

### 为什么这样设计

不新增接口就无法替换后端——官方 memory-core 把搜索、写入、召回、升级四条链路硬编码到文件系统，Milvus 后端需要全部重写。我们选择**演化而非替代**：`MemorySearchManager → MemoryDataBackend`（重命名 + 扩展），`MemorySearchResult → MemoryReference`（收敛字段）。文件后端（memory-core）同时 `implements MemoryDataBackend`，保证两边类型契约一致——上层代码不关心底层是文件还是 Milvus。

关键决策：**不引入新 SDK 包**。`MemoryDataBackend` 直接定义在现有的 `packages/memory-host-sdk` 中，旧类型标记 `@deprecated` 保持向后兼容。

---

## 3. AI 写入流程 (Flush)

### 官方架构

```
[AI flush turn]
    ↓ LLM 调用 file write(path="memory/2026-05-11.md", content="...")
[pi-tools.ts]
    ↓ wrapToolMemoryFlushAppendOnlyWrite 装饰器拦截
    ↓ 强制 append-only，禁止覆盖
    ↓ 自动创建文件和目录
[文件系统]
    → memory/2026-05-11.md
```

AI 使用的是通用 `file write` 工具，由 pi-tools 层的装饰器做安全约束（路径白名单、append-only、并发锁）。这种方式**紧耦合于文件路径语义**——AI 需要知道 `path` 参数，Milvus 后端没有"文件路径"概念。

### memory-milvus 架构

```
[AI flush turn]
    ↓ LLM 调用 memory_write(text="...", label="chat_extract")
[memory_write 工具]
    ↓ assertValidSourceLabel(label) 校验
    ↓ manager.write({ text, provenance: { label } })
[MemoryDataBackend.write]
    ├─ 文件后端 → appendMemoryFileSafe() → fs.appendFile
    └─ Milvus   → EmbeddingProvider.embed() → collection.insert()
                   ├─ 成功: 返回 Milvus PK
                   └─ 失败: writeFallback() → memory/.milvus-fallback/YYYY-MM-DD.ndjson
```

我们**新增了 `memory_write` 专用工具**，AI 不需要知道底层是文件还是向量库。工具的 schema 与存储无关：`{ text: string, label?: "chat_extract"|"user_manual"|"recall_promotion"|"import" }`。

### 为什么这样设计

核心诉求是"切到 Milvus 后，AI 的行为不能改变"。如果 Milvus 后端还要 AI 调 `file write`，就需要在 AI 上下文里解释"你写的东西会进 Milvus 而不是文件"——这会让 prompt 复杂化且容易出错。

我们采用**方案 H（统一路径）**：两个后端都注册 `memory_write` 工具，AI flush turn 始终调同一个工具。文件后端的 `memory_write` 底层调 `appendMemoryFileSafe()`（从原来的 `wrapToolMemoryFlushAppendOnlyWrite` 抽取出的公共原语），Milvus 后端调 `collection.insert()`。`wrapToolMemoryFlushAppendOnlyWrite` 装饰器保留为兜底——万一 AI 误用 `file write`，仍然被安全约束。

此外，Milvus 写入有**五路分治**容错：

1. 正常 → embed + insert
2. Milvus 连不上 → 直接 fallback（ndjson 落盘）
3. Milvus 恢复 → 先回放 fallback 积压，再写新数据
4. embed 失败 → fallback
5. insert 失败 → fallback

这保证了 **Milvus 不可用时零数据丢失**。

---

## 4. 搜索 (memory_search)

### 官方架构

```
[memory_search]
    ↓ manager.search(query)
[MemoryIndexManager]
    ├─ sqlite-vec: 向量 ANN (cosine distance)
    ├─ SQLite FTS5: 全文检索 (BM25)
    ├─ 客户端加权融合: score = w1 × vectorScore + w2 × textScore
    ├─ MMR 重排 (λ=0.7): 去冗余
    └─ 时间衰减: 旧记忆降权
    → MemorySearchResult[] (path, startLine, endLine, snippet, score)
```

### memory-milvus 架构

```
[memory_search]
    ↓ manager.search(query)
[MilvusSearchManager]
    ├─ searchVector(): Milvus HNSW ANN → vectorScore (归一化)
    ├─ searchBM25(): hybridSearch + WeightedRanker (需服务端预创建 BM25 Function)
    │   └─ 降级: searchKeyword() scalar filter + 客户端 TF-IDF
    ├─ mergeResults(): score = vectorWeight × vectorScore + textWeight × textScore (可配置)
    ├─ MMR 重排 (λ=0.7): 去冗余
    └─ temporalDecayFactor(30天半衰期): 旧记忆降权
    → MemoryReference[] (id, snippet, score, provenance)
```

向量权重/文本权重/是否启用 BM25 均可通过插件 config 调整。

### 为什么这样设计

搜索是记忆系统的核心——两条管道在**算法层面完全对齐**（向量 + 全文 → 加权融合 → MMR → 衰减），只在底层引擎不同。我们选择了 **ANN + scalar filter 起步、BM25 原生升级** 的分阶段策略：

- **第一阶段**：客户端 TF-IDF 近似全文检索——立即可用，不依赖运维
- **第二阶段**：Milvus ≥ 2.4 服务端创建 BM25 Function 后，一行配置切到原生 BM25——客户端 TF-IDF 降级链路保留，Function 不存在时自动回退

这样设计的原因：`@zilliz/milvus2-sdk-node` 不支持代码创建 BM25 Function（需 RESTful 或 pymilvus 运维操作），我们不能在代码里假设 Function 一定存在。

---

## 5. 精确读取 (memory_get)

### 官方架构

`memory_get` 接受 `path` + `from` + `lines` 参数，`manager.readFile()` 读文件按行截取。本质是"文件切片读取"。

### memory-milvus 架构

`memory_get` 接受 `id` 参数（Milvus 自增主键），`manager.get(id)` 执行 `collection.query(filter="id == xxx")` 一次性取全 15 个字段返回完整 `MemoryEntry`。不支持切片——Milvus 的行就是原子单位。

schema 保持与官方 `MemoryGetSchema` 一对一（含 `path/from/lines/corpus/id`），但实际仅使用 `id`，其他参数占位忽略。这样 AI 切换后端时工具签名不变。

### 为什么这样设计

文件后端可以按行切片（文件很大时只读需要的段落），Milvus 行粒度本身就是切片单位——每行 ≈ 文件的一个 chunk，不需要再切片。`memory_get` 不触发 `recordRecall`——精确读取不算"召回"，与官方行为一致。

---

## 6. 召回追踪 (recordRecall)

### 官方架构

每次 `memory_search` 命中后，`queueShortTermRecallTracking` 将命中结果写入 `short-term-recall.json`：

```json
{
  "entries": {
    "file:memory/2026-05-11.md:20:25:abc123": {
      "recallCount": 5,
      "totalScore": 3.2,
      "maxScore": 0.85,
      "dailyCount": { "2026-05-11": 2, "2026-05-12": 3 },
      "firstRecalledAt": "2026-05-11T10:00:00Z",
      "lastRecalledAt": "2026-05-12T15:30:00Z",
      "queryHashes": ["a1b2c3", "d4e5f6"],
      ...
    }
  }
}
```

共有 11 维统计信号，用于 dreaming 阶段评估哪些短期记忆值得升级为长期记忆。

### memory-milvus 架构

每次 `memory_search` 命中后，`manager.recordRecall(refs)` 执行两步操作：

1. `client.query(filter="id in [...]", output_fields=全字段)` 获取当前值
2. 内存累加 `recall_count += 1` + 更新 `last_recalled_at` → `client.upsert(rows)`

召回数据**直接存储在 Milvus 行字段**中（`recall_count` / `last_recalled_at`），不需要单独的 JSON 文件。失败直接丢弃 + `warnOnce`，**不写 fallback**——召回埋点可丢，与记忆本体必须零丢失区别对待。

### 为什么这样设计

Milvus 不支持原子 `UPDATE ... SET recall_count = recall_count + 1`，只能用 `query → 内存累加 → upsert` 两步。我们选择最多分两次网络往返（单次 `query` 取全字段 + 单次 `upsert`），N 条命中也只需这两次往返。

当前仅实现 2 维信号（`recall_count` + `last_recalled_at`），官方 11 维中的其余 9 维（`dailyCount/groundedCount/totalScore/maxScore/queryHashes` 等）占位待定——它们需要额外的 schema 字段和更复杂的累计算法，但不影响基本能力对齐。

---

## 7. Dreaming Promotion (记忆升级)

### 官方架构

Dreaming 是定期（cron `0 3 * * *` 每天凌晨 3 点）或手动触发的记忆整理机制，分三个阶段：

```
Light Dreaming:
  遍历 memory/ 目录下所有 YYYY-MM-DD.md 文件
  → 切分为 chunk → 对每个 chunk 在 short-term-recall.json 中查 recall 频率
  → 收集候选

REM Dreaming:
  按 session 聚合候选
  → 让 LLM 将同一会话的相关记忆合并总结

Deep Dreaming:
  对合并后的候选做评分（recallCount + recency + diversity）
  → 超过阈值的写入 MEMORY.md (long_term)
  → 原 memory/YYYY-MM-DD.md 中的条目标记为已处理
```

三个阶段的数据采集**完全依赖文件系统遍历**（`fs.readdir` + `fs.readFile` + 按行切分）。

### memory-milvus 架构

三个阶段**复用官方 dreaming 的调度外壳**（cron 触发、阶段编排、LLM 调用），但**数据采集和存储全部走 Milvus**：

```
Light Dreaming:
  manager.search({ memoryType: "short_term", createdAfter: todayStart })
  → Milvus scalar filter 直接查出今日短期记忆

REM Dreaming:
  manager.search({ sessionKey })
  → 按会话过滤，entry.text 直接可用（不用再切分）

Deep Dreaming:
  rankPromotionCandidates(opts):
    → query short_term 全部 → computePromotionScore(recallCount, last_recalled_at)
    → 评分: normalizedRecall × recencyDecay (半衰期30天)
    → 排序 → top-N

  applyPromotions(opts):
    对每个候选:
      ① get(id) 读原条目
      ② insertEntry(long_term) — provenance.label="recall_promotion"
      ③ upsert 原条目 memory_type="archived"
```

升级后**不物理删除**原记录，而是标记为 `archived`——保留审计轨迹，search 默认排除。

### 为什么这样设计

Dreaming 的**评分算法和调度逻辑是通用的**——不管底层存储是什么，"哪些短期记忆值得升级"的判断标准不变。我们选择：

- **共用**：阶段调度（Light/REM/Deep 触发顺序、cron 管理、阈值配置）→ 直接复用官方代码
- **独立**：数据采集（文件遍历 → Milvus 标量查询）和存储写入（文件追加/移动 → Milvus insert/upsert）

这样做避免了重复实现约 2000 行的调度编排逻辑。关键适配点是 Dreaming Manager 的 factory 模式——cron job 运行在 isolated session 中，`activeManager` 为 null，需要 lazy-init 按需创建 Milvus 连接。

---

## 8. 多 Corpus 支持

### 官方架构

`memory_search` / `memory_get` 支持 `corpus` 参数：

| corpus          | 行为                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| `memory` (默认) | 搜索主体记忆                                                                   |
| `sessions`      | 搜索会话转录（`memory-wiki` 等插件通过 `registerMemoryCorpusSupplement` 注册） |
| `wiki`          | 搜索外部 wiki                                                                  |
| `all`           | 多路并行 → 统一融合排序                                                        |

Corpus 扩展机制通过 SDK 的 `registerMemoryCorpusSupplement` 实现——任何插件都可以注册额外的搜索源，框架负责多路融合。

### memory-milvus 架构

完全对齐官方的 4 路 corpus 路由：

```
corpus=memory / undefined:
  → manager.search()     (Milvus ANN+BM25)

corpus=sessions:
  → manager.search({ sessionKey })  (Milvus + 会话过滤)

corpus=wiki:
  → searchMemoryCorpusSupplements()  (SDK 注册的 wiki 源)

corpus=all:
  → Promise.all([manager.search(), searchSupplements()])
  → mergeMultiCorpusResults()  统一按 score 排序 → top-N
```

Milvus 命中与 wiki supplement 命中在客户端合并排序，与官方 `mergeMemorySearchCorpusResults` 行为一致。

### 为什么这样设计

多 corpus 是 OpenClaw 记忆系统的扩展机制——memory-milvus 作为 slot 替换者，必须完整支持这个扩展点，否则切换后端会导致 wiki/sessions 搜索能力退化。我们通过直接调用 SDK 提供的 `listMemoryCorpusSupplements` 和 `searchMemoryCorpusSupplements` API 来接入，与官方共享同一套 supplement 注册表。

---

## 9. Agent 隔离与会话可见性

### 官方架构

- **Agent 隔离**：每个 agent 有独立 workspace 目录（`<workspace>/<agentId>/`），文件系统物理隔离
- **会话可见性**：搜索结果通过 `filterMemorySearchHitsBySessionVisibility` 过滤，区分 sandboxed / non-sandboxed / current-session-only

### memory-milvus 架构

- **Agent 隔离**：共享 Collection，所有查询自动追加 `agent_id == "<callerAgentId>"` 过滤条件。效果等价于物理隔离——Agent A 绝对查不到 Agent B 的记忆
- **会话可见性**：双层过滤——Backend 侧 `session_key` expr 原生过滤 + 应用层 `filterMemorySearchHitsBySessionVisibility`（复用官方 runtime-api barrel）

### 为什么这样设计

Agent 隔离是安全底线。共享 Collection + `agent_id` 过滤与文件系统物理隔离的**安全级别一致**——只要 `agent_id` 过滤在 search/get/recordRecall 全链路无遗漏，隔离效果等同。跨 agent 访问需要显式 `crossAgent: true`，防止误用。

会话可见性采用双层叠加而非单一层——backend expr 减少网络传输，应用层过滤覆盖边缘 case，两者互补。

---

## 10. Citation 装饰

### 官方架构

搜索结果返回给 AI 之前，在 `snippet` 后追加来源标记：

```
原文: "用户偏好使用 pnpm 管理依赖"
装饰后: "用户偏好使用 pnpm 管理依赖\n\nSource: memory/2026-05-11.md L20-25"
```

通过 `decorateCitations` / `formatCitation` 实现，受 `cfg.memory.citations: "on"|"off"|"auto"` 控制（auto 下按 direct/group 会话类型自动决定）。

### memory-milvus 架构

**直接复用官方装饰函数**——通过 SDK barrel `openclaw/plugin-sdk/memory-core-host-runtime-core` 导入 `decorateCitations` / `resolveMemoryCitationsMode` / `shouldIncludeCitations`：

```
MemoryReference { id: "123456", snippet: "...", provenance: { label: "Milvus #123456" } }
    ↓ decorateCitations(results, includeCitations)
"用户偏好使用 pnpm 管理依赖\n\nSource: Milvus #123456"
```

### 为什么这样设计

Citation 装饰是纯字符串处理——输入 `MemoryReference`，输出加后缀的 snippet。与后端无关，不需要重写。我们通过 SDK barrel（而非跨插件 import `memory-core/src/**`）复用——符合 OpenClaw 插件规范。

---

## 11. 去重、更新、归档

### 官方架构

- **去重**：文件后端通过 `provenance_label`（`memory/YYYY-MM-DD.md:Lstart-Lend`）天然去重——同一个文件位置不会写入两次
- **更新**：不支持，记忆一旦写入不再修改
- **归档**：通过 dreaming promotion 将内容从 `memory/YYYY-MM-DD.md` 移到 `MEMORY.md`

### memory-milvus 架构

- **去重**：Schema 新增 `content_hash` 字段 = `SHA-256(text + "\0" + provenance_label)`。`insertEntry()` 入库前查询 `content_hash`，已存在则跳过返回已有 id
- **更新**：`update(id, patch)` → `query → merge → text变则重embed → upsert`
- **归档**：`archive(id)` 设 `memory_type="archived"`（软删除，不物理删除）。search 默认过滤 `memory_type in ["short_term", "long_term"]`

### 为什么这样设计

去重是向量数据库的刚需——同样的内容可能在不同 flush 轮次中被重复提取。文件后端用位置唯一性天然去重，Milvus 需要显式哈希查重。`content_hash` 包含 `provenance_label` 以区分同一内容被不同来源写入（如用户手动加 vs 迁移导入）。

`update()` 和 `archive()` 是文件后端没有的能力——Milvus 的行级字段操作使这些成为可能。我们选择在 memory-milvus 层实现它们，为未来更细粒度的记忆管理做准备。

---

## 12. 插件 Slot 互斥切换

### 官方架构

`plugins.slots.memory` 决定哪个插件提供记忆能力。`applyExclusiveSlotSelection` 在预处理阶段自动 disable 非选中插件的 entries，保证同一时间只有一个 memory 插件生效。

### memory-milvus 架构

**完全信赖 slots.ts 的互斥机制**——两插件 `register()` 内**无条件**注册同名工具（`memory_search` / `memory_get` / `memory_write`），不做重复判断。`register()` 被调用本身就证明本插件是当前 slot 选中者。

切换方式：修改 `openclaw.json` 中一行配置，重启 gateway 即可：

```json
// 切换到 Milvus
{ "plugins": { "slots": { "memory": "memory-milvus" } } }
// 切回文件
{ "plugins": { "slots": { "memory": "memory-core" } } }
```

### 为什么这样设计

我们选择了**单层信赖**策略——不在插件层重复实现互斥逻辑。原因：

- 核心框架已提供 slot 预处理机制，插件层重复判断属于"双保险反模式"
- 无条件注册与现有 memory-milvus 的 `memory_write` 注册风格一致
- 如果未来 slots.ts 语义变更，影响面收敛到核心模块，不会沿插件扩散

切换后两边的数据**互不侵犯**——Markdown 文件不受影响，Milvus Collection 也不受影响，随时可切回。

---

## 13. 数据迁移

### 官方架构

无内置迁移工具——用户在不同 workspace 间迁移记忆需要手工复制 Markdown 文件。

### memory-milvus 架构

提供 `openclaw memory-migrate` CLI 子命令，支持双向迁移：

```
openclaw memory-migrate <dir>              # Markdown → Milvus
openclaw memory-migrate <dir> --reverse    # Milvus → Markdown
openclaw memory-migrate <dir> --dry-run    # 预览
```

正向迁移时，将 Markdown 文件按 `##`/`###` 标题切分 → `text-embedding-v3` 嵌入 → 写入 Milvus。`provenance.label` 保留原始文件位置（如 `memory/2026-05-11.md:L10-L25`）用于追溯。

反向迁移时，分页读取 Milvus → 按 `memory_type` + 日期分组 → 导出到独立输出目录（不覆盖原文件）。

### 为什么这样设计

用户切换到 Milvus 后端时，存量 Markdown 记忆不会自动出现在新后端中。迁移工具桥接两种存储格式，使切换零数据丢失。

---

## 14. Embedding Provider 自注册

### 问题

memory-milvus 插件需要内置 embedding provider（如 `local`/`openai`），这些 provider 通常由 memory-core 插件的 bundled runtime 注册。但 slot 指向 memory-milvus 时，memory-core 不会被加载——内置 provider 注册缺失，导致 dreaming sweep 失败。

### 解决

在 memory-milvus 的 `register()` 首行自行调用 `registerBuiltInMemoryEmbeddingProviders(api)`。由于此版本 OpenClaw 的 SDK barrel `openclaw/plugin-sdk/memory-core-bundled-runtime` 不在导出白名单中，改用 `createRequire` 直接从 npm 包的 `dist/` 目录加载 bundled runtime JS。

此外，dreaming manager resolver 改为**工厂模式 lazy-init**——cron job 运行在 isolated session 中，`activeManager` 可能为 null，按需创建新连接。

### 为什么这样设计

这本质是一个**依赖倒置**问题——memory-milvus 依赖 memory-core 的 bundled runtime（内置 provider 代码），但 slot 互斥机制不允许同时加载两个插件。`createRequire` 是一种务实的绕过——直接加载 dist 产物而不走 SDK barrel。长期解决方案是 SDK 将该 barrel 加入导出白名单。

---

## 对齐总结

除 Milvus 平台本身的固有限制（不支持原子 `UPDATE`、不能通过 Node.js SDK 创建 BM25 Function）外，memory-milvus 在 **所有功能维度** 与官方 memory-core 对齐：

| 功能       | 官方                                            | memory-milvus                              | 一致性          |
| ---------- | ----------------------------------------------- | ------------------------------------------ | --------------- |
| AI 工具    | `memory_search` / `memory_get` / `memory_write` | 同名同参                                   | ✅ 完全一致     |
| 搜索算法   | sqlite-vec + FTS5 → 加权融合 → MMR → 衰减       | HNSW + BM25/scalar → 加权融合 → MMR → 衰减 | ✅ 算法等价     |
| 写入路径   | `memory_write` (方案 H 统一)                    | `memory_write` → embed + insert            | ✅ 工具统一     |
| 召回追踪   | `short-term-recall.json` → 11 维信号            | Milvus 行字段 → 2 维信号                   | ⚠️ 信号维度缩减 |
| Dreaming   | 文件遍历 → LLM 合并 → 迁移文件                  | 标量查询 → LLM 合并 → 写新行 + 归档旧行    | ✅ 流程等价     |
| Agent 隔离 | 独立目录（物理）                                | `agent_id` 过滤（逻辑）                    | ✅ 效果等价     |
| Citation   | on/off/auto                                     | 复用官方装饰函数                           | ✅ 完全一致     |
| 多 Corpus  | sessions/wiki/all 多路融合                      | 同官方路由 + 融合                          | ✅ 完全一致     |
