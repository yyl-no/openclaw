# `feat/memory-milvus` 分支代码问题报告（更新版）

## 一、总体结论

`feat/memory-milvus` 分支已经不是简单的 LanceDB 残留版本，而是确实新增了独立的 `memory-milvus` 插件。该分支已经包含：

```text
extensions/memory-milvus/
  package.json
  index.ts
  src/schema.ts
  src/collection-bootstrap.ts
  src/search.ts
  src/tools.ts
  src/tools.search.ts
  src/tools.get.ts
  src/fallback.ts
  src/migrate.ts
  src/memory-milvus.live.test.ts
```

其中 manifest 已经改为 `@openclaw/memory-milvus`，并引入了 `@zilliz/milvus2-sdk-node`。这说明重构方向是正确的。

但当前代码仍然存在多处**运行时致命问题、数据一致性问题、配置能力不足、Memory Core 接口兼容问题、迁移路径失败风险**。目前状态更适合描述为：

```text
Milvus 后端原型版 / 半成品
不建议直接合入主分支
不建议直接作为稳定插件使用
```

---

## 二、P0：必须立即修复的问题

### P0-1：入口文件硬编码本机绝对路径，换环境必然失败

`extensions/memory-milvus/index.ts` 中存在硬编码路径：

```ts
const _bundled = _require(
  "/home/yl/.npm-global/lib/node_modules/openclaw/dist/memory-core-bundled-runtime-BcwkfmWM.js",
);
```

这是最严重的问题。该路径只在作者本机成立，在以下环境都会直接失败：

```text
其他开发者机器
GitHub Actions
Docker
npm 安装环境
pnpm workspace
组织仓库
生产环境
```

失败形式通常是：

```text
Cannot find module '/home/yl/.npm-global/lib/node_modules/openclaw/dist/memory-core-bundled-runtime-BcwkfmWM.js'
```

而且该文件名带 hash：`memory-core-bundled-runtime-BcwkfmWM.js`，构建后 hash 可能变化，不能作为稳定 API 使用。

#### 建议修复

不要直接 require dist hash 文件。应该把需要的函数暴露为稳定 SDK API，例如：

```ts
import { registerBuiltInMemoryEmbeddingProviders } from "openclaw/plugin-sdk/memory-core-bundled-runtime";
```

如果当前 SDK 没有导出，则应先在 `plugin-sdk` 中增加稳定导出，而不是绕过包边界读取构建产物。

---

### P0-2：全局单例 `activeManager` 会导致多 agent / 多会话串数据

当前入口文件中只有一个全局变量：

```ts
let activeManager: MilvusSearchManager | null = null;
```

每次 `getMemorySearchManager()` 初始化后都会覆盖该变量。`memory_write`、`memory_search`、`memory_get` 工具也都通过这个全局变量拿 manager。

这会导致：

```text
1. 多 agent 并发时，后初始化的 agent 覆盖前一个 agent
2. 多 collection / 多配置时，工具可能拿错 manager
3. cron / dreaming / channel 会话并发时，可能操作错误 agent 的记忆库
4. closeAllMemorySearchManagers 只能关闭最后一个 manager
5. activeManager degraded 状态可能污染其他 agent
```

#### 建议修复

改成 manager 池：

```ts
const managers = new Map<string, MilvusSearchManager>();

function managerKey(params) {
  return [params.agentId, params.collectionName, params.host, params.port].join(":");
}
```

`memory_write/search/get` 的 `getManager` 也不应只依赖全局变量，而应由运行时上下文解析当前 agent/session 对应 manager。

---

### P0-3：`upsert` 被当作“局部更新”使用，可能破坏数据或插入残缺行

当前 `archive()` 中只传了局部字段：

```ts
await this.client.upsert({
  collection_name: this.collectionName,
  data: [
    {
      [FIELD_ID]: Number(rawId),
      [FIELD_MEMORY_TYPE]: "archived",
      [FIELD_UPDATED_AT]: now,
    },
  ],
});
```

`applyPromotions()` 中归档原记录时也采用同样的局部 upsert。

这在 Milvus 中风险很高。`upsert` 更接近“按主键写入整行”，不是 SQL 的：

```sql
UPDATE memory SET memory_type = 'archived' WHERE id = ...
```

如果只传局部字段，可能出现：

```text
1. 因缺少 vector/text 等必需字段而 upsert 失败
2. 覆盖原记录并清空其他字段
3. 插入一条字段残缺的新记录
4. 后续 search/get/export 出现异常数据
```

代码在 `recordRecall()` 里已经写了注释：

```ts
// Preserve existing field values (upsert requires full rows to avoid clearing fields)
```

说明作者已经意识到 upsert 需要保留完整字段，但 `archive()` 和 `applyPromotions()` 没有遵守。

#### 建议修复

封装统一的 patch 方法：

```ts
async function patchMemoryById(id: string, patch: Partial<MemoryEntry>) {
  const existing = await get(id);
  const embeddingRow = await queryEmbeddingAndHash(id);
  const fullRow = merge(existing, embeddingRow, patch);
  await client.upsert({ collection_name, data: [fullRow] });
}
```

禁止在业务代码中直接局部 upsert。

---

### P0-4：`recordRecall()` 会为不存在的 id 创建残缺记录

`recordRecall()` 查询已有记录后，即使某个 id 没有查到，也会构造 row 并加入 `upsertRows`：

```ts
const existing = existingMap.get(id);
const prevCount = existing?.[FIELD_RECALL_COUNT] != null ? Number(existing[FIELD_RECALL_COUNT]) : 0;

const row = {
  [FIELD_ID]: id,
  [FIELD_RECALL_COUNT]: prevCount + 1,
  [FIELD_LAST_RECALLED_AT]: now,
  [FIELD_UPDATED_AT]: now,
};
```

只有 `existing` 存在时才补齐 text/snippet/agent_id 等字段；不存在时仍然会 upsert 这条残缺 row。

这会导致：

```text
1. 记录不存在时被 recordRecall 意外创建
2. 新记录缺少 text / snippet / embedding / provenance 等关键字段
3. 后续 query/search/get 出现异常
4. 数据库出现垃圾行
```

#### 建议修复

不存在的 id 应直接跳过：

```ts
for (const id of ids) {
  const existing = existingMap.get(id);
  if (!existing) {
    continue;
  }

  const row = buildFullRecallUpdateRow(existing);
  upsertRows.push(row);
}
```

同时要过滤 `fallback:`、`milvus:` 这种非纯数字 id，避免拼进 Milvus filter。

---

### P0-5：`memory-core` 的 lazy `memory_write` 工具定义错配

`extensions/memory-core/index.ts` 中 `createLazyMemoryWriteTool()` 存在明显错配：

```ts
function createLazyMemoryWriteTool(options: MemoryToolOptions): AnyAgentTool | null {
  return createLazyMemoryTool({
    options,
    label: "Memory Write",
    name: "memory_write" as "memory_search",
    description:
      "Write a memory entry extracted from the conversation. " +
      "Use this to persist facts, decisions, preferences, and learnings. " +
      "Each entry is stored with text content and an optional source label.",
    parameters: MemoryGetSchema,
    load: (module, loadOptions) => module.createMemoryWriteTool(loadOptions),
  });
}
```

这里至少有两个问题：

```text
1. name 被强转为 "memory_search"，实际工具名应为 "memory_write"
2. parameters 复用了 MemoryGetSchema，但 memory_write 实际需要 { text, label? }
```

这会导致 memory-core lazy tool 暴露给模型/工具运行时的 schema 与真实工具不一致，可能出现：

```text
1. 模型按 memory_get 的参数格式调用 memory_write
2. 工具路由或工具名类型判断异常
3. memory_write 无法被正确调用或参数校验失败
4. 与 memory-milvus 的 createMemoryWriteTool schema 不一致
```

#### 建议修复

应定义独立的 `MemoryWriteSchema`，并移除错误强转：

```ts
const MemoryWriteSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "The memory text to persist as a standalone entry.",
    },
    label: {
      type: "string",
      description: "Optional memory source label.",
    },
  },
  required: ["text"],
};

function createLazyMemoryWriteTool(options: MemoryToolOptions): AnyAgentTool | null {
  return createLazyMemoryTool({
    options,
    label: "Memory Write",
    name: "memory_write",
    description: "...",
    parameters: MemoryWriteSchema,
    load: (module, loadOptions) => module.createMemoryWriteTool(loadOptions),
  });
}
```

这项问题不只影响 `memory-milvus`，也会影响 memory-core 对 write tool 的统一懒加载能力，应优先修。

---

## 三、P1：高优先级问题

### P1-1：Milvus 配置解析能力不足

当前 `parseMilvusConfig()` 只解析：

```ts
host;
port;
collectionName;
embedding.provider;
embedding.model;
embedding.dimensions;
```

但 `MilvusSearchConfig` 类型本身已经定义了：

```ts
search.vectorWeight;
search.textWeight;
search.useBM25;
```

入口解析时没有把 `raw.search` 写入 `searchCfg`，导致这些配置虽然在类型上存在，但用户实际配置不会生效。

同时 collection bootstrap 支持：

```ts
hnswM;
efConstruction;
metricType;
```

但入口调用 `ensureCollectionReady()` 时只传了：

```ts
collectionName;
embeddingDim;
```

用户无法控制索引参数。

#### 建议修复

配置结构至少应支持：

```json5
{
  milvus: {
    address: "localhost:19530",
    host: "localhost",
    port: 19530,
    token: "${MILVUS_TOKEN}",
    username: "${MILVUS_USERNAME}",
    password: "${MILVUS_PASSWORD}",
    database: "default",
    ssl: false,
    collectionName: "openclaw_memory",
  },
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  index: {
    metricType: "COSINE",
    indexType: "HNSW",
    hnswM: 16,
    efConstruction: 200,
  },
  search: {
    vectorWeight: 0.7,
    textWeight: 0.3,
    useBM25: false,
  },
}
```

---

### P1-2：Milvus client 只支持无认证本地连接

当前工厂函数：

```ts
export function createMilvusClient(host: string, port: number): MilvusClient {
  const address = host.includes(":") ? host : `${host}:${port}`;
  return new MilvusClient(address);
}
```

这只能支持最简单的本地无认证 Milvus。

无法支持：

```text
Zilliz Cloud
token 鉴权
用户名/密码
TLS/SSL
database
自定义 address
```

#### 建议修复

改成对象配置：

```ts
export function createMilvusClient(config: MilvusConnectionConfig): MilvusClient {
  return new MilvusClient({
    address: config.address ?? `${config.host}:${config.port}`,
    token: config.token,
    username: config.username,
    password: config.password,
    ssl: config.ssl,
    database: config.database,
  });
}
```

---

### P1-3：BM25 / SparseFloatVector 设计不完整，可能导致 collection 或 insert 失败

当前 schema 创建了：

```ts
FIELD_SPARSE_BM25;
data_type: "SparseFloatVector";
```

并且 bootstrap 中总是创建 sparse index：

```ts
index_type: "SPARSE_INVERTED_INDEX";
```

但写入数据时，`entryToInsertData()` 没有提供 `sparse_bm25` 字段；代码注释说需要 Milvus server-side BM25 Function，但 `ensureCollectionReady()` 并没有创建 BM25 Function，也没有注册 `text -> sparse_bm25` 的函数映射。

可能结果：

```text
1. createCollection 因 SparseFloatVector / Function 配置不完整失败
2. createIndex sparse index 失败
3. insert 时缺少 sparse_bm25 字段失败
4. useBM25 打开后 hybridSearch 永远不可用
```

#### 建议修复

短期建议：先删除 BM25 sparse 字段和 sparse index，仅保留：

```text
dense vector search
scalar filter
keyword query
client-side TF-IDF
```

长期再补完整 BM25：

```text
Milvus Function
text -> sparse vector mapping
SparseFloatVector field
SPARSE_INVERTED_INDEX
hybridSearch
WeightedRanker
真实 Milvus 集成测试
```

---

### P1-4：向量 score 归一化硬编码 COSINE

`searchVector()` 中：

```ts
ref.score = normalizeVectorScore(r.score, "COSINE");
```

这里没有使用实际配置的 `metricType`。如果 collection 使用 `L2` 或 `IP`，score 归一化会错误。

#### 建议修复

把 metricType 放入 `MilvusSearchConfig`：

```ts
metricType: "COSINE" | "IP" | "L2";
```

然后：

```ts
ref.score = normalizeVectorScore(r.score, this.cfg.index.metricType);
```

---

### P1-5：`status()` 返回 backend 为 `"qmd"`

`MilvusSearchManager.status()` 当前返回：

```ts
backend: "qmd";
```

但这是 Milvus 后端，应该返回：

```ts
backend: "milvus";
```

否则上层 diagnostics、UI、日志和后端判断都会误判。

#### 建议修复

```ts
status(): MemoryProviderStatus {
  return {
    backend: "milvus",
    ...
  };
}
```

---

### P1-6：Markdown → Milvus 迁移把文件来源 provenanceLabel 当作 write label，可能批量失败

`extensions/memory-milvus/src/migrate.ts` 中，Markdown 迁移写入时传入：

```ts
await manager.write({
  text: chunk.text,
  snippet: chunk.text.slice(0, 200),
  memoryType: MEMORY_TYPES.SHORT_TERM,
  provenance: {
    kind: "file",
    label: provenanceLabel,
  },
});
```

其中 `provenanceLabel` 是类似：

```text
MEMORY.md:12:18
memory/2026-05-16.md:3:9
```

但 `MilvusSearchManager.write()` 会把 `entry.provenance?.label` 当作 source label 校验：

```ts
const label = (entry.provenance?.label as string) ?? MEMORY_SOURCE_LABELS.CHAT_EXTRACT;
assertValidSourceLabel(label);
```

合法 label 只有：

```text
chat_extract
user_manual
recall_promotion
import
```

因此迁移路径中传入 `MEMORY.md:12:18` 这类文件来源字符串时，会触发：

```text
Invalid memory source label: "MEMORY.md:12:18"
```

结果可能是：

```text
1. Markdown → Milvus 迁移批量失败
2. dry-run 看起来正常，实际写入时失败
3. 文件来源信息和 source label 概念混用
```

#### 根因

当前代码把两个不同概念混在同一个字段：

```text
source label：枚举值，例如 import / chat_extract
provenance label：具体来源，例如 MEMORY.md:12:18
```

#### 建议修复

拆分 source label 与 provenance label。例如：

```ts
await manager.write({
  text: chunk.text,
  snippet: chunk.text.slice(0, 200),
  memoryType: MEMORY_TYPES.SHORT_TERM,
  sourceLabel: MEMORY_SOURCE_LABELS.IMPORT,
  provenance: {
    kind: "file",
    label: provenanceLabel,
  },
});
```

如果短期不改类型，可以在迁移时不要把文件路径塞进 `write()` 的 label 校验字段，而是在 `insertEntry` 或 `entryToInsertData` 层单独写入 `provenance_label`。

---

## 四、P2：中优先级问题

### P2-1：Prompt 中 collection 名称写死为默认值

`buildPromptSection()` 中使用：

```ts
DEFAULT_COLLECTION_NAME;
```

这意味着即使用户配置了自定义 collection，prompt 仍显示默认：

```text
openclaw_memory
```

这不是功能性致命问题，但会误导模型和用户。

#### 建议修复

promptBuilder 需要能拿到当前 runtime config，或不要写具体 collection 名：

```text
Your memory is stored in a Milvus vector database.
```

---

### P2-2：`memory_search` 工具没有注入 cfg / sessionKey / sandboxed

`createMemorySearchTool()` 支持：

```ts
cfg;
agentSessionKey;
sandboxed;
```

用于 session visibility filtering 和 citation decoration。

但入口注册时只传了：

```ts
createMemorySearchTool({ getManager: () => activeManager });
```

这意味着：

```text
1. session visibility 过滤可能不会执行
2. citations mode 只能使用默认 auto
3. sessions corpus 权限语义不完整
```

#### 建议修复

需要从工具执行上下文或 runtime 中取得：

```ts
cfg;
agentSessionKey;
sandboxed;
agentId;
```

并传入 `createMemorySearchTool()`。

---

### P2-3：`memory_get` 与 memory-core 旧 path 语义兼容性不足

当前 `memory_get` 只接受 `id`，虽然 schema 保留了 `path/from/lines`，但说明这些参数对 Milvus 后端废弃。

如果上层模型或旧工具调用仍传：

```json
{ "path": "milvus:42" }
```

会返回：

```text
id is required for milvus backend memory retrieval
```

#### 建议修复

兼容 path：

```ts
const raw = params.id ?? params.path;
const id = normalizeMemoryId(raw);
```

支持：

```text
42
milvus:42
memory://42
```

---

### P2-4：`update()` 中 `memoryType` 类型断言优先级易误读

当前代码：

```ts
memoryType: patch.memoryType as MemoryEntry["memoryType"] ?? existing.memoryType,
```

虽然 TypeScript 运算优先级通常会按预期工作，但可读性差，容易被误解。

#### 建议修复

```ts
memoryType:
  patch.memoryType !== undefined
    ? (patch.memoryType as MemoryEntry["memoryType"])
    : existing.memoryType,
```

并且应该调用 `assertValidMemoryType()` 校验 patch。

---

### P2-5：filter 字符串拼接仍有边界风险

当前 filter 使用字符串拼接，例如：

```ts
id in [${ids.join(",")}]
```

如果 `ids` 中混入：

```text
fallback:...
milvus:...
非数字字符串
```

会导致 Milvus filter 语法错误。

#### 建议修复

所有主键进入 filter 前统一校验：

```ts
function normalizeNumericMilvusId(id: string): string | null {
  const raw = id.replace(/^milvus:/, "").trim();
  return /^\d+$/.test(raw) ? raw : null;
}
```

---

## 五、P3：质量和维护性问题

### P3-1：`console.warn` 应替换为 OpenClaw logger

代码中大量使用：

```ts
console.warn(...)
```

例如 collection bootstrap 失败、embedding 失败、vector search 失败、fallback replay error 等。

建议统一使用 `api.logger` 或注入 logger：

```ts
new MilvusSearchManager(..., { logger: api.logger })
```

否则日志无法进入 OpenClaw 统一诊断系统。

---

### P3-2：已有手动 live test，但缺少自动化、可重复的 Docker/CI Milvus 集成测试

原先笼统说“缺少真实 Milvus 集成测试”不准确。仓库中已经存在：

```text
extensions/memory-milvus/src/memory-milvus.live.test.ts
```

该文件是 live end-to-end test，并且注释中明确写了：

```text
CI auto-run is disabled.
Prerequisites:
1. Local Milvus running
2. Set embedding API key
Run: OPENCLAW_LIVE_TEST=1 pnpm test:live extensions/memory-milvus
```

测试本身通过：

```ts
const describeLive = describe.skipIf(process.env.OPENCLAW_LIVE_TEST !== "1");
```

进行手动 gated。

因此更准确的问题是：

```text
已有手动 live test；
但缺少自动化、可重复的 Docker/CI Milvus 集成测试。
```

当前 live test 仍不能自动证明：

```text
1. 每次 PR / push 都能启动干净 Milvus 环境
2. collection schema 在真实 Milvus 上稳定创建
3. sparse_bm25 字段和 index 在真实 Milvus 上可用
4. insert / search / get / recordRecall / archive 在干净环境中可重复通过
5. 不依赖开发者本机已存在的 collection 或历史数据
```

#### 建议补充

增加 Docker 化集成测试，例如：

```text
1. 测试前启动 Milvus standalone container
2. 使用随机 collectionName，例如 openclaw_memory_test_${timestamp}
3. 创建 collection
4. insert memory
5. search memory
6. get memory
7. recordRecall
8. archive
9. migration
10. fallback replay
11. 测试结束 drop collection
```

如果不想在主 CI 默认跑，可以先做成可手动触发或 nightly，但应保证环境可重复，而不是依赖本机 Milvus。

---

### P3-3：文档缺失

目前没有看到 `docs/plugins/memory-milvus.md`。这会导致用户不知道如何配置：

```text
Milvus host/port/address
embedding provider/model/dimensions
collectionName
fallback
migration
search options
```

建议补完整插件文档和最小配置样例。

---

## 六、修复优先级建议

### 第一阶段：先保证插件能启动

必须先修：

```text
1. 删除 /home/yl/... 绝对路径 require
2. 改为稳定 SDK import
3. 修复 createMilvusClient 配置结构
4. status.backend 改成 milvus
```

### 第二阶段：保证不会写坏数据

必须修：

```text
1. 所有局部 upsert 改为完整行 upsert
2. recordRecall 跳过不存在 id
3. 所有 id 进入 filter 前做 numeric 校验
4. archive/applyPromotions 复用统一 patchById
```

### 第三阶段：修正 Memory Core / 工具 schema 兼容

必须修：

```text
1. memory-core lazy memory_write name 不应强转为 memory_search
2. memory_write 应使用 MemoryWriteSchema，而不是 MemoryGetSchema
3. memory-milvus 的 memory_write schema 与 memory-core lazy schema 保持一致
4. memory_get 兼容旧 path 语义
```

### 第四阶段：修复迁移路径

必须修：

```text
1. 区分 source label 与 provenance label
2. Markdown → Milvus 迁移使用 import 作为 source label
3. 文件路径、行号等来源信息进入 provenance_label 或额外 metadata
4. 增加迁移路径单元测试和 live test
```

### 第五阶段：简化并稳定 Milvus schema

建议先修：

```text
1. 暂时移除 SparseFloatVector / BM25
2. 只保留 dense vector + keyword query
3. 等真实 Milvus 集成测试通过后再加 BM25 Function
```

### 第六阶段：补齐配置和多 agent 支持

需要修：

```text
1. activeManager 改为 manager map
2. parseMilvusConfig 补齐 search/index/auth/database
3. memory_search 注入 cfg/sessionKey/sandboxed
4. prompt 不再写死 DEFAULT_COLLECTION_NAME
```

---

## 七、最终评估

当前 `feat/memory-milvus` 分支的状态可以概括为：

```text
方向：正确
架构雏形：已形成
Milvus 接入：已有真实代码
测试：有单元测试和手动 gated live test，但缺自动化 Docker/CI 集成测试
稳定性：不足
数据安全：存在风险
迁移链路：存在批量失败风险
可合并性：暂不建议合入主分支
```

完成度评估：

```text
功能原型完成度：60%
稳定可用完成度：35% - 45%
```

最关键的阻断项是：

```text
P0-1：硬编码 /home/yl/... 绝对路径
P0-2：activeManager 全局单例
P0-3：局部 upsert 可能破坏数据
P0-4：recordRecall 可能创建残缺记录
P0-5：memory-core lazy memory_write schema/name 错配
P1-3：BM25/SparseFloatVector 实现不完整
P1-6：Markdown → Milvus 迁移 label/provenance 概念混用
```

建议先不要继续扩展 dreaming、BM25 等高级功能，而是先把“启动、连接、写入、搜索、读取、更新、归档、迁移”这条最小闭环稳定下来。
