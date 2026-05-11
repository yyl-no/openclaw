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

### Task 9: 重写搜索（混合检索 ANN + BM25）

- 搜索行为、工具参数、返回格式与 memory-core 完全一致（仅底层从 sqlite-vec + FTS5 换为 Milvus ANN + BM25）

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
