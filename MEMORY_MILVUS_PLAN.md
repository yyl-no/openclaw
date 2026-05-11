# OpenClaw 记忆系统 Milvus 重构方案

## 背景与目标

将 OpenClaw 的记忆系统从**文件型单一实现**重构为**通用记忆后端架构**，使原版文件系统（`memory-core`）和 Milvus 向量数据库（`memory-milvus`）作为两个完整后端并存，用户通过配置一键切换。

### 核心原则

1. **先抽象，再接 Milvus** — 不要直接把 Milvus 塞进原版逻辑
2. **原版行为零破坏** — 接口重构后，`memory-core` 必须继续正常工作
3. **不让 Milvus 伪装成文件** — Milvus 不应以 `path#line` 作为核心接口
4. **分阶段替换** — 搜索/读取 → 写入/flush → 召回统计 → Dreaming
5. **两个完整后端** — File Backend 和 Milvus Backend，而不是原版 + 一堆特殊判断

---

## 最终结构

```
通用记忆后端（MemoryBackend 接口）
  ├── File Backend（memory-core，原版不变）
  └── Milvus Backend（memory-milvus，新建）
```

切换方式（改一行配置即可）：

```yaml
plugins:
  slots:
    memory: memory-milvus   # 使用 Milvus
    # memory: memory-core   # 切回官方
```

---

## 改动文件总览

```
packages/memory-host-sdk/src/host/
└── types.ts                         ← 加 getById?(id) 可选方法

extensions/memory-core/src/memory/
├── backend-interface.ts             ← 新建：通用后端接口定义
├── file-backend.ts                  ← 新建：文件后端包装（封装现有逻辑）
└── manager.ts                       ← 小改：依赖 backend-interface

extensions/memory-core/src/
├── tools.ts                         ← 改：memory_get 去掉 path#line 强绑定
├── flush-plan.ts                    ← 改：flush target 抽象化
├── short-term-promotion.ts          ← 改：召回统计后端化
└── dreaming.ts + dreaming-phases.ts ← 改：promotion 目标后端化

extensions/memory-milvus/            ← 全新插件
├── src/
│   ├── milvus-backend.ts            ← Milvus 后端完整实现
│   ├── tools.ts                     ← memory_search / memory_get（Milvus 语义）
│   ├── flush-plan.ts                ← flush 写 Milvus
│   ├── prompt-section.ts            ← 告诉 AI 用 memory_get(id)
│   ├── runtime-provider.ts          ← 注册 MemoryPluginRuntime
│   ├── migrate.ts                   ← Markdown ↔ Milvus 迁移工具
│   └── index.ts                     ← 插件入口
├── package.json
└── openclaw.plugin.json
```

---

## 上层插件契约

`memory` 插件向上层注册 `MemoryPluginCapability`，共 4 个接口：

```typescript
type MemoryPluginCapability = {
  promptBuilder?:     MemoryPromptSectionBuilder       // 构建系统提示词中的记忆说明
  flushPlanResolver?: MemoryFlushPlanResolver           // 返回 flush 配置
  runtime?:           MemoryPluginRuntime               // 提供 getMemorySearchManager
  publicArtifacts?:   MemoryPluginPublicArtifactsProvider // 列出公开文件
}
```

核心是 `MemorySearchManager` 接口（`runtime.getMemorySearchManager` 返回）：

```typescript
interface MemorySearchManager {
  search(query, opts?)                          // 混合搜索
  readFile({ relPath, from?, lines? })          // 文件路径读取（memory-core 用）
  getById?(id: string): Promise<MemoryReadResult | null>  // ← 新增可选，Milvus 用
  status()
  sync?(params?)
  probeEmbeddingAvailability()
  probeVectorAvailability()
}
```

### memory_get 动态路由机制

```
memory_get 被调用
    ↓
检测 manager 是否有 getById 方法
    ↓                         ↓
  有（memory-milvus）        没有（memory-core）
    ↓                         ↓
memory_get({ id })        memory_get({ path, from, lines })
```

---

## 通用后端接口设计

新建 `extensions/memory-core/src/memory/backend-interface.ts`：

```typescript
// 通用记忆引用（替代 path+line）
export type MemoryRef =
  | { kind: "file"; path: string; startLine: number; endLine: number }
  | { kind: "id";   id: string }

// 通用记忆条目
export type MemoryEntry = {
  id: string
  text: string
  source: "memory" | "sessions"
  category?: string
  memoryType?: "short_term" | "long_term" | "archived" | "dream"
  importance?: number
  recallCount?: number
  createdAt?: string
  updatedAt?: string
  ref: MemoryRef
}

// 通用后端接口（分批实现）
export interface MemoryBackend {
  // 第一批：搜索 / 读取 / 状态
  search(query: string, opts?: SearchOpts): Promise<MemoryEntry[]>
  getByRef(ref: MemoryRef): Promise<MemoryEntry | null>
  status(): MemoryBackendStatus

  // 第二批：写入 / flush / 删除
  write(entry: MemoryEntry): Promise<void>
  delete(id: string): Promise<void>
  flush(content: string, meta?: FlushMeta): Promise<void>

  // 第三批：召回统计 / Dreaming
  recordRecall(ref: MemoryRef, queryHash: string, score: number): Promise<void>
  promoteToLongTerm(candidates: MemoryEntry[]): Promise<void>
  close?(): Promise<void>
}
```

---

## flush 抽象化

`MemoryFlushPlan.relativePath` 改为：

```typescript
type MemoryFlushTarget =
  | { kind: "file";    relativePath: string }  // 文件后端：写 YYYY-MM-DD.md
  | { kind: "backend" }                         // Milvus 后端：写 Milvus
```

---

## Milvus Collection 字段设计

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | VARCHAR(128) | 主键，复用 SQLite chunks 的 sha256_xxx |
| `agent_id` | VARCHAR(64) | Agent 隔离 |
| `text` | VARCHAR(65535) | 记忆原文 |
| `embedding` | FLOAT_VECTOR(N) | 向量，维度由 embedding model 决定 |
| `category` | VARCHAR(64) | 分类标签 |
| `memory_type` | VARCHAR(32) | short_term / long_term / archived / dream |
| `importance` | FLOAT | 重要度得分 |
| `recall_count` | INT64 | 被召回次数 |
| `created_at` | INT64 | 毫秒时间戳 |
| `updated_at` | INT64 | 毫秒时间戳 |
| `source` | VARCHAR(32) | memory / sessions |
| `metadata` | JSON | 原文件路径等（供迁移用） |

### Milvus 连接配置

```typescript
// 本地自托管
{ host: "localhost", port: 19530 }

// Zilliz 云
{ address: "https://xxx.zillizcloud.com", token: "xxx" }
```

---

## 分阶段实施计划

### 阶段 1：定义通用后端接口
- 新建 `backend-interface.ts`
- 定义 `MemoryRef`、`MemoryEntry`、`MemoryBackend`
- **不改任何现有代码**

### 阶段 2：FileMemoryBackend 包装原版
- 新建 `file-backend.ts`，实现 `MemoryBackend`
- 内部转发给现有 `MemoryIndexManager`
- **原版行为 100% 不变**，只是套一层包装

### 阶段 3：工具层去除文件硬绑定
- `tools.ts`：`memory_get` 动态路由（检测 `getById`）
- `flush-plan.ts`：引入 `MemoryFlushTarget`
- `packages/memory-host-sdk/src/host/types.ts`：加 `getById?` 可选方法

### 阶段 4：实现 Milvus 后端
- 新建 `extensions/memory-milvus/` 完整插件
- 实现 `MilvusMemoryBackend`（MemoryBackend 接口）
- 连接管理、Collection 初始化、insert/search/delete

### 阶段 5：召回统计后端化
- `short-term-promotion.ts` 改为调用 `backend.recordRecall()`
- `FileMemoryBackend` → 写 `short-term-recall.json`（不变）
- `MilvusMemoryBackend` → 更新 `recall_count`、`last_recalled_at` 字段

### 阶段 6：Dreaming 后端化
- `dreaming.ts` + `dreaming-phases.ts` 改为调用 `backend.promoteToLongTerm()`
- `FileMemoryBackend` → 写 `MEMORY.md`（不变）
- `MilvusMemoryBackend` → 更新 `memory_type = "long_term"`，写 dream entry

### 阶段 7：迁移工具
- `migrate.ts`：Markdown → Milvus（chunk → embed → insert）
- 反向导出：Milvus → Markdown（用于回退/备份）

### 阶段 8：测试验收
- 原版文件后端：search / get / flush / Dreaming / status 全部正常
- Milvus 后端：写入 / 搜索 / 读取 / flush / 召回 / 长期升级 / Agent 隔离
- 切换测试：`memory-core` ↔ `memory-milvus` 互不污染

---

## 各后端行为对比

| 功能 | memory-core（文件后端） | memory-milvus（Milvus 后端） |
|------|----------------------|---------------------------|
| 记忆存储 | `memory/YYYY-MM-DD.md` | Milvus Collection |
| `memory_get` 参数 | `{ path, from, lines }` | `{ id }` |
| `memory_search` 返回 | `path + startLine + endLine` | `id + text` |
| flush 写入 | 写 `.md` 文件 | insert Milvus |
| 召回统计 | `short-term-recall.json` | `recall_count` 字段 |
| Dreaming 升级 | 写 `MEMORY.md` | 更新 `memory_type = long_term` |
| 公开 artifacts | `MEMORY.md`、日记文件 | 空数组（无文件） |
| 向量检索 | sqlite-vec | Milvus ANN |
| 关键词检索 | SQLite FTS5 | SQLite FTS5（保留） |

---

## 关键决策记录

1. **不修改 `memory-core` 源码** — 新建独立插件 `memory-milvus`，原版零改动，随时一行配置切回
2. **SQLite 保留 FTS** — 只废弃 sqlite-vec 向量层，FTS（BM25）仍由 SQLite 承担
3. **`getById` 加入 `MemorySearchManager` 接口** — optional 方法，向下兼容，`memory-core` 不实现也不报错
4. **Dreaming 存 Milvus** — 生成的叙事文本作为 `category: "dream"` entry 存入 Milvus，可被检索
5. **Short-term promotion 用 Milvus 字段追踪** — 用 entry `id` 替代 `path+line`，达到阈值后更新 `importance` 字段
6. **Milvus id 复用 SQLite chunks 的 sha256_xxx** — 零映射，完全对齐，无需额外转换
