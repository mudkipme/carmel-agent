# Knowledge

Knowledge is the agent-wide reference-document feature. Register Markdown
directories in the agent's workspace or mounts, then use `knowledge_search` and
`knowledge_read` to find and verify passages. All users who can use a shared
agent can use its registered Knowledge, subject to the agent's read permission.

[Memory](home-memory.md) belongs only to private Home conversations. Knowledge
contains no saved-memory collection and has no memory-writing tools. Ordinary
sessions retain Knowledge access without receiving anyone's Home notes.

Each eligible run receives a bounded source catalog and a short Knowledge
reminder. The bundled `knowledge-search` skill describes search modes,
verification, and citations. Loading the skill rechecks the agent's current
settings, permissions, and visibility; bash and network access are unnecessary.
The catalog reads metadata only, with at most 20 sources / 6,000 characters.

## Setup

1. Pull the runner image containing `@tobilu/qmd@2.8.3`, and configure the existing Podman or Docker socket and non-root runner identity.
2. Open **Agent Settings → Knowledge** as the agent's owner and turn knowledge on. The **Knowledge settings** button on the Knowledge page opens the same settings section. The agent needs read permission. General bash permission is not required.
3. Add a source directory inside the agent workspace or an existing configured mount. Relative paths are relative to the workspace; runner mount paths are also accepted. Only Markdown files are indexed. Hidden directories, build output, dependency directories, and symlinks are excluded by the qmd indexer.
4. Click **Refresh index** for keyword search. Background maintenance checks dirty agents every 30 seconds and reconciles source changes about every five minutes. It performs no model work or conversation ingestion.
5. For semantic search, configure the global embedding model on the server and click **Build embeddings**. **Prepare deep search** also prepares qmd's default query-expansion and reranking models. Model downloads require the agent's network permission. Retrieval and automatic indexing always run offline and report missing models without waiting for a download.

Set `CARMEL_KNOWLEDGE_EMBED_MODEL` to an `hf:` URI or an absolute GGUF file path on the server. The default is `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`. This is an operator setting shared by every agent; Knowledge settings display it read-only. Legacy per-agent model choices are ignored. Local files are mounted read-only with their original filename so model-family-specific formatting is preserved; they do not need to be added to each agent’s mounts. For a containerized server, make the file visible at the same absolute host path, or place it under the mapped application data directory.

Restart after changing the environment setting. Model/path/file-metadata changes select a new index generation; background maintenance refreshes keyword indexes, and the owner rebuilds embeddings. Existing generations remain until a source is disconnected, the agent is deleted.

For LifeOS, register its existing wiki and vault directories without importing or changing its `.cache/qmd` index. Set the global environment variable to its existing `Qwen3-Embedding-0.6B-Q8_0.gguf` file and select **Vulkan** for the agent. This model choice then applies to all agents. Carmel owns a separate index and cache. No LifeOS migration is automatic.

## Retrieval tools

| Tool               | Behavior                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge_search` | Keyword, semantic, or deep hybrid retrieval of registered documents, with bounded excerpts and citations. Semantic failures fall back to keyword search with a warning. |
| `knowledge_read`   | Read a bounded line range of a current source document, with its revision hash and citation.                                                                            |

Agent visibility and read permission are checked on every call. Settings, source
registration, and manual maintenance are owner-only. Knowledge never indexes
conversations or private Home notes.

Search results are untrusted evidence. The app reopens each document under the agent's current allowed roots and checks its SHA-256 against the indexed revision before returning text. Stale, disconnected, deleted, or unauthorized references are omitted. This prevents an old qmd cache from serving removed content. Disconnecting a source stops the worker and purges derived index generations; canonical source documents remain.

## Runner boundary and storage

The app server authorizes requests, manages source metadata, and talks to the container runtime. It never imports or executes qmd, SQLite vector extensions, or model inference. The adapter reads a fixed worker entrypoint as text and executes it with Node **inside a dedicated runner container**. If the runner is unavailable, search fails with an actionable error; there is no host-process fallback.

Workers use the existing runner image, labeled `carmel.knowledge=1`. They receive only registered source directories (read-only), an optional global local-model file (read-only), a shared model cache, and their agent's knowledge state. They receive no container socket, provider keys, agent secrets, or unrelated agent directories. The root filesystem is read-only, capabilities are dropped, and commands run as the configured host UID/GID. Downloads temporarily use a separately configured network-enabled worker; subsequent retrieval replaces it with an offline worker.

State lives under `CARMEL_AGENT_DATA_DIR/knowledge/<sha256-agent-id>/`:

- `index/`: derived qmd SQLite databases and vectors.
- `cache/`: per-worker runtime caches, including driver caches.
- `home/`, `config/`: worker-local tool state.

Downloaded embedding, query-expansion, and reranking weights live once under `CARMEL_AGENT_DATA_DIR/knowledge-models/`, outside all agent directories. Retrieval mounts this shared cache read-only. Explicit model-preparation jobs may write to it when the agent has network permission, and these operations are serialized across agents. Deleting an agent keeps these shared files. Previous per-agent model caches are not moved or deleted automatically.

Sharing model files avoids duplicate downloads and disk copies. It does **not** share a loaded inference instance: each active runner has its own RAM/VRAM allocation. A common inference service would be a separate change.

## qmd in bash and terminals

Shell qmd uses the bash runner and keeps its own collections, configuration, and index. It does not access Carmel's managed index or saved-memory storage. Both runner images pin qmd 2.8.3 by default.

Carmel supplies `QMD_EMBED_MODEL` from the global `CARMEL_KNOWLEDGE_EMBED_MODEL`, mapping a local GGUF to its read-only `/models/local/` mount. It also supplies `QMD_LLAMA_GPU` and `NODE_LLAMA_CPP_GPU` from the agent's acceleration setting (CPU becomes `false`; an unconfigured agent defaults to `auto`). These defaults apply even when managed knowledge is disabled. Bash GPU device access and resource limits still come from `CARMEL_BASH_GPU`, `CARMEL_BASH_MEMORY_MB`, and `CARMEL_BASH_CPUS`; allocate enough memory for model-backed shell commands.

The shared weights directory is mounted read-only at `/home/agent/.cache/qmd/models`, qmd's default CLI model-cache path. Download missing shared weights through **Build embeddings** or **Prepare deep search** in Knowledge. Shell commands cannot modify the shared cache. Existing files underneath that mount are retained, not migrated or deleted.

Native qmd 2.8.3 `vsearch` also uses query expansion, so it needs the generation model prepared; `query` additionally needs reranking weights. Unlike the built-in tools, the CLI may attempt downloads or wait on retries when those models are missing. Prepare them before offline use.

These are defaults, not forced overrides. Workspace `.env`, explicit shell exports, and qmd YAML model settings can override them; qmd's YAML model selection takes precedence over `QMD_EMBED_MODEL` and may retain a model selected on an earlier invocation. A custom `HOME` or `XDG_CACHE_HOME` selects its own cache. Carmel deliberately does not set `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `QMD_CONFIG_DIR`, or `INDEX_PATH`, so LifeOS's wrapper and other custom indexes retain their existing locations. Custom cache users can reference the shared weights through `/home/agent/.cache/qmd/models` using an explicit model path.

Changed global model mounts or agent acceleration settings recreate the bash runner on its next use. Existing attached terminals should be reopened after changing those settings. CLI operations use their own qmd process and do not participate in Carmel's knowledge-worker GPU queue or canonical-source verification; use the built-in tools for managed memories and verified citations.

Back up the application database together with `notes/`. Indexes can be rebuilt and models downloaded again. Deleting an agent removes its knowledge state. Normal service shutdown cancels maintenance and removes workers; startup reaps workers left by the previous process. Idle workers are removed after roughly five minutes.

| Server setting                       | Default                                                |
| ------------------------------------ | ------------------------------------------------------ |
| `CARMEL_KNOWLEDGE_EMBED_MODEL`       | Pinned embeddinggemma-300M-Q8_0 HF URI                 |
| `CARMEL_KNOWLEDGE_IMAGE`             | `CARMEL_BASH_IMAGE`, then published runner             |
| `CARMEL_KNOWLEDGE_MEMORY_MB`         | `4096`                                                 |
| `CARMEL_KNOWLEDGE_CPUS`              | `2`                                                    |
| `CARMEL_KNOWLEDGE_UPDATE_TIMEOUT_MS` | `900000` (15 minutes per index refresh)                |
| `CARMEL_KNOWLEDGE_EMBED_TIMEOUT_MS`  | `21600000` (6 hours per embedding job)                 |
| `CARMEL_KNOWLEDGE_GPU`               | Inherits `CARMEL_BASH_GPU`; empty disables passthrough |

Set these in the server environment. Compose passes through `CARMEL_KNOWLEDGE_EMBED_MODEL` from its `.env`; add other overrides under `environment:` as needed.

GPU choices are Automatic, CPU, Vulkan, and CUDA. CDI must expose the chosen devices to the runner. The worker checks backend availability and actual embedding-model GPU layers. Explicit GPU selection fails if no layers offload; Automatic may use CPU. The Knowledge page reports the effective backend and device names. Vulkan with Qwen3 has been exercised on an RTX 3060; CUDA is supported as a configuration choice but has not been validated in this change.

Operations are serialized per agent. One global queue serializes model-backed queries and embedding jobs across knowledge workers. This queue does not coordinate unrelated LifeOS/bash processes using the same GPU. Indexing is bounded by container resources and a fifteen-minute timeout, configurable through `CARMEL_KNOWLEDGE_UPDATE_TIMEOUT_MS` (a positive integer in milliseconds, at most `2147483647`; invalid values use the default). Embedding has a six-hour timeout, including model loading, configurable through `CARMEL_KNOWLEDGE_EMBED_TIMEOUT_MS` with the same integer bounds. Retrieval retains its one-minute timeout; deep-search model preparation retains its fifteen-minute timeout. If indexing times out, completed document writes remain in the derived index: **Refresh index** rescans the source and resumes incrementally. If embedding times out, completed embeddings are retained: **Build embeddings** retries the pending documents without forcing a rebuild. Incomplete documents may be reprocessed. Very large corpora can require longer deadlines; these defaults are limits, not completion-time estimates. Document reads are capped at 2 MiB, and excerpts/tool responses are bounded. Models remain cached, and disk quotas are not yet implemented.

The pinned qmd adapter explicitly shares the SDK store's LlamaCpp instance with qmd 2.8.3's singleton tokenizer. Without this, token-based chunking can load the default embedding model alongside a configured model. The adapter calls qmd’s internal `generateEmbeddings` with Carmel’s embedding deadline because qmd 2.8.3’s SDK `embed()` does not forward `maxDurationMs` and otherwise stops its model session after 30 minutes. Its Node launcher also avoids inheriting `--input-type=module` into native-binding probes. Treat upgrades to qmd as adapter changes and rerun the integration test.

## Verification

```sh
pnpm check
pnpm test:browser
pnpm --filter @carmel-agent/server test:knowledge-sandbox
pnpm --filter @carmel-agent/server test:knowledge-shell-sandbox

# Optional local-model embedding test: CPU when CARMEL_TEST_GPU is omitted.
CARMEL_TEST_GPU=nvidia.com/gpu=all \
CARMEL_TEST_EMBED_MODEL=/absolute/path/Qwen3-Embedding-0.6B-Q8_0.gguf \
pnpm --filter @carmel-agent/server test:knowledge-sandbox
```

The sandbox test uses temporary files, an in-memory application database, and its own runners. It verifies index persistence/deletion, shared document retrieval, current-source hash checks, missing-model fallback, private Home indexing, and forgetting. With a local model, it also verifies embeddings and semantic recall. It does not touch deployed LifeOS indexes or start the production scheduler.
