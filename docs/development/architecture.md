# Architecture

An overview of how Carmel Agent runs agents, for contributors. Storage and recovery for conversations are covered in [Session storage](/development/session-storage).

## One process per data directory

The server assumes it is the only process using its data directory. Active runs and their replay buffers, session leases, update-socket revisions, and the per-connection SQLite triggers that publish state changes all live in memory, and every background worker in `packages/server/src/index.ts` polls the shared database on its own. New features should stay within that model.

## Storage

Carmel Agent uses one SQLite database for metadata and authentication, accessed through Drizzle, plus one Pi Durable SQLite file per session in the native storage directory. Session content is owned exclusively by Pi Durable.

Schema changes are generated Drizzle migrations under `packages/server/drizzle`, applied at startup before seeding or serving requests. See CONTRIBUTING.md for the migration workflow.

Runtime state under `data/`:

- the metadata database and Durable storage directory,
- environment workspaces (holding each agent's default folder) and persistent homes, under `environments/`, or under `agents/` for environments that predate shared environments,
- the Pi agent runtime directory,
- sandbox `/tmp` directories.

## Runs and live updates

The server runs Pi Durable with its native SQLite backend, stores conversation history, live progress, and execution checkpoints through Pi, and streams committed events to browsers over a shared WebSocket at `/api/updates`. Each Carmel Agent session has its own native storage and tool and credential registry.

Runs live on the server. Each event carries a sequence number, so a browser that reloads or reconnects resumes from where it left off.

Each browser shares one authenticated update connection across run subscriptions and state notifications. Run subscriptions are checked against session ownership. State notifications contain topic names and a process-local revision, never entity contents; clients reload affected resources through the authenticated HTTP API. Metadata writes and native subtask commits notify connected clients, including changes from background jobs. Origin checks, session revalidation, heartbeats, and a bounded outgoing buffer apply to the connection.

On reconnect, clients refresh subscribed state and resume run events after the last applied sequence. If the bounded run history has expired, the client loads a connection snapshot with committed messages, the current partial reply, pending tools, nested tool progress, and the cursor to continue from. Update delivery and run replay are owned by the single server process; a restart refreshes client state from storage.

## Runtime model

An agent stores its owner and sharing state, name and description, environment and working folder, system prompt, prompt templates, default model and thinking level, permissions, and MCP configuration.

An environment stores its owner, name, runner mounts, sandbox network setting, and secrets. The runner container, its `/workspace`, `/home/agent`, `/tmp`, the web terminal, and the shared browser all belong to the environment.

Tools are composed per run from the agent's permissions and the conversation kind (ordinary session, Home, task, subtask, scheduled run, collaboration receiver). Skills load only from `<working folder>/.agents/skills`; global skill discovery is disabled. Built-in skills are bundled under `packages/server/skills/` and loaded on demand with `load_builtin_skill`.

## Web terminal transport

The terminal is a WebSocket at `/api/terminal`, upgraded on the HTTP server below the REST app, which is why it is not in the OpenAPI contract. It authenticates with the session cookie and validates `Origin`, because a WebSocket handshake is not covered by CORS preflight.

Under the hood it is a hijacked `exec` against the container runtime's Docker-compatible API, with a TTY attached. The shell lives on the server: reloading reattaches and replays recent scrollback, and an unattached shell is killed after a two-minute grace period. While a terminal is attached, its container is exempt from the idle reaper.

## Shared browser

The browser transport is `/api/browser`, an authenticated WebSocket with origin, agent visibility, and control checks. The server connects through a Docker exec stdio bridge to the loopback-only agent-browser stream; no browser or CDP ports are published. Input, frames, and console traffic are not stored in transcripts; only explicit agent snapshots and tool output enter the conversation.

Control is an environment-wide, server-owned lease for one WebSocket connection. Takeover closes admission to new agent tool calls, including entire codemode batches, and waits for in-flight calls before accepting human input. Disconnecting drops the input lease while leaving automation paused; any authorized viewer can then take control. The paused state and assistance reason are persisted outside the agent's mounted directories. A server restart preserves the pause, but active runs are interrupted under the normal lifecycle.

`request_browser_help` waits without a provider call or the idle-run timeout and returns a fresh snapshot after the human resumes. Stale tool calls queued across a handoff are not executed. Foreground tool calls participate in this coordination; background automation and commands typed into the terminal do not.

Frames use acknowledgement pacing with a 15 FPS cap; hidden tabs stop acknowledging until visible. Open viewers and paused handoffs hold the runner against idle reclamation, and Carmel Agent disables agent-browser's own idle timer.

Chromium's `SingletonLock`, `SingletonCookie`, and `SingletonSocket` links identify a browser process in one container and must not carry over to a replacement. Carmel Agent removes them inside each fresh sandbox before exposing it to tools, leaving cookies and other profile files intact. Startup waits for old managed containers to be removed; an unconfirmed removal blocks replacement rather than risking two browsers writing one profile. A container init process reaps orphaned browser processes.

The runner pins agent-browser 0.38.2. After rebuilding `Dockerfile.runner`, restart the server to replace old runners.

## Knowledge workers

The server never imports or executes qmd, SQLite vector extensions, or model inference. The adapter reads a fixed worker entrypoint as text and executes it with Node inside a dedicated runner container. If the runner is unavailable, search fails with an actionable error; there is no host fallback.

Operations are serialized per agent, and one global queue serializes model-backed queries and embedding jobs across workers. That queue does not coordinate unrelated shell processes using the same GPU. Retrieval has a one-minute timeout; deep-search model preparation has fifteen minutes. Document reads are capped at 2 MiB. Disk quotas are not implemented.

The pinned qmd adapter explicitly shares the SDK store's LlamaCpp instance with qmd 2.8.3's singleton tokenizer; without this, token-based chunking can load the default embedding model alongside a configured one. It calls qmd's internal `generateEmbeddings` with Carmel Agent's embedding deadline, because qmd 2.8.3's SDK `embed()` does not forward `maxDurationMs` and otherwise stops after 30 minutes. Its Node launcher avoids inheriting `--input-type=module` into native-binding probes. Treat qmd upgrades as adapter changes and rerun the Knowledge integration tests.

Normal shutdown cancels maintenance and removes workers; startup reaps workers left by a previous process. Legacy per-agent model choices are ignored, and previous per-agent model caches are not moved or deleted automatically.

## User requests

Questions and credential requests live in metadata storage with their session, native conversation, and tool-call identities, so tool replay finds the same request. The tool call parks on Durable's `carmel.user-request` signal with the request's expiry as its deadline. A parked call holds no process: Carmel Agent's run ends and releases resources while the native run stays open.

Answering stores the answer and marks delivery pending before continuation. The client starts a run without a new prompt; Carmel Agent delivers the signal, the call reads the response from the request record and returns it, and delivery is marked submitted. The signal carries only how the request ended, never an answer or credential. A crash after the signal is kept delivers it again as a duplicate, and an early signal wakes a call whose park was not stored yet. Read-only reconnects never start work.

The secret form posts directly to `/api/sessions/:id/requests/:requestId/secret`. The value exists only in component memory until submission and bypasses the composer, drafts, submissions, request records, and run events. The endpoint validates without echoing payloads, returns only metadata, and disables caching. Values are encrypted with AES-256-GCM even when the submitted string begins with the internal ciphertext prefix. Promotion updates the same encrypted record to environment scope, preserving its reference.

## Home memory learning

Learning asks the model for one `home_memory_capture` tool call instead of free-form JSON. A text reply is retried with the tool forced; only a provider that refuses that falls back to reading the reply. Every usable candidate in a batch is kept; a malformed entry does not discard its siblings.

Capture sees the topic index and a compact inventory of note IDs, revisions, fact slots, and summaries. Long notes are excerpted within the learning budget. Corrections reuse the existing note and slot. Editing or truncating a message retires only that message's pending capture. Forgetting stores fact fingerprints and stable slots — no note text — to prevent relearning.
