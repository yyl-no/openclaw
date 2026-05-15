# Memory (Milvus)

`memory-milvus` is a bundled memory plugin that stores long-term memory in
Milvus and uses vector ANN + BM25 hybrid search for recall. It integrates with
the same embedding provider adapters as `memory-core` and supports automated
short-term-to-long-term memory promotion via the OpenClaw dreaming pipeline.

Use it when you want a dedicated vector database for memory, need scalable
semantic search across large memory collections, or already run a Milvus
instance in your infrastructure.

<Note>
`memory-milvus` is an active memory plugin. Enable it by selecting the memory
slot with `plugins.slots.memory = "memory-milvus"`. Companion plugins such as
`memory-wiki` can run beside it, but only one plugin owns the active memory slot.
</Note>

## Quick start

Launch a local Milvus instance:

```bash
docker run -d --name milvus-standalone \
  -p 19530:19530 -p 9091:9091 \
  milvusdb/milvus:v2.4.0 standalone
```

Configure the plugin:

```json5
{
  plugins: {
    slots: {
      memory: "memory-milvus",
    },
    entries: {
      "memory-milvus": {
        enabled: true,
        config: {
          milvus: {
            host: "localhost",
            port: 19530,
          },
          embedding: {
            provider: "alibaba",
            model: "text-embedding-v3",
          },
        },
      },
    },
  },
}
```

Restart the Gateway after changing plugin config:

```bash
openclaw gateway restart
```

Then verify the plugin is loaded:

```bash
openclaw plugins list
```

## Provider-backed embeddings

`memory-milvus` uses the same memory embedding provider adapters as
`memory-core`. Set `embedding.provider` and omit `embedding.apiKey` to use the
provider's configured auth profile, environment variable, or
`models.providers.<provider>.apiKey`.

```json5
{
  plugins: {
    slots: {
      memory: "memory-milvus",
    },
    entries: {
      "memory-milvus": {
        enabled: true,
        config: {
          milvus: { host: "localhost", port: 19530 },
          embedding: {
            provider: "openai",
            model: "text-embedding-3-small",
          },
        },
      },
    },
  },
}
```

Set `embedding.dimensions` for models whose vector size is not built in (the
plugin defaults to 1024 for `text-embedding-v3`):

```json5
{
  plugins: {
    entries: {
      "memory-milvus": {
        config: {
          embedding: {
            provider: "alibaba",
            model: "text-embedding-v4",
            dimensions: 2048,
          },
        },
      },
    },
  },
}
```

## Search

`memory_search` runs a hybrid vector + keyword pipeline against Milvus:

1. **Vector ANN** via Milvus HNSW index (`anns_field: "embedding"`)
2. **Full-text** via BM25 sparse vector (`hybridSearch + WeightedRanker`) or
   scalar filter + client-side TF-IDF as fallback
3. **Fusion**: `vectorWeight × vectorScore + textWeight × textScore` (default 0.7/0.3)
4. **MMR re-ranking** (λ=0.7) to reduce redundancy
5. **Temporal decay** (30-day half-life) to deprioritize old memories

Search weights and BM25 can be adjusted in config:

```json5
{
  plugins: {
    entries: {
      "memory-milvus": {
        config: {
          search: {
            useBM25: true,
            vectorWeight: 0.7,
            textWeight: 0.3,
          },
        },
      },
    },
  },
}
```

### BM25 native full-text search (Milvus ≥ 2.4)

When a BM25 Function is created on the Milvus server, the plugin can use
native hybrid search instead of the client-side TF-IDF fallback. The BM25
Function is not created automatically — create it via the RESTful API or
pymilvus.

**Via RESTful API** (replace `<host>`, `<port>`, `<collection>`):

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

**Via pymilvus**:

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

After creating the Function, enable BM25 in the plugin config with
`search.useBM25: true`. If the Function is not available, the plugin falls
back to separate ANN + client-side TF-IDF automatically.

## Memory promotion (dreaming)

`memory-milvus` supports automated short-term-to-long-term memory promotion
via the OpenClaw dreaming pipeline. The pipeline runs three phases:

- **Light**: scans recent short-term memories for candidates
- **REM**: groups candidates by session and merges related memories via an LLM
- **Deep**: scores candidates by recall frequency and recency, then promotes
  those above threshold to long-term memory

Configure the dreaming schedule:

```json5
{
  plugins: {
    entries: {
      "memory-milvus": {
        config: {
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

| Setting                | Default        | Description |
|------------------------|----------------|-------------|
| `dreaming.enabled`     | `false`        | Enable scheduled dreaming |
| `dreaming.cron`        | `"0 3 * * *"`  | Cron expression for sweep cadence |
| `dreaming.limit`       | `5`            | Max candidates to promote per sweep |
| `dreaming.minScore`    | `0.3`          | Minimum composite score (0-1) |
| `dreaming.minRecallCount` | `2`          | Minimum recall count for consideration |
| `dreaming.recencyHalfLifeDays` | `30`  | Half-life (days) for recency weight |

Run a manual dreaming sweep:

```
/milvus-dreaming run
```

## Citation control

`memory_search` honors `cfg.memory.citations` (`"on"` | `"off"` | `"auto"`)
to append source citations to search result snippets. Auto mode enables
citations for direct chats and disables them for group/channel contexts.

```json5
{
  memory: {
    citations: "auto",
  },
  plugins: {
    slots: {
      memory: "memory-milvus",
    },
    entries: {
      "memory-milvus": {
        enabled: true,
        config: {
          milvus: { host: "localhost", port: 19530 },
          embedding: { provider: "alibaba", model: "text-embedding-v3" },
        },
      },
    },
  },
}
```

## Multi-corpus search

`memory_search` supports the same `corpus` parameter as `memory-core`:

| `corpus`     | Behavior |
|--------------|----------|
| `memory`     | Searches the main Milvus memory store (default) |
| `sessions`   | Searches Milvus with session key filtering |
| `wiki`       | Searches registered wiki supplements only |
| `all`        | Merges Milvus hits with wiki supplement hits, sorted by score |

## Agent isolation

All agents share a single Milvus collection. Agent isolation is enforced at
the query level — every `search`, `get`, and `recordRecall` call automatically
filters by `agent_id`. This produces the same isolation effect as the
per-agent workspace directories used by `memory-core`, without the storage
overhead of separate collections.

## Commands

### Memory migration

The plugin registers a `memory-migrate` CLI command for bidirectional
migration between Markdown files and Milvus:

```bash
# Forward: Markdown → Milvus
openclaw memory-migrate ./my-memory-dir

# Reverse: Milvus → Markdown (exports to memory-export/<timestamp>/)
openclaw memory-migrate ./my-memory-dir --reverse

# Dry-run: preview without writing
openclaw memory-migrate ./my-memory-dir --dry-run

# Reverse with type filter
openclaw memory-migrate ./my-memory-dir --reverse --type=short_term
```

Forward migration scans `MEMORY.md` and `memory/YYYY-MM-DD.md`, chunks by
heading, embeds via the configured provider, and inserts into Milvus. Reverse
migration exports to a timestamped output directory and never overwrites the
original Markdown files.

### Dreaming

```
/milvus-dreaming run     Run a manual dreaming sweep
/milvus-dreaming status  Show dreaming pipeline status
```

## Storage

The plugin stores memory entries in a single Milvus collection (default name
`openclaw_memory`). The collection is auto-created on first startup with a
fixed schema including:

- Dense vector index (HNSW, configurable `M` / `efConstruction` / `metric_type`)
- Optional sparse vector index for BM25 (requires manual Function creation)
- Scalar fields for `agent_id`, `session_key`, `memory_type`, timestamps,
  recall counters, provenance metadata, and a SHA-256 content hash for dedup

Collection lifecycle is managed eagerly at plugin init — existing collections
are detected and re-used; missing indexes are created; the collection is loaded
into memory if not already.

### Degraded mode

If the Milvus server is unreachable at startup, the plugin initializes in
"degraded" mode:

- Write operations fall back to local ndjson files (`memory/.milvus-fallback/`)
- Search returns empty results
- The plugin logs a warning and continues — the Gateway is not blocked

When Milvus becomes reachable again, accumulated fallback entries are
automatically replayed on the next write.

## Runtime dependencies

`memory-milvus` depends on `@zilliz/milvus2-sdk-node` ^2.5.0. The plugin
connects to a Milvus server over gRPC — the server is not bundled or managed
by OpenClaw. Start a standalone Milvus instance via Docker (see Quick start)
or point the plugin at an existing Milvus deployment.

The plugin does not depend on `memory-core` at runtime — it self-registers
the built-in memory embedding providers (`auto` / `local` / `openai`).

## Switching backends

`memory-milvus` and `memory-core` are mutually exclusive via the memory slot.
Switch between them by changing a single config key and restarting the Gateway:

```json5
// Memory (Milvus)
{ plugins: { slots: { memory: "memory-milvus" } } }

// Memory (Core) — default file-based backend
{ plugins: { slots: { memory: "memory-core" } } }

// No active memory plugin
{ plugins: { slots: { memory: "none" } } }
```

Milvus data and Markdown files are stored independently — switching backends
does not delete or migrate data in either direction. Use the
`memory-migrate` command to move existing Markdown memories into Milvus.

## Troubleshooting

### Plugin loads but no memories appear

Check that `plugins.slots.memory` points at `"memory-milvus"`, then verify
the Milvus connection:

```bash
openclaw plugins list
```

If the plugin log shows "degraded mode", the Milvus server is unreachable.
Start a local Milvus instance or check the `milvus.host` / `milvus.port`
config values.

### Embedding provider unavailable

The plugin uses `embedding.provider: "auto"` by default. If you see an
"Unknown memory embedding provider" error, ensure the corresponding provider
plugin is enabled and configured. Common options:

- `"openai"` — requires an OpenAI API key in the auth profile or `OPENAI_API_KEY`
- `"alibaba"` — requires Alibaba Cloud credentials
- `"auto"` — tries available built-in providers in order

### Collection bootstrap fails

If the plugin cannot create the Milvus collection, it falls back to degraded
mode. Common causes:

- Milvus server is not running or not reachable
- Authentication is required but not configured
- The collection name conflicts with an existing incompatible collection

Check the Gateway logs for the specific error:

```bash
openclaw gateway logs | grep memory-milvus
```

### Dreaming sweep runs but promotes zero candidates

This is expected when no short-term memories have been recalled enough times.
The dreaming pipeline requires:

- `memory_search` hits to accumulate `recall_count` on entries
- `recall_count >= dreaming.minRecallCount` (default 2)
- `composite score >= dreaming.minScore` (default 0.3)

Run a few `memory_search` queries to build up recall counts before the next
sweep, or lower `dreaming.minRecallCount` / `dreaming.minScore` for faster
promotion.

### BM25 hybrid search not working

The BM25 path is opt-in and requires a BM25 Function on the Milvus server
(see BM25 setup above). Without the Function, `search.useBM25: true` will
log a warning and fall back to the default ANN + TF-IDF path.

Verify the Function exists:

```bash
curl "http://<host>:<port>/v2/vectordb/functions/list" \
  -d '{"collectionName": "<collection>"}'
```

## Related

- [Memory overview](/concepts/memory)
- [Active memory](/concepts/active-memory)
- [Memory search](/concepts/memory-search)
- [Memory Core](/plugins/memory-core)
- [Memory Wiki](/plugins/memory-wiki)
