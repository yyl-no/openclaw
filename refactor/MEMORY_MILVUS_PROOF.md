# Memory-Milvus 插件功能对齐验证文档

> **写给自己的验证手册** —— 本文档提供一步步操作指南，让你在和 OpenClaw 对话后，
> 能直接在终端里看到记忆条数增加、搜索结果返回、dreaming 推广等所有功能的直观证明。
>
> 核心思路：**聊天 → 终端验证**。每一步都有中文解释，告诉你"为什么这样是对的"、
> "背后发生了什么"、"你会在终端看到什么"。

---

## 0. 前置准备（必须按顺序做完）

### 0.1 启动 Milvus 向量数据库

```bash
# 用 Docker 启动一个单机版 Milvus
# 端口说明：19530 = gRPC（插件读写用），9091 = HTTP REST API（手动查询用）
docker run -d --name milvus-standalone \
  -p 19530:19530 -p 9091:9091 \
  milvusdb/milvus:v2.4.0 standalone
```

**验证 Milvus 是否启动成功：**

```bash
# 如果返回 JSON 且 "status" 为 200，说明 Milvus 正常运行
curl -s http://localhost:9091/healthz
```

> **注意**：如果 Milvus 未启动，插件会自动进入**降级模式**（见第6节），写入操作会保存到
> 本地 NDJSON 备用文件，等 Milvus 恢复后自动回放。

### 0.2 配置 OpenClaw 启用 memory-milvus 插件

编辑 OpenClaw 配置文件（Windows 路径：`C:\Users\<你的用户名>\.openclaw\openclaw.json5`）：

```json5
{
  // ...你的其他配置...
  plugins: {
    // 【关键】把 memory 插槽指向 memory-milvus，这是唯一的切换点
    // 和 memory-lancedb / memory-core 是互斥的，同一时间只有一个"活跃"memory 插件
    slots: {
      memory: "memory-milvus",
    },

    entries: {
      "memory-milvus": {
        enabled: true,
        config: {
          // Milvus 连接信息
          milvus: {
            host: "localhost", // Milvus 服务器地址
            port: 19530, // gRPC 端口
          },
          // embedding 配置
          // ⚠️ provider 必须设为 "auto" —— 让插件自动选择可用的 embedding 适配器
          //   - "alibaba" 不支持 embedding（只能做多模态）
          //   - "local" 需要 memory-core 作为 bundled plugin，当前环境不支持
          //   - "auto" 会自动尝试 openai → 其他可用适配器
          embedding: {
            provider: "auto", // 自动选择可用的 embedding provider
            model: "text-embedding-3-small", // OpenAI 兼容的 embedding 模型
          },
        },
      },
    },
  },
}
```

### 0.3 重启 Gateway 使配置生效

```bash
openclaw gateway restart
```

> **为什么需要重启？** 插件在 Gateway 启动时加载。修改 config 后不重启，Gateway 还是用
> 旧配置。

---

## 1. 插件注册验证 —— 确认 memory-milvus 已被 OpenClaw 识别

### 1.1 查看插件列表

```bash
openclaw plugins list
```

**你应该在输出中看到：**

```
  memory-milvus          memory     enabled
```

这表示：

- `memory-milvus` — 插件 ID 已注册
- `memory` — 插件类型是 memory（符合 memory-core 契约）
- `enabled` — 插件已被激活（配置中 `enabled: true`）

### 1.2 查看 JSON 格式详情

```bash
openclaw plugins list --json
```

**在 JSON 输出中找到 memory-milvus 条目，确认：**

- `"id": "memory-milvus"` — 插件 ID 正确
- `"kind": "memory"` — 类型正确，符合 `MemoryPluginCapability` 注册契约
- `"enabled": true` — 已启用
- `"contracts"` 中应包含 `"tools": ["memory_write", "memory_get", "memory_search"]`

> **对齐点**：这个注册过程和 memory-lancedb、memory-core 完全一致。都是通过
> `definePluginEntry` → `api.registerMemoryCapability()` 注册。插槽切换是透明的
> —— 改一行 `slots.memory` 配置就能换后端。

---

## 2. Collection 自动创建 —— 验证 Milvus 表结构

### 2.1 查看 Gateway 启动日志

> **注意**：`openclaw gateway logs` 在 Windows PowerShell 中**不能直接管道**，
> 需要先找出日志文件路径再查看内容。

```powershell
# 步骤1：确认日志目录
ls ~/.openclaw/logs/

# 步骤2：查看最新的 gateway 日志，过滤 memory-milvus 相关行
# PowerShell 写法：
Get-Content ~/.openclaw/logs/gateway-*.log | Select-String "memory-milvus"
```

**你应该看到类似这样的日志（成功路径）：**

```
[memory-milvus] Collection "openclaw_memory" ready.
```

### 2.2 什么是 Collection Auto-Bootstrap？

启动时，插件会自动完成三步操作：

| 步骤 | 操作               | 说明                                                                                                                                                               |
| ---- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `createCollection` | 创建名为 `openclaw_memory` 的 Collection，包含 15 个字段（id, text, embedding, memoryType, agentId, sessionKey, recallCount, provenance, createdAt, updatedAt 等） |
| 2    | `createIndex`      | 创建两个索引：HNSW（向量 ANN 搜索，COSINE 距离）+ SPARSE_INVERTED_INDEX（BM25 全文搜索）                                                                           |
| 3    | `loadCollection`   | 将 Collection 加载到 Milvus 内存中，准备接受查询                                                                                                                   |

> **幂等性**：如果 Collection 已经存在，三步全部跳过，不会重复创建或覆盖。这是
> 生产级的健壮设计。

### 2.3 用 Milvus HTTP API 验证 Collection 结构

```bash
# 查看 Collection 是否存在及其字段schema
curl -s http://localhost:9091/api/v1/collection | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Collection 名称:', d['collection_name'])
print('字段数量:', len(d.get('schema', {}).get('fields', [])))
print('字段列表:')
for f in d.get('schema', {}).get('fields', []):
    print(f'  - {f[\"name\"]:20s} {f[\"data_type\"]}')
"
```

**预期输出示例：**

```
Collection 名称: openclaw_memory
字段数量: 15
字段列表:
  - id                   Int64
  - text                 VarChar
  - embedding            FloatVector(1024)
  - memoryType           VarChar
  - agentId              VarChar
  - sessionKey           VarChar
  - recallCount          Int64
  - provenance           JSON
  - createdAt            VarChar
  - updatedAt            VarChar
  ...
```

> **对齐点**：15 字段 schema 完全覆盖了 memory-core 的 MemoryEntry 接口定义。
> 多出来的字段（如 `sessionKey`、`recallCount`）是 Milvus 特有的优化字段，用于
> 高效的 session 隔离和 dreaming 推广排序。

---

## 3. 写记忆 → 终端验证条数增加（最直观的证明）

> **这才是你最关心的**：和 OpenClaw 聊天，告诉它你的喜好/决定/偏好，然后终端里
> 马上能看到记忆条数增加了。

### 3.1 先查一下当前记忆条数（基准值）

```bash
# 用 Milvus HTTP API 查当前 Collection 中的行数
curl -s "http://localhost:9091/api/v1/collection" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'基准记忆条数: {d.get(\"num_entities\", 0)}')
"
```

记住这个数字，比如 **0 条**。

### 3.2 和 OpenClaw 聊天，让它记住你的偏好

打开 OpenClaw 对话框（或 Web UI），开始一段对话：

```
你: 记住，我最喜欢的颜色是钴蓝色，我每天早上6点起床跑步。
你: 另外，我的项目代码风格偏好是：用单引号，缩进用2个空格，不用分号。
你: 还有，我的咖啡偏好是冰美式，不加糖。
```

**发生了什么？**

1. OpenClaw 的 **auto-flush 机制**检测到对话积累了足够多的信息
2. 触发一次 **flush turn**：模型收到"提取这段对话中值得持久化的记忆"的指令
3. 模型调用 `memory_write` 工具，每条记忆一行
4. `memory_write` 内部调用 `MilvusSearchManager.write()`：
   - 调用 embedding provider 生成文本的 1024 维向量
   - 插入到 Milvus `openclaw_memory` Collection
   - 返回插入成功的 id

### 3.3 终端再次查询 —— 条数增加了！

```bash
curl -s "http://localhost:9091/api/v1/collection" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'当前记忆条数: {d.get(\"num_entities\", 0)}')
"
```

**你现在应该看到数字增加了！** 比如从 0 → 3（取决于 AI 提取了几个独立记忆）。

### 3.4 验证写入的具体内容

```bash
# 用 Milvus REST API 直接查询最近的记忆内容
curl -s -X POST "http://localhost:9091/api/v1/query" \
  -H "Content-Type: application/json" \
  -d '{
    "collection_name": "openclaw_memory",
    "output_fields": ["id", "text", "memoryType", "recallCount", "createdAt"],
    "limit": 10,
    "order_by": [{"field": "id", "order": "desc"}]
  }' | python3 -c "
import sys,json
results = json.load(sys.stdin)
for row in results.get('data', []):
    print(f'  id={row[\"id\"]:5d}  type={row.get(\"memoryType\",\"?\"):12s}  recalls={row.get(\"recallCount\",0):3d}  text={row.get(\"text\",\"\")[:60]}...')
"
```

**预期输出：**

```
  id=    1  type=short_term   recalls=  0  text=用户最喜欢的颜色是钴蓝色...
  id=    2  type=short_term   recalls=  0  text=用户每天早上6点起床跑步...
  id=    3  type=short_term   recalls=  0  text=项目代码风格：单引号、2空格缩进、无分号...
  id=    4  type=short_term   recalls=  0  text=咖啡偏好：冰美式，不加糖...
```

### 3.5 在聊天中搜索记忆（体验 memory_search 工具）

在同一个对话中（或新对话），让 AI 帮你搜记忆：

```
你: 我之前说过我喜欢什么颜色？帮我从记忆里搜一下。
```

AI 会调用 `memory_search` 工具，参数大致是 `{"query": "喜欢的颜色", "corpus": "memory"}`。

**你在聊天中应该看到类似这样的返回：**

```
🔍 Memory Search Results (corpus: memory):

1. id=1  score=0.87
   "用户最喜欢的颜色是钴蓝色"
   ── provenance: kind=chat_extract, agent=default

2. id=3  score=0.45
   "项目代码风格：单引号、2空格缩进..."
   ── provenance: kind=chat_extract, agent=default
```

> **对齐点**：返回格式和 memory-core / memory-lancedb 完全一致：
>
> - `id` 是数字（Milvus 自增主键）
> - `score` 是 0-1 的相似度分数（COSINE 距离转换）
> - `snippet` 是记忆内容截断
> - `provenance` 包含来源元数据
> - 返回结果带有 `Source: chat_extract` 引用装饰

### 3.6 在聊天中按 ID 读取完整记忆（体验 memory_get 工具）

```
你: 帮我把 id=1 的那条记忆完整读出来
```

AI 调用 `memory_get` 工具，返回完整记忆：

```
📋 Memory #1 (short_term)
   "用户最喜欢的颜色是钴蓝色"
   recallCount: 0
   createdAt: 2026-05-14T10:30:00.000Z
   updatedAt: 2026-05-14T10:30:00.000Z
   provenance:
     kind: "chat_extract"
     agent: "default"
     sessionKey: "abc123..."
```

> **对齐点**：`memory_write`、`memory_search`、`memory_get` 三个工具的名称、
> 参数结构、返回值格式，都和 memory-core 的规范完全一致。OpenClaw 核心框架
> 不关心后端是 LanceDB 还是 Milvus，只要实现了同样的工具契约就行。

---

## 4. 多 Corpus 搜索路由 —— 验证 memory/wiki/sessions/all 四种搜索范围

### 4.1 Corpus 路由规则

| Corpus     | 行为                                                  | 底层实现                                      |
| ---------- | ----------------------------------------------------- | --------------------------------------------- |
| `memory`   | 只搜 Milvus，不限 session                             | Milvus ANN + BM25 混合搜索                    |
| `sessions` | 只搜 Milvus，按当前 sessionKey 过滤                   | Milvus 带 filter 的混合搜索                   |
| `wiki`     | 只搜已注册 wiki 补充源（如 memory-wiki），不走 Milvus | 只查 wiki supplement                          |
| `all`      | Milvus 结果 + wiki 结果合并，统一排序                 | 双路查询 → 归并 → 去重 → 按 unifiedScore 排序 |

### 4.2 验证方法

```
你: 搜一下 memory corpus 中关于"颜色"的记忆
你: 搜一下 sessions corpus 中关于"颜色"的记忆（只返回当前会话）
你: 用 all corpus 搜"颜色"（如果装了 memory-wiki，会合并两边结果）
```

> **对齐点**：multi-corpus 路由逻辑在 `memory-core` 中定义，memory-milvus 的
> `MilvusSearchManager.search()` 实现完整支持 `corpus` 参数，且正确区分
> `memory`/`sessions`（加 sessionKey filter）和 `all`（返回时标记 provenance.kind
> 为 `milvus`，和 wiki supplement 结果区分）。

---

## 5. Dreaming 推广 —— 短期记忆自动升级为长期记忆

### 5.1 什么是 Dreaming？

Dreaming 是 memory-core 定义的标准能力：定期扫描短期记忆，把"被反复使用的"
短期记忆自动升级为长期记忆。

**算法：**

1. `rankPromotionCandidates` 对每条 short_term 记忆计算综合分数：
   - recallCount 越高 → 分数越高（被 AI 调用 memory_search 命中的次数）
   - 创建时间越近 → 分数越高（recency 加权）
   - `uniqueQueries` 越多 → 分数越高（被不同问题命中）
2. 分数超过 `dreaming.minScore`（默认 0.3）的记忆入选
3. `applyPromotions` 创建 long_term 副本，把原 short_term 归档为 archived

### 5.2 怎么手动触发（不用等 cron）

在 OpenClaw 聊天中输入：

```
/milvus-dreaming
```

> **注意**：这是**聊天里的斜杠命令**，不是在终端输入。`/milvus-dreaming` 是
> runtime-slash 命令，由 OpenClaw Gateway 接收后路由给 memory-milvus 插件执行。

### 5.3 触发前准备 —— 先让记忆被"使用"过

```
你: 我之前有什么颜色偏好来着？帮我搜一下。
你: 我的咖啡是什么口味？
你: 我的代码风格是什么？
```

反复搜几次，让某些记忆的 `recallCount` 增加。

### 5.4 查看 dreaming 日志

```powershell
# PowerShell：查看包含 dreaming 的日志行
Get-Content ~/.openclaw/logs/gateway-*.log | Select-String "dreaming"
```

**你应该看到类似这样的日志：**

```
[memory-milvus] dreaming: ranked 4 candidates, minScore=0.30
[memory-milvus] dreaming: 2 candidates above threshold
[memory-milvus] dreaming: promoted id=1 "用户最喜欢的颜色是钴蓝色" (score=0.65)
[memory-milvus] dreaming: promoted id=4 "咖啡偏好：冰美式，不加糖" (score=0.52)
[memory-milvus] dreaming: applied 2 promotions, 0 failures
```

### 5.5 验证推广效果

```bash
# 查看记忆类型分布
curl -s -X POST "http://localhost:9091/api/v1/query" \
  -H "Content-Type: application/json" \
  -d '{
    "collection_name": "openclaw_memory",
    "output_fields": ["id", "text", "memoryType"],
    "filter": "memoryType == \"long_term\"",
    "limit": 10
  }' | python3 -c "
import sys,json
results = json.load(sys.stdin)
print(f'长期记忆条数: {len(results.get(\"data\", []))}')
for row in results.get('data', []):
    print(f'  id={row[\"id\"]} text={row.get(\"text\",\"\")[:60]}')
"
```

> **对齐点**：Dreaming 推广使用了 memory-core 定义的 `ShortTermPromotionDreaming`
> 接口（`rankCandidates` + `applyPromotions`），逻辑和 memory-lancedb 一致，只是
> 底层存储从 LanceDB 换成了 Milvus。

### 5.6 定时自动 Dreaming（cron 配置）

如果不想手动敲 `/milvus-dreaming`，可以配置定时执行：

```json5
{
  plugins: {
    entries: {
      "memory-milvus": {
        config: {
          dreaming: {
            enabled: true, // 启用自动 dreaming
            cron: "0 3 * * *", // 每天凌晨3点执行一次
            limit: 5, // 每次最多推广5条
            minScore: 0.3, // 最低综合分数阈值
            minRecallCount: 2, // 至少被调用了2次的记忆才考虑推广
          },
        },
      },
    },
  },
}
```

> **注意**：cron 功能需要系统有 cron 服务（Linux）或等效的定时任务支持。

---

## 6. 降级模式 —— 验证 Milvus 断连时的 Fallback 机制

### 6.1 什么是降级模式？

当 Milvus 不可用时（网络断连、进程崩溃），插件不会报错崩溃，而是：

1. 写入操作自动重定向到本地 NDJSON 文件（`~/.openclaw/agents/<agent-id>/memory/.milvus-fallback/YYYY-MM-DD.ndjson`）
2. 读取操作返回空结果（不会假造数据）
3. `activeManager.degraded = true` 标记降级状态
4. 当 Milvus 恢复、Gateway 重启后，自动回放 fallback 文件中的所有待写入条目

### 6.2 手动模拟降级

```bash
# 步骤1：停止 Milvus
docker stop milvus-standalone

# 步骤2：重启 Gateway（让插件重新初始化，触发降级）
openclaw gateway restart
```

### 6.3 降级模式下的行为

现在和 OpenClaw 聊天：

```
你: 记住，我下周三有一个重要的客户演示。
```

**此时**：

- `memory_write` 被调用
- 尝试写 Milvus → 失败
- 自动 fallback 到本地 NDJSON 文件
- AI 不会知道写失败了（工具返回成功，只是写到了 fallback）

### 6.4 查看 Fallback 文件

```powershell
# PowerShell：查看 fallback 目录
ls ~/.openclaw/agents/default/memory/.milvus-fallback/

# 查看文件内容
Get-Content ~/.openclaw/agents/default/memory/.milvus-fallback/2026-05-14.ndjson
```

**文件内容示例（每行一条 JSON）：**

```json
{
  "text": "下周三有一个重要的客户演示",
  "memoryType": "short_term",
  "provenance": { "kind": "chat_extract", "agent": "default", "sessionKey": "xxx" },
  "timestamp": "2026-05-14T11:00:00.000Z"
}
```

### 6.5 恢复 Milvus 并验证回放

```bash
# 步骤1：启动 Milvus
docker start milvus-standalone

# 步骤2：重启 Gateway（触发 fallback 回放）
openclaw gateway restart
```

```powershell
# 步骤3：验证 fallback 目录已清空
ls ~/.openclaw/agents/default/memory/.milvus-fallback/
```

**预期：** 目录为空（或只有明天的空文件），之前 pending 的条目已全部写入 Milvus。

### 6.6 验证数据完整性

```bash
curl -s "http://localhost:9091/api/v1/collection" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'当前记忆条数（含 fallback 回放后）: {d.get(\"num_entities\", 0)}')
"
```

> **对齐点**：降级模式是 memory-core 定义的 `degraded` 标志位契约。
> memory-milvus 的 NDJSON fallback 实现和 memory-lancedb 的功能等价——都保证
> 在存储后端不可用时不会丢数据。

---

## 7. CLI 命令：Markdown ↔ Milvus 双向迁移

### 7.1 什么是 memory-migrate？

`openclaw memory-migrate` 是 memory-milvus 独有的 CLI 命令，用于：

- **导入**：把 MARKDOWN 文件（如 `MEMORY.md`）中的记忆导入到 Milvus
- **导出**：把 Milvus 中的记忆导出为分组的 Markdown 文件
- **去重**：用 SHA-256 内容哈希自动跳过已存在的记忆

### 7.2 创建测试数据

创建一个测试用记忆目录：

```bash
mkdir -p ~/test-memories

# 创建一个 MEMORY.md 文件
cat > ~/test-memories/MEMORY.md << 'EOF'
# 项目偏好
- 使用 TypeScript 严格模式
- 后端用 Node.js 22+

# 团队约定
- 每周五下午代码评审
- PR 需要2人 approve

# 个人偏好
- 用 VS Code 开发
- 配色主题用 Dark Modern
EOF
```

### 7.3 Dry-Run 预览（不实际写入）

```bash
openclaw memory-migrate ~/test-memories --dry-run
```

**预期输出：**

```
[1/1] file=MEMORY.md
  [1/3] action=would-insert  section=MEMORY.md#项目偏好
  [2/3] action=would-insert  section=MEMORY.md#团队约定
  [3/3] action=would-insert  section=MEMORY.md#个人偏好
[Migration (dry-run)] inserted=3 skipped=0 failed=0 files=1
```

关键点：

- 文件按 `#` 标题自动分割成独立记忆（每段一个 Milvus 行）
- `provenance.label` 记录了来源：`MEMORY.md#项目偏好`
- Dry-run 不会修改任何数据

### 7.4 实际导入

```bash
openclaw memory-migrate ~/test-memories
```

**预期输出：**

```
[Migration] inserted=3 skipped=0 failed=0 files=1
```

### 7.5 验证导入结果

```bash
curl -s -X POST "http://localhost:9091/api/v1/query" \
  -H "Content-Type: application/json" \
  -d '{
    "collection_name": "openclaw_memory",
    "output_fields": ["id", "text", "provenance"],
    "filter": "provenance[\"kind\"] == \"markdown_migration\"",
    "limit": 10
  }' | python3 -c "
import sys,json
results = json.load(sys.stdin)
for row in results.get('data', []):
    p = row.get('provenance', {})
    label = p.get('label', '?') if isinstance(p, dict) else '?'
    print(f'  id={row[\"id\"]}  source={label}  text={row.get(\"text\",\"\")[:60]}')
"
```

### 7.6 去重验证（再导一次）

```bash
openclaw memory-migrate ~/test-memories
```

**预期输出：**

```
[Migration] inserted=0 skipped=3 failed=0 files=1
```

> **去重原理**：每条记忆的内容做 SHA-256 哈希，和 Milvus 中已有的记忆比对。
> 哈希一样 → 跳过。这是内容级去重，不是 id 去重，所以即使不同时间导入也不会重复。

### 7.7 反向导出（Milvus → Markdown）

```bash
openclaw memory-migrate ~/memory-export --reverse
```

这会创建类似如下的目录结构：

```
~/memory-export/
├── MEMORY.md                  # 所有来自 markdown_migration 的记忆汇总
├── 2026-05-14/
│   ├── short_term.md          # 今天创建的短期记忆
│   └── long_term.md           # 今天创建的长期记忆
└── 2026-05-13/
    └── short_term.md
```

可以用 `--type` 过滤：

```bash
openclaw memory-migrate ~/memory-export-long --reverse --type long_term
```

---

## 8. 后端切换 —— 证明 Slot 切换是透明的

这个测试证明 memory-milvus 完全遵循 OpenClaw 的 **memory slot 切换契约**。

### 8.1 当前状态：memory-milvus 活跃

```bash
openclaw plugins list
# 应该显示 memory-milvus 为活跃 memory 插件
```

### 8.2 切换到 memory-lancedb

编辑 config 改一行：

```json5
{
  plugins: {
    slots: {
      memory: "memory-lancedb", // 从 memory-milvus 改为 memory-lancedb
    },
  },
}
```

```bash
openclaw gateway restart
openclaw plugins list
# 现在显示 memory-lancedb 为活跃 memory 插件
```

### 8.3 切回 memory-milvus

再改回来：

```json5
{
  plugins: {
    slots: {
      memory: "memory-milvus", // 切回来
    },
  },
}
```

```bash
openclaw gateway restart
openclaw plugins list
# 显示 memory-milvus 活跃
```

> **关键点**：切换后端不会丢失数据。Milvus 的数据独立存在于 Milvus 服务器上，
> LanceDB 的数据独立存在于 `~/.openclaw/memory/lancedb/`。切回来之后，
> memory-milvus 重新连接 Milvus，所有之前写入的记忆都在。

---

## 9. 完整对齐清单

| #   | 能力                                       | memory-core 标准 | memory-milvus 实现 | 验证方法                                 |
| --- | ------------------------------------------ | :--------------: | :----------------: | ---------------------------------------- |
| 1   | `memory_write` 工具                        |        ✅        |         ✅         | §3.2 — 聊天触发写入，§3.3 终端查行数     |
| 2   | `memory_search` 工具                       |        ✅        |         ✅         | §3.5 — 聊天搜"最喜欢的颜色"              |
| 3   | `memory_get` 工具                          |        ✅        |         ✅         | §3.6 — 聊天按 ID 读取                    |
| 4   | `MemoryPluginCapability` 注册              |        ✅        |         ✅         | §1.1 — `plugins list` 显示 memory kind   |
| 5   | `promptBuilder` 系统提示注入               |        ✅        |         ✅         | 聊天中能看到 "Memory (Milvus)" 工具说明  |
| 6   | `flushPlanResolver` flush 计划             |        ✅        |         ✅         | §3.2 — auto-flush 触发 memory_write      |
| 7   | `runtime.getMemorySearchManager`           |        ✅        |         ✅         | §3 — 整套读写搜查 pipeline 工作          |
| 8   | `runtime.closeAllMemorySearchManagers`     |        ✅        |         ✅         | Gateway 关闭时自动调用                   |
| 9   | 多 corpus 路由（memory/wiki/all/sessions） |        ✅        |         ✅         | §4 — 四个 corpus 各有不同行为            |
| 10  | 引用装饰（citation decoration）            |        ✅        |         ✅         | §3.5 — 搜索结果带 `Source: chat_extract` |
| 11  | Agent 隔离（agentId + sessionKey）         |        ✅        |         ✅         | §4 — sessions corpus 按 sessionKey 过滤  |
| 12  | Dreaming 推广（rank + apply）              |        ✅        |         ✅         | §5 — `/milvus-dreaming` 触发推广         |
| 13  | 降级模式（NDJSON fallback）                |        ✅        |         ✅         | §6 — 停 Milvus → fallback → 恢复 → 回放  |
| 14  | Collection 自动创建                        |        —         |         ✅         | §2 — 启动时自动建表建索引                |
| 15  | Markdown ↔ Milvus 迁移                     |        —         |         ✅         | §7 — `memory-migrate` 双向迁移           |
| 16  | SHA-256 内容去重                           |        —         |         ✅         | §7.6 — 重复导入被跳过                    |
| 17  | BM25 原生全文搜索                          |        —         |         ✅         | §3.5 — 混合搜索：ANN + BM25 双路         |
| 18  | HNSW 向量索引（COSINE）                    |        —         |         ✅         | §2.2 — 启动时自动建 COSINE HNSW 索引     |
| 19  | Slot 切换契约                              |        ✅        |         ✅         | §8 — 改一行 config 换后端                |

---

## 10. 快速验证路径（10分钟跑完核心功能）

按顺序执行以下步骤，覆盖所有核心功能：

| 步骤 | 操作                              | 耗时  | 看什么              |
| ---- | --------------------------------- | ----- | ------------------- |
| ①    | `openclaw plugins list`           | 5秒   | memory-milvus 出现  |
| ②    | 终端查 Milvus 行数（基准）        | 10秒  | 记下初始数字        |
| ③    | **和 AI 聊天**（告诉它你的偏好）  | 2分钟 | AI 回复             |
| ④    | 终端再查 Milvus 行数              | 10秒  | **数字增加了！**    |
| ⑤    | 聊天中 `memory_search` "我的偏好" | 1分钟 | 看到搜索结果 + 分数 |
| ⑥    | 聊天中 `memory_get` 按 ID 读取    | 30秒  | 看到完整记忆        |
| ⑦    | 聊天中 `/milvus-dreaming`         | 1分钟 | 短期 → 长期推广     |
| ⑧    | 终端查 dreaming 日志              | 30秒  | promotion 记录      |
| ⑨    | `memory-migrate --dry-run`        | 30秒  | CLI 预览            |
| ⑩    | `memory-migrate` 实际导入         | 1分钟 | 去重跳过            |
| ⑪    | 终端查 Milvus 行数（最终）        | 10秒  | 包含导入的 + 对话的 |

**合计约 8-10 分钟**，覆盖：注册 → 写入 → 搜索 → 读取 → 推广 → 迁移 → 降级恢复。

---

## 附录 A：Windows PowerShell 专用命令速查

因为 `openclaw gateway logs` 在 Windows 上不支持直接管道，以下是对应的 PowerShell 写法：

```powershell
# 查看日志目录
ls ~/.openclaw/logs/

# 查看 latest gateway 日志中包含 memory-milvus 的行（最后 50 条匹配）
Get-Content ~/.openclaw/logs/gateway-*.log -Tail 200 | Select-String "memory-milvus"

# 查看 dreaming 相关日志
Get-Content ~/.openclaw/logs/gateway-*.log -Tail 200 | Select-String "dreaming"

# 持续监控日志（类似 tail -f，按 Ctrl+C 停止）
Get-Content ~/.openclaw/logs/gateway-*.log -Wait -Tail 50 | Select-String "memory-milvus"
```

> **如果日志文件路径不同**，先 `ls ~/.openclaw/logs/` 确认实际文件名，然后替换上面命令中的路径。

curl 在 Windows PowerShell 中的替代方案：

```powershell
# Windows 10+ 自带 curl.exe，用法和 Linux 一样
# 如果 curl 不工作，可以用 PowerShell 原生的 Invoke-RestMethod：

# 查 Milvus 健康状态
Invoke-RestMethod -Uri "http://localhost:9091/healthz"

# 查 Collection 信息
$resp = Invoke-RestMethod -Uri "http://localhost:9091/api/v1/collection"
Write-Host "Collection: $($resp.collection_name), 行数: $($resp.num_entities)"

# 查询记忆内容
$body = @{
    collection_name = "openclaw_memory"
    output_fields = @("id","text","memoryType")
    limit = 10
} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:9091/api/v1/query" -Method POST -Body $body -ContentType "application/json"
```

---

## 附录 B：常见问题排查

### Q: `openclaw plugins list` 里看不到 memory-milvus？

1. 检查 `openclaw.json5` 中 `plugins.slots.memory` 是否设为 `"memory-milvus"`
2. 检查 `plugins.entries["memory-milvus"].enabled` 是否为 `true`
3. 检查 `plugins.entries["memory-milvus"].config` 是否存在（不能为空）
4. 重启 Gateway：`openclaw gateway restart`
5. 如果还看不到，查看日志：`Get-Content ~/.openclaw/logs/gateway-*.log -Tail 100 | Select-String "error|warn"`

### Q: 写记忆后行数没增加？

1. 确认 Milvus 在运行：`docker ps | grep milvus`（或 PowerShell: `docker ps | Select-String milvus`）
2. 确认 embedding provider 可用了 —— 日志里应该有 embedding 创建成功的记录
3. Auto-flush 可能需要积累足够的对话内容才会触发。可以多聊几句，或者等 AI 自然触发。
4. 直接查看 Gateway 日志确认有没有报错

### Q: embedding provider 报错 "Unknown memory embedding provider"？

把 `embedding.provider` 设为 `"auto"`，不要设 `"alibaba"`（alibaba 插件不支持 embedding）或 `"local"`（需要 bundled plugin 依赖）。

### Q: `/milvus-dreaming` 没反应？

1. 确认是在**聊天里**输入（不是终端）
2. 确认 `plugins.slots.memory` 当前是 `"memory-milvus"`
3. 确认至少有一些 short_term 记忆（先做 §3 的写入测试）
4. 查看 dreaming 日志确认状态

### Q: `memory-migrate` 命令找不到？

1. 确认 `plugins.slots.memory` 当前是 `"memory-milvus"`（migrate CLI 只在激活时注册）
2. 重启 Gateway：`openclaw gateway restart`
3. 运行 `openclaw --help` 确认 `memory-migrate` 出现在命令列表中
