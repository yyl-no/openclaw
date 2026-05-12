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

- embedding 模型：阿里云 text-embedding-v3（1024维）
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

- `buildMilvusFlushPlan` 返回 `backendKind: "milvus"`
- AI 提取记忆 → embed → insert Milvus
- 写入走 plugin 的 `memory_write` 工具

### Task 11: 重写 memory_search / memory_get / memory_recall

- `memory_search`：Milvus ANN + BM25 混合检索 → `MemoryReference`
- `memory_get`：按 id 查询 PK → `MemoryEntry`
- `memory_recall`：跟踪召回，更新 `recall_count` / `last_recalled_at`

### Task 12: 重写 Short-term Recall Tracking

- 替代 `short-term-recall.json`
- 每次 `get()` 记录召回
- 存储在 Milvus 字段 `recall_count` / `last_recalled_at`

### Task 13: 重写 Dreaming Promotion

- Light dreaming：每日记忆摄入（从 Milvus 查询当日条目）
- REM dreaming：会话语料摄入
- Deep dreaming：筛选高 recall_count → LLM 合并总结 → 更新 `memory_type="long_term"`
- Cron 触发机制复用

### Task 14: Markdown → Milvus 迁移工具（延后）

- 插件主体建好后再实现

- 读取 `MEMORY.md` + `memory/YYYY-MM-DD.md`
- 切分 → embed → insert，provenance_label 保留原始路径
- 支持反向导出：Milvus → Markdown

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
