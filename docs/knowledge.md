# Knowledge and memory

Every agent has a Knowledge page for searching registered Markdown directories and managing saved memories. Memory belongs to the agent: all users of a shared agent see and use the same memories. Contributor IDs record who last saved a memory; they do not partition access. Keep person-specific statements explicit, for example “Alice prefers a monthly budget review.”

Conversations retain their existing visibility. This release does not index sessions, automatically capture memories, inject startup memory, or run Dream-style consolidation. It implements managed search and explicit memory writes. Existing workspace wikis such as LifeOS remain source directories; automatic writes into their pages are not implemented.

Each run receives knowledge and shared-memory instructions in its system prompt when knowledge is enabled and the read tools are available. This also applies in Codemode. The prompt tells the agent when to recall prior facts, verify passages, cite sources, disclose retrieval limitations, and save or forget explicitly requested memories. It reflects the current write/edit permissions and explains that agent memory is shared while session visibility remains separate.

A compact catalog lists source IDs, names, and shortened descriptions, plus the built-in `memories` source. Directory metadata is capped at 6,000 characters and 20 entries; omitted sources remain searchable without a source filter. The catalog refreshes on each run and treats metadata as untrusted reference data. Building it reads only database metadata: it does not load memory contents, scan directories, start qmd, or call a model. Recall is agent-directed through tools, not automatic retrieval on every message.

## Setup

1. Pull the runner image containing `@tobilu/qmd@2.8.3`, and configure the existing Podman or Docker socket and non-root runner identity.
2. Open **Agent Settings → Knowledge** as the agent's owner and turn knowledge on. The **Knowledge settings** button on the Knowledge page opens the same settings section. The agent needs read permission. General bash permission is not required.
3. Add a source directory inside the agent workspace or an existing configured mount. Relative paths are relative to the workspace; runner mount paths are also accepted. Only Markdown files are indexed. Hidden directories, build output, dependency directories, and symlinks are excluded by the qmd indexer.
4. Click **Refresh index** for keyword search. Background maintenance checks dirty agents every 30 seconds and reconciles source changes about every five minutes. It performs no model work or conversation ingestion.
5. For semantic search, configure the global embedding model on the server and click **Build embeddings**. **Prepare deep search** also prepares qmd's default query-expansion and reranking models. Model downloads require the agent's network permission. Retrieval and automatic indexing always run offline and report missing models without waiting for a download.

Set `CARMEL_KNOWLEDGE_EMBED_MODEL` to an `hf:` URI or an absolute GGUF file path on the server. The default is `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`. This is an operator setting shared by every agent; Knowledge settings display it read-only. Legacy per-agent model choices are ignored. Local files are mounted read-only with their original filename so model-family-specific formatting is preserved; they do not need to be added to each agent’s mounts. For a containerized server, make the file visible at the same absolute host path, or place it under the mapped application data directory.

Restart after changing the environment setting. Model/path/file-metadata changes select a new index generation; background maintenance refreshes keyword indexes, and the owner rebuilds embeddings. Existing generations remain until a source is disconnected, a memory is forgotten, or the agent is deleted.

For LifeOS, register its existing wiki and vault directories without importing or changing its `.cache/qmd` index. Set the global environment variable to its existing `Qwen3-Embedding-0.6B-Q8_0.gguf` file and select **Vulkan** for the agent. This model choice then applies to all agents. Carmel owns a separate index and cache. No LifeOS migration is automatic.

## Retrieval and memory tools

| Tool               | Behavior                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `knowledge_search` | Fast keyword search, semantic vector search, or deep hybrid retrieval. Returns bounded excerpts and links to current source documents. Semantic failures fall back to keyword search with a visible warning. |
| `knowledge_read`   | Reads a bounded line range of a current source document, with a revision hash and citation.                                                                                                                  |
| `memory_save`      | Creates a managed note when the user asks to remember something. Updates require its ID and expected revision.                                                                                               |
| `memory_forget`    | Removes a saved memory for all users of the agent, using an expected revision.                                                                                                                               |

Read tools require agent visibility and read permission. Creating memories requires write permission; editing or forgetting requires edit permission. Settings, source registration, and manual maintenance are owner-only. Permissions are rechecked on every call. The explicit retention rule is part of the agent tool instruction, not a classifier that verifies intent on the server.

Saved notes are canonical Markdown. Database metadata tracks contributor, revision, timestamps, and pending write intent. An interrupted write is replayed before another mutation or index refresh. Concurrent edits fail with a conflict so the user can reload. There is no revision-history/undo UI yet. Use the UI or memory tools for mutations; direct edits to managed note files do not update their metadata.

Search results are untrusted evidence. The app reopens each document under the agent's current allowed roots and checks its SHA-256 against the indexed revision before returning text. Stale, disconnected, deleted, or unauthorized references are omitted. This prevents an old qmd cache from serving removed content. Disconnection and forgetting also stop the worker and purge all derived index generations; canonical source documents remain. Forgetting is not secure erasure from SQLite free pages, backups, or existing conversations.

## Runner boundary and storage

The app server authorizes requests, manages metadata and Markdown, and talks to the container runtime. It never imports or executes qmd, SQLite vector extensions, or model inference. The adapter reads a fixed worker entrypoint as text and executes it with Node **inside a dedicated runner container**. If the runner is unavailable, search fails with an actionable error; there is no host-process fallback.

Workers use the existing runner image, labeled `carmel.knowledge=1`. They receive only registered source directories (read-only), an optional global local-model file (read-only), a shared model cache, and their agent's knowledge state. They receive no container socket, provider keys, agent secrets, or unrelated agent directories. The root filesystem is read-only, capabilities are dropped, and commands run as the configured host UID/GID. Downloads temporarily use a separately configured network-enabled worker; subsequent retrieval replaces it with an offline worker.

State lives under `CARMEL_AGENT_DATA_DIR/knowledge/<sha256-agent-id>/`:

- `notes/`: canonical managed memory Markdown.
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

| Server setting                 | Default                                                |
| ------------------------------ | ------------------------------------------------------ |
| `CARMEL_KNOWLEDGE_EMBED_MODEL` | Pinned embeddinggemma-300M-Q8_0 HF URI                 |
| `CARMEL_KNOWLEDGE_IMAGE`       | `CARMEL_BASH_IMAGE`, then published runner             |
| `CARMEL_KNOWLEDGE_MEMORY_MB`   | `4096`                                                 |
| `CARMEL_KNOWLEDGE_CPUS`        | `2`                                                    |
| `CARMEL_KNOWLEDGE_GPU`         | Inherits `CARMEL_BASH_GPU`; empty disables passthrough |

Set these in the server environment. Compose passes through `CARMEL_KNOWLEDGE_EMBED_MODEL` from its `.env`; add other overrides under `environment:` as needed.

GPU choices are Automatic, CPU, Vulkan, and CUDA. CDI must expose the chosen devices to the runner. The worker checks backend availability and actual embedding-model GPU layers. Explicit GPU selection fails if no layers offload; Automatic may use CPU. The Knowledge page reports the effective backend and device names. Vulkan with Qwen3 has been exercised on an RTX 3060; CUDA is supported as a configuration choice but has not been validated in this change.

Operations are serialized per agent. One global queue serializes model-backed queries and embedding jobs across knowledge workers. This queue does not coordinate unrelated LifeOS/bash processes using the same GPU. Indexing is bounded by container resources and a two-minute timeout; retrieval has a one-minute timeout; embedding/model preparation has a fifteen-minute timeout. Large corpora may require future resumable scheduling. Document reads are capped at 2 MiB, and excerpts/tool responses are bounded. Models remain cached, and disk quotas are not yet implemented.

The pinned qmd adapter explicitly shares the SDK store's LlamaCpp instance with qmd 2.8.3's singleton tokenizer. Without this, token-based chunking can load the default embedding model alongside a configured model. Its Node launcher also avoids inheriting `--input-type=module` into native-binding probes. Treat upgrades to qmd as adapter changes and rerun the integration test.

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

The sandbox test uses temporary files, an in-memory application database, and its own runners. It verifies index persistence/deletion, shared retrieval, current-source hash checks, missing-model fallback, and forgetting. With a local model, it also verifies embeddings and semantic recall. It does not touch deployed LifeOS indexes or start the production scheduler.
