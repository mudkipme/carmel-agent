# Knowledge

Knowledge lets an agent search and cite your reference documents. You register folders of Markdown files, Carmel Agent indexes them, and the agent uses `knowledge_search` and `knowledge_read` to find passages and quote them with citations.

Knowledge is agent-wide: everyone who can use a shared agent can search its Knowledge, subject to the agent's read permission. It is separate from [Home memory](/guide/home-and-memory), which is private to each person. Knowledge never indexes conversations or memory.

## Before you start

- The agent needs the **Read files** permission. Run commands is not required.
- Knowledge runs in a runner container, so the server needs the runner image and a container socket. See [Sandbox and runner](/self-hosting/sandbox).
- Semantic search needs model weights. Downloading them requires the agent's **Web access** permission once; after that, search runs offline.

## Set up Knowledge

1. Open **Agent Settings → Knowledge** (or **Knowledge settings** on the agent's Knowledge page) and turn Knowledge on. Only the agent's owner can change these settings.
2. **Add a source**: a folder inside the agent's working folder or one of its mounts. Relative paths are relative to the working folder. Describe what the collection is useful for, so the agent knows when to search it.
3. Click **Refresh index** to build the keyword index.
4. For semantic search, click **Build embeddings**. For the most thorough search mode, also click **Prepare deep search**, which downloads query-expansion and reranking models.

Only Markdown files are indexed. Hidden folders, build output, dependency folders, and symlinks are skipped.

Once set up, the index maintains itself: Carmel Agent checks for changes every 30 seconds and reconciles sources about every five minutes. Background maintenance never downloads models or reads conversations.

## Searching

Open the agent's **Knowledge** page to search your sources yourself. In conversations, the agent sees a short catalog of the sources (up to 20 sources / 6,000 characters) and decides when to search. The bundled `knowledge-search` skill teaches it the search modes, how to verify passages, and how to cite them.

| Tool               | What it does                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge_search` | Keyword, semantic, or deep hybrid search across registered documents, with bounded excerpts and citations. Semantic failures fall back to keyword search. |
| `knowledge_read`   | Read a range of lines from a current source document, with its revision hash and citation.                                                                |

Search results are always checked against the current file: Carmel Agent reopens each document and compares its hash with the indexed revision before returning text. Stale, deleted, disconnected, or no-longer-permitted documents are left out, so an old index never serves removed content.

## Acceleration

Each agent can choose **Automatic**, **CPU**, **Vulkan**, or **CUDA** for embeddings. GPU options need the devices exposed to runners through CDI (see [GPU passthrough](/self-hosting/sandbox#gpu-passthrough)). An explicit GPU choice fails if the model cannot offload any layers; **Automatic** may fall back to CPU. The Knowledge page reports the backend and devices actually in use.

## Long-running jobs

Indexing a large corpus can take a while. Indexing has a 15-minute deadline and embedding a 6-hour deadline by default; administrators can raise both.

If a job times out, completed work is kept. **Refresh index** resumes indexing incrementally, and **Build embeddings** continues with the pending documents.

## Using an existing qmd collection

If you already keep Markdown notes indexed with [qmd](https://github.com/tobi/qmd) elsewhere, register the same folders as sources. Carmel Agent builds and owns its own index and cache; it never imports or changes your existing index. To use the same embedding model, point the server's `CARMEL_KNOWLEDGE_EMBED_MODEL` at that GGUF file.

## qmd in the terminal

The runner image includes the `qmd` CLI, so agents and the web terminal can run it directly. Shell `qmd` keeps its own collections, configuration, and index, separate from Carmel Agent's managed Knowledge.

Carmel Agent sets helpful defaults for shell use:

- `QMD_EMBED_MODEL` follows the server's `CARMEL_KNOWLEDGE_EMBED_MODEL`. A local GGUF file is mounted read-only under `/models/local/`.
- `QMD_LLAMA_GPU` and `NODE_LLAMA_CPP_GPU` follow the agent's acceleration setting.
- Shared model weights are mounted read-only at `/home/agent/.cache/qmd/models`, qmd's default model cache.

These are defaults, not overrides: the working folder's `.env`, shell exports, and qmd's own YAML configuration take precedence. Unlike the built-in tools, the CLI may try to download missing models — prepare them with **Build embeddings** or **Prepare deep search** first if you need to work offline. `qmd vsearch` also needs the query-expansion model, and `qmd query` additionally needs reranking weights.

Bash resource limits apply to shell `qmd`, so allocate enough memory for model-backed commands. After changing the global model or the agent's acceleration, reopen any attached terminals.

## Administration

Server-wide settings — the embedding model, the knowledge runner image, memory and CPU limits, deadlines, and GPU devices — are listed in [Environment variables](/reference/environment-variables#knowledge).

The embedding model is shared by every agent. It defaults to `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` and can be any `hf:` URI or an absolute path to a GGUF file. Knowledge settings show it read-only. After changing it, restart the server and rebuild embeddings.

### Storage

Per-agent state lives under `CARMEL_AGENT_DATA_DIR/knowledge/<sha256-agent-id>/`:

- `index/` — derived qmd SQLite databases and vectors.
- `cache/` — per-worker runtime caches, including driver caches.
- `home/`, `config/` — worker-local tool state.

Downloaded models are stored once under `CARMEL_AGENT_DATA_DIR/knowledge-models/` and shared by all agents. Sharing the files avoids duplicate downloads, but each active runner still loads its own copy into RAM or VRAM.

Indexes and models can always be rebuilt or downloaded again. Deleting an agent removes its knowledge state; disconnecting a source purges its derived index but never touches the source documents.

### Isolation

The app server never runs qmd, vector extensions, or model inference itself. Each agent's index is built and searched in a dedicated runner container labeled `carmel.knowledge=1`, which receives only the registered source folders (read-only), an optional local model file (read-only), the shared model cache, and that agent's knowledge state. It gets no container socket, provider keys, agent secrets, or other agents' folders. Its root filesystem is read-only, capabilities are dropped, and it runs as the configured host user. Model downloads use a temporary network-enabled worker; search uses an offline one.

Operations are serialized per agent, and model-backed work is serialized across all agents. Idle workers are removed after about five minutes.
