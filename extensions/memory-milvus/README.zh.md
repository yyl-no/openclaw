# Memory (Milvus)

基于 Milvus 向量数据库的 OpenClaw 记忆插件，提供向量 ANN 搜索能力。

## 当前能力

| 能力 | 状态 |
|---|---|
| `memory_write` 工具（向量写入 + 降级兜底） | ✅ |
| `memory_search` 工具（ANN + 关键词混合检索） | ✅ |
| `memory_get` 工具（主键查询） | ✅ |
| Collection 自动初始化（创建 + 加载） | ✅ |
| 降级模式（Milvus 不可达 → ndjson 本地兜底） | ✅ |
| `recordRecall`（召回计数追踪 + upsert） | ✅ |
| Dreaming 推广 `rankPromotionCandidates` + `applyPromotions` | ✅ |
| 来源标签 / 记忆类型校验 | ✅ |
| 去重（SHA-256 content_hash）+ 更新 + 软删除（归档） | ✅ |
| AI flush 轮次提示集成 | ✅ |
| `memory migrate` CLI（Markdown ↔ Milvus 双向迁移） | ✅ |
| BM25 原生全文搜索（Milvus ≥ 2.4，可选开启） | ✅ |

## 迁移工具

插件内置了 `openclaw memory` 下的双向迁移 CLI 子命令。

```bash
# 正向：扫描 MEMORY.md + memory/*.md → 切片 → 嵌入 → 写入 Milvus
openclaw memory migrate ./my-memory-dir

# 反向：查询 Milvus → 导出到 memory-export/<时间戳>/
openclaw memory migrate ./my-memory-dir --reverse

# 仅预览，不实际写入
openclaw memory migrate ./my-memory-dir --dry-run

# 反向迁移，按类型过滤
openclaw memory migrate ./my-memory-dir --reverse --type=short_term
```

**去重**：批次内 SHA-256（`text + "\0" + provenance_label`）；跨批次通过
Milvus `provenance_label` 查询去重。反向输出写入 `memory-export/<时间戳>/`
（便于阅读），且绝不会覆盖原始 `memory/*.md` 文件。

## BM25 原生全文搜索（Milvus ≥ 2.4）

当 Milvus 服务端创建了 BM25 Function 后，插件可以使用原生混合搜索
（`hybridSearch + WeightedRanker`）替代客户端 TF-IDF 降级方案。

### 服务端配置

在你的 Milvus 实例上创建 BM25 Function（需要 Milvus ≥ 2.4）。
此操作无法通过 Node.js SDK 完成——请使用 RESTful API 或 pymilvus。

**通过 RESTful API**（替换 `<host>`、`<port>`、`<collection>`）：

```bash
curl -X POST "http://<host>:<port>/v2/vectordb/functions/create" \
  -H "Content-Type: application/json" \
  -d '{
    "collectionName": "<collection>",
    "functionName": "bm25_fn",
    "functionType": "BM25",
    "inputFieldNames": ["text"],
    "outputFieldNames": ["sparse_bm25"]
  }'
```

**通过 pymilvus**：

```python
from pymilvus import Collection, Function, FunctionType

col = Collection("<collection>")
bm25_fn = Function(
    name="bm25_fn",
    function_type=FunctionType.BM25,
    input_field_names=["text"],
    output_field_names=["sparse_bm25"],
)
col.create_function(bm25_fn)
```

创建 Function 后，在插件配置中启用 BM25：

```json
{
  "config": {
    "milvus": { "host": "localhost", "port": 19530 },
    "search": { "useBM25": true, "vectorWeight": 0.7, "textWeight": 0.3 }
  }
}
```

插件将使用单次 `hybridSearch` 调用，同时使用稠密向量和稀疏 BM25 字段，
通过 `WeightedRanker` 融合评分。如果 BM25 Function 不可用，会自动降级为
ANN + 客户端 TF-IDF。

### 降级链路

```
search()
  ├─ useBM25=true? → searchBM25() 通过 hybridSearch
  │   ├─ 成功 → 应用衰减 + MMR → 完成
  │   └─ null（Function 缺失或错误）→ 传统路径
  └─ 传统：searchVector() + searchKeyword() → mergeResults → MMR
```

## 引用控制

`memory_search` 遵循 `cfg.memory.citations`（"on" | "off" | "auto"）配置，
在搜索结果片段后追加来源引用（`\n\nSource: ...`）。
Auto 模式在私聊中启用引用，在群聊/频道上下文中禁用。
通过 `openclaw/plugin-sdk/memory-core-host-runtime-core` barrel 共享。

## 会话可见性

`memory_search` 在构建结果前对 Milvus 命中结果调用
`filterMemorySearchHitsBySessionVisibility`，
根据请求者的可见性策略过滤 `source:"sessions"` 的命中。
通过同一 runtime-api barrel 共享。

## 尚未支持

| 能力 | 状态 |
|---|---|
| 9 维高级召回信号（dailyCount/groundedCount/…） | 待定 |

## 启用

`memory-milvus` 插件与 `memory-core` 互斥。
设置 `plugins.slots.memory` 即可激活——所有其它 `kind:"memory"` 插件
会被自动禁用。

```json
// openclaw.config.json
{
  "plugins": {
    "slots": {
      "memory": "memory-milvus"
    },
    "entries": {
      "memory-milvus": {
        "enabled": true,
        "config": {
          "milvus": {
            "host": "localhost",
            "port": 19530
          },
          "embedding": {
            "provider": "alibaba",
            "model": "text-embedding-v3"
          }
        }
      }
    }
  }
}
```

**切换回 `memory-core`**：将 `plugins.slots.memory` 改为 `"memory-core"`。
Milvus 数据和 Markdown 文件独立存储——切换时两者都不会丢失。

**启动验证**：切换后，网关启动日志中会显示 `memory-milvus` 在已加载插件列表中。
如果 Milvus 服务不可达，插件以"降级"模式初始化（降级到本地 ndjson 文件）
并输出警告日志。

## 快速开始（Docker）

启动本地 Milvus 实例：

```bash
# Standalone 模式，内嵌 etcd
docker run -d --name milvus-standalone \
  -p 19530:19530 -p 9091:9091 \
  milvusdb/milvus:v2.4.0 standalone
```

在 `openclaw.yaml` 中配置插件：

```yaml
plugins:
  entries:
    memory-milvus:
      config:
        milvus:
          host: localhost
          port: 19530
        embedding:
          provider: alibaba
          model: text-embedding-v3
```

## 测试

### 单元测试（无需 Milvus）

```bash
pnpm test extensions/memory-milvus
```

### Live 测试（需要 Milvus + embedding API key）

Live 端到端测试由 `OPENCLAW_LIVE_TEST=1` 保护，覆盖 write → search → recordRecall → promotion 全链路。

```bash
# 先启动 Milvus（见上方快速开始）
export OPENCLAW_LIVE_TEST=1
export OPENAI_API_KEY="sk-..."
pnpm test:live extensions/memory-milvus
```

## 架构

插件注册了一个与 `memory-core` 互斥的 `MemoryPluginCapability`。
切换后端只需更改 `plugins.slots.memory` 配置项——AI 工具链路（`memory_write`）保持一致。

```
AI flush 轮次
  ↓ memory_write(text, label?)
  ↓ MilvusSearchManager.write()
  ↓ 健康探测 → 嵌入 → 插入 → 向量存储
  ↓ 失败时 → ndjson 降级兜底（零数据丢失）
```

## 参考

- [Task 10 计划](../../refactor/1-plan.md)
- [Task 10 决策](../../refactor/2-decisions.md)
- [Task 13](#) — Dreaming 推广（已完成）
- [Task 14](#) — Markdown ↔ Milvus 迁移工具（已完成）
- [Task 16](#) — 去重 / 引用 / 多 corpus

