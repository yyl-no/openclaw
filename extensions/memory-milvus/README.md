# Memory Milvus

`memory-milvus` stores OpenClaw memory entries in Milvus and exposes the same
memory tool surface used by the active memory system:

- `memory_write` persists extracted memories.
- `memory_search` recalls memories with Milvus vector search.
- `memory_get` reads a memory entry by id.
- `milvus-dreaming` manages scheduled short-term-to-long-term promotion.

Use this backend when you want OpenClaw memory in a dedicated vector database,
or when you already operate Milvus as part of your local or production stack.

## Requirements

- OpenClaw Gateway (the `openclaw` CLI must be available).
- Node.js 22 or newer.
- `pnpm` through Corepack.
- A running Milvus server reachable from the OpenClaw Gateway.
- A configured embedding provider, such as `openai`, `alibaba`, or `auto`.

The recommended first setup uses dense vector search with an HNSW index. BM25
sparse hybrid search is available only for Milvus deployments whose BM25
Function support is configured and verified.

## Installation

Clone the repository, then install dependencies and build:

```bash
corepack pnpm install
corepack pnpm build
```

Install the plugin into your local OpenClaw state:

```bash
corepack pnpm openclaw plugins install extensions/memory-milvus --force
```

Restart the Gateway after installing or updating the plugin:

```bash
corepack pnpm openclaw gateway restart
```

## Start Milvus

For local testing, start a standalone Milvus container:

```bash
docker run -d --name milvus-standalone \
  -p 19530:19530 -p 9091:9091 \
  milvusdb/milvus:v2.4.0 standalone
```

If you already have a Milvus deployment, use its host, gRPC port, and
authentication settings in the plugin config instead.

## Configure OpenClaw

Select `memory-milvus` as the active memory backend:

```bash
corepack pnpm openclaw config set plugins.slots.memory memory-milvus
corepack pnpm openclaw config set plugins.entries.memory-milvus.enabled true
```

Configure the Milvus connection:

```bash
corepack pnpm openclaw config set plugins.entries.memory-milvus.config.milvus.host 127.0.0.1
corepack pnpm openclaw config set plugins.entries.memory-milvus.config.milvus.port 19530
corepack pnpm openclaw config set plugins.entries.memory-milvus.config.milvus.collectionName openclaw_memory
```

Configure the embedding provider:

```bash
corepack pnpm openclaw config set plugins.entries.memory-milvus.config.embedding.provider openai
corepack pnpm openclaw config set plugins.entries.memory-milvus.config.embedding.model text-embedding-v3
corepack pnpm openclaw config set plugins.entries.memory-milvus.config.embedding.dimensions 1024
```

Use the stable dense-vector path unless you have verified BM25 support on your
Milvus deployment:

```bash
corepack pnpm openclaw config set plugins.entries.memory-milvus.config.search.useBM25 false
```

Enable conversation access for the memory hooks:

```bash
corepack pnpm openclaw config set plugins.entries.memory-milvus.hooks.allowConversationAccess true
```

Restart the Gateway:

```bash
corepack pnpm openclaw gateway restart
```

## Verify the backend

Check that the Gateway is running and loading the plugin:

```bash
corepack pnpm openclaw gateway status
corepack pnpm openclaw plugins list
```

Open the Control UI and ask the assistant to use `memory_write`, for example:

```text
Use memory_write to remember: Milvus memory verification is working.
```

Watch the Gateway log:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | grep memory-milvus
```

A successful write logs a Milvus id, not a `fallback:` id:

```text
[memory-milvus] insert succeeded collection=openclaw_memory id=... pk=returned
[memory-milvus] memory_write completed id=...
```

You can also inspect the collection in Attu. The `embedding` field should have
an HNSW index. Other scalar fields may show a "create index" action in Attu;
that is optional UI functionality and is not required for the memory backend.

## Configuration reference

The plugin reads its config from
`plugins.entries.memory-milvus.config`.

```json5
{
  plugins: {
    slots: {
      memory: "memory-milvus",
    },
    entries: {
      "memory-milvus": {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
        },
        config: {
          milvus: {
            host: "127.0.0.1",
            port: 19530,
            collectionName: "openclaw_memory",
          },
          embedding: {
            provider: "openai",
            model: "text-embedding-v3",
            dimensions: 1024,
          },
          search: {
            useBM25: false,
            vectorWeight: 0.7,
            textWeight: 0.3,
          },
          index: {
            metricType: "COSINE",
            hnswM: 16,
            efConstruction: 200,
          },
          dreaming: {
            enabled: true,
            cron: "0 3 * * *",
            limit: 5,
            minScore: 0.3,
            minRecallCount: 2,
          },
        },
      },
    },
  },
}
```

### Milvus options

| Setting | Default | Description |
| --- | --- | --- |
| `milvus.host` | `"localhost"` | Milvus host or URL. |
| `milvus.port` | `19530` | Milvus gRPC and REST port. |
| `milvus.collectionName` | `"openclaw_memory"` | Collection used for memory entries. |
| `milvus.token` | unset | Bearer token for authenticated Milvus deployments. |
| `milvus.username` / `milvus.password` | unset | Username and password when token auth is not used. |
| `milvus.ssl` | `false` | Use HTTPS for REST calls. |
| `milvus.database` | default database | Milvus database name. |

### Embedding options

| Setting | Default | Description |
| --- | --- | --- |
| `embedding.provider` | `"auto"` | Memory embedding provider adapter. |
| `embedding.model` | `"text-embedding-v3"` | Embedding model name. |
| `embedding.dimensions` | provider default or `1024` | Vector dimension used for collection creation. |

The embedding dimension must match the model output. If you change dimensions,
use a new collection name or recreate the existing collection.

### Search options

| Setting | Default | Description |
| --- | --- | --- |
| `search.useBM25` | `false` | Enable Milvus BM25 sparse hybrid search on compatible deployments. |
| `search.vectorWeight` | `0.7` | Vector score weight used during result fusion. |
| `search.textWeight` | `0.3` | Text score weight used during result fusion. |

### Index options

| Setting | Default | Description |
| --- | --- | --- |
| `index.metricType` | `"COSINE"` | Metric for the dense vector index. |
| `index.hnswM` | `16` | HNSW `M` parameter. |
| `index.efConstruction` | `200` | HNSW construction parameter. |

## Storage model

The plugin stores entries in one Milvus collection. The stable collection
schema includes:

- `id`: auto-increment primary key.
- `embedding`: dense vector used for HNSW search.
- `text` and `snippet`: memory content and preview text.
- `agent_id` and `session_key`: logical isolation fields.
- `memory_type`: `short_term`, `long_term`, or `archived`.
- `recall_count` and `last_recalled_at`: recall tracking fields.
- `provenance_kind` and `provenance_label`: source metadata.
- `content_hash`: deduplication hash.
- `metadata`: JSON extension field.

The collection is created lazily the first time the plugin builds a memory
manager, usually during the first `memory_write`, `memory_search`, or dreaming
run. The plugin also creates the dense HNSW index and loads the collection.

## Dreaming

`memory-milvus` supports OpenClaw dreaming for short-term-to-long-term memory
promotion. Enable it with:

```bash
corepack pnpm openclaw config set plugins.entries.memory-milvus.config.dreaming.enabled true
corepack pnpm openclaw config set plugins.entries.memory-milvus.config.dreaming.cron "0 3 * * *"
corepack pnpm openclaw gateway restart
```

Manage dreaming from chat:

```text
/milvus-dreaming status
/milvus-dreaming on
/milvus-dreaming run
/milvus-dreaming off
```

The scheduled sweep uses the configured Milvus backend, recall counters,
recency, memory type, and model judgment to select promotion candidates.

## Migrate existing memory

Use `memory-migrate` to import file-backed memory into Milvus:

```bash
corepack pnpm openclaw memory-migrate ./path/to/memory
```

Preview a migration without writing:

```bash
corepack pnpm openclaw memory-migrate ./path/to/memory --dry-run
```

Export Milvus memory back to Markdown:

```bash
corepack pnpm openclaw memory-migrate ./path/to/memory --reverse
```

Reverse exports are written to a timestamped export directory and do not
overwrite the original Markdown files.

## BM25 sparse hybrid search

Dense vector search is the recommended default. To use BM25 sparse hybrid
search, your Milvus deployment must support BM25 Functions for collection
creation, sparse vector output fields, sparse indexes with `IP`, and insert-time
generation from a `VarChar` analyzer field.

Enable BM25 only after validating those server capabilities:

```bash
corepack pnpm openclaw config set plugins.entries.memory-milvus.config.search.useBM25 true
corepack pnpm openclaw config set plugins.entries.memory-milvus.config.milvus.collectionName openclaw_memory_bm25
corepack pnpm openclaw gateway restart
```

Use a new collection name when changing BM25 mode. A dense-only collection and a
BM25 collection have different schemas.

## Troubleshooting

### `memory_write` returns a `fallback:` id

The plugin could not insert into Milvus and wrote the entry to the local fallback
queue. Check the Gateway log:

```bash
tail -n 200 /tmp/openclaw/openclaw-$(date +%F).log | grep memory-milvus
```

Common causes:

- Milvus is not running or the host and port are wrong.
- The embedding provider is unavailable.
- The collection was created with an old or incompatible schema.
- BM25 was enabled on a deployment that does not support the required Function path.

After fixing the cause, run another `memory_write`. The plugin replays queued
fallback entries before writing the new entry.

### The collection exists but is not loaded

Restart the Gateway. The plugin attempts to load the collection during manager
initialization:

```bash
corepack pnpm openclaw gateway restart
```

If it remains unloaded, check Milvus logs and available memory.

### The entity count increases by more than one

One conversation can produce multiple memory entries. The plugin also replays
previous fallback entries after Milvus becomes healthy. Both behaviors increase
the Milvus entity count.

### Attu shows "create index" on scalar fields

The required index is the HNSW index on `embedding`. Attu may show optional
"create index" actions for scalar fields. Do not create those indexes unless
you have a specific Milvus query plan that requires them.

### Collection bootstrap fails after changing dimensions or BM25 mode

Milvus collection schemas are not automatically rewritten. Use a new collection
name when you change `embedding.dimensions` or `search.useBM25`:

```bash
corepack pnpm openclaw config set plugins.entries.memory-milvus.config.milvus.collectionName openclaw_memory_v2
corepack pnpm openclaw gateway restart
```

## Development checks

Run the focused tests:

```bash
corepack pnpm test extensions/memory-milvus/src/collection-bootstrap.test.ts extensions/memory-milvus/src/search.test.ts
```

Build the plugin:

```bash
corepack pnpm --dir extensions/memory-milvus build
```

Install the freshly built plugin into local OpenClaw state:

```bash
corepack pnpm openclaw plugins install extensions/memory-milvus --force
corepack pnpm openclaw gateway restart
```
