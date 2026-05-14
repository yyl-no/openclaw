# Memory (Milvus)

Milvus-backed memory plugin providing vector ANN search for OpenClaw memory.

## Current capabilities

| Capability | Status |
|---|---|
| `memory_write` tool (vector insert with fallback) | ✅ |
| `memory_search` tool (ANN + keyword hybrid search) | ✅ |
| `memory_get` tool (PK lookup) | ✅ |
| Collection auto-bootstrap (create + load) | ✅ |
| Degraded mode (Milvus unreachable → ndjson fallback) | ✅ |
| `recordRecall` (recall-count tracking + upsert) | ✅ |
| Dreaming promotion `rankPromotionCandidates` + `applyPromotions` | ✅ |
| Source label / memory type validation | ✅ |
| Dedup (SHA-256 content hash) + update + soft-delete (archive) | ✅ |
| AI flush turn prompt integration | ✅ |
| `memory migrate` CLI (Markdown ↔ Milvus bidirectional) | ✅ |
| BM25 native hybrid search (Milvus ≥ 2.4, opt-in) | ✅ |

## Migration

The plugin includes a bidirectional migration CLI subcommand under `openclaw memory`.

```bash
# Forward: scan MEMORY.md + memory/*.md → chunk → embed → Milvus
openclaw memory migrate ./my-memory-dir

# Reverse: query Milvus → export to memory-export/<timestamp>/
openclaw memory migrate ./my-memory-dir --reverse

# Dry-run: preview without writing
openclaw memory migrate ./my-memory-dir --dry-run

# Reverse with type filter
openclaw memory migrate ./my-memory-dir --reverse --type=short_term
```

**Dedup**: SHA-256 in-batch dedup by `text + provenance_label`; cross-batch dedup via
Milvus `provenance_label` query. Reverse output goes to `memory-export/<timestamp>/`
(human-friendly) and never overwrites the original `memory/*.md`.

## BM25 Native Full-Text Search (Milvus ≥ 2.4)

When a BM25 Function is created on the Milvus server, the plugin can use
native hybrid search (`hybridSearch + WeightedRanker`) instead of the
client-side TF-IDF fallback.

### Server-side setup

Create the BM25 Function on your Milvus instance (requires Milvus ≥ 2.4).
This cannot be done via the Node.js SDK — use the RESTful API or pymilvus.

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

After creating the Function, enable BM25 in the plugin config:

```json
{
  "config": {
    "milvus": { "host": "localhost", "port": 19530 },
    "search": { "useBM25": true, "vectorWeight": 0.7, "textWeight": 0.3 }
  }
}
```

The plugin will then use a single `hybridSearch` call with both the
dense embedding and sparse BM25 fields, combined via `WeightedRanker`.
If the BM25 Function is not available, it falls back to separate
ANN + client-side TF-IDF automatically.

### Fallback chain

```
search()
  ├─ useBM25=true? → searchBM25() via hybridSearch
  │   ├─ success → apply decay + MMR → done
  │   └─ null (Function missing / error) → legacy path
  └─ legacy: searchVector() + searchKeyword() → mergeResults → MMR
```

## Citation control

`memory_search` honors `cfg.memory.citations` ("on" | "off" | "auto") to
append source citations (`\n\nSource: ...`) to search result snippets.
Auto mode enables citations for direct chats, disables for group/channel
contexts. Citation decoration is shared with memory-core via the runtime-api barrel.

## Not yet available

| Capability | Target |
|---|---|
| 9-dim advanced recall signals | TBD |

## Enable

The `memory-milvus` plugin is mutually exclusive with `memory-core`.
Set `plugins.slots.memory` to activate it — all other `kind:"memory"`
plugins are automatically disabled.

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

**Switching back to `memory-core`**: change `plugins.slots.memory` to
`"memory-core"`. Your Milvus data and Markdown files are stored independently —
neither is lost when you switch.

**Startup verification**: after switching, the gateway startup log will show
`memory-milvus` among the loaded plugins. If the Milvus server is unreachable,
the plugin initializes in "degraded" mode (falls back to local ndjson files)
and logs a warning.

## Quick start (Docker)

Launch a local Milvus instance:

```bash
# Standalone mode with embedded etcd
docker run -d --name milvus-standalone \
  -p 19530:19530 -p 9091:9091 \
  milvusdb/milvus:v2.4.0 standalone
```

Configure the plugin in `openclaw.yaml`:

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

## Testing

### Unit tests (no Milvus required)

```bash
pnpm test extensions/memory-milvus
```

### Live tests (requires Milvus + embedding API key)

Live end-to-end tests are guarded behind `OPENCLAW_LIVE_TEST=1`, covering write → search → recordRecall → promotion pipelines.

```bash
# Start Milvus first (see Quick start above)
export OPENCLAW_LIVE_TEST=1
export OPENAI_API_KEY="sk-..."
pnpm test:live extensions/memory-milvus
```

## Architecture

The plugin registers a `MemoryPluginCapability` that is mutually exclusive with
`memory-core`. Switching backends only requires changing the `plugins.slots.memory`
entry — the AI tool chain (`memory_write`) remains consistent.

```
AI flush turn
  ↓ memory_write(text, label?)
  ↓ MilvusSearchManager.write()
  ↓ health check → embed → insert → vector stored
  ↓ on failure → ndjson fallback (zero data loss)
```

## References

- [Task 10 plan](../../refactor/1-plan.md)
- [Task 10 decisions](../../refactor/2-decisions.md)
- [Task 13](#) — Dreaming promotion (completed)
- [Task 14](#) — Markdown ↔ Milvus migration tool (completed)
- [Task 16](#) — Dedup / citation / multi-corpus
