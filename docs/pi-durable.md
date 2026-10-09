# Pi Durable storage

Carmel uses Pi 1.1.0 and `@earendil-works/pi-durable` for execution and conversation storage. Pi Durable's native Node SQLite backend replaces `pi-session-backend-sqlite-node` and the harness formerly shipped inside `pi-agent-core`. Carmel's metadata, authentication, issues, and schedules remain in the existing Drizzle database.

## Storage and backups

`CARMEL_PI_SESSION_DIR` selects the native storage directory, defaulting to `data/pi-sessions.sqlite.durable/`. It contains one SQLite file per Carmel session, named with a hash of the session ID. Separate native sessions keep tool registries, credentials, checkpoints, and entry lookups scoped to a single Carmel conversation.

Back up the metadata database and the whole session directory with the server stopped. The runtime opens Durable storage directly; historical importers and metadata migrations have been retired after verification of the deployed data. Retired database files can be kept separately as archives, but the app never reads them.

Saved message and image-link IDs remain addressable through a session-scoped Durable entry index. New entries use native `durable:<id>` identifiers. The active conversation document stores the selected branch independently of public message IDs.

Forks and edits use append-only conversation branches. A non-truncating edit creates fresh IDs for the rewritten suffix and retains the original branch. Cross-session forks use a consistent SQLite snapshot, including WAL contents, and require all Durable work to be idle so executable checkpoints cannot be copied into another session.

## Recovery and observation

Pi owns generation checkpoints, tool intent, results, retry policy, compaction, steering submissions, and live progress. Reconnect reads capture history and committed progress on the same native transaction line. The wire adapter handles batched deltas, final unflushed content, and snapshot replacement when a slow observer exhausts the native event backlog. Snapshot recovery scans only missing entry IDs and restores live tool starts and nested-call details without duplicating starts across successive snapshots.

After an unexpected process exit, requesting a run without new input resumes the selected conversation's checkpoint after installing current credentials and permitted tools. It does not rewind and resubmit the user message. A new prompt first settles pending work and then submits its new input. Read-only requests never start scheduling. A deliberate stop uses Durable's abort protocol and settles pending work rather than leaving it resumable.

Connection snapshots report pending Durable work separately from the current process's active run. After a restart, the chat offers Resume and Stop for that saved work. Stop also works without a live run ID or provider credentials. Retry and transcript edits remain guarded until the checkpoint settles.

Tools default to `replay: "unsafe"`. Pi records intent before executing them; after interruption it returns an error result instead of repeating a possible external effect. Guarded read/grep/find/ls and the built-in skill loader explicitly opt into safe replay. Codemode is unsafe as a whole, because nested calls can change files or remote services. Its committed nested-call details survive recovery; Carmel no longer maintains a separate memo ledger or result-failure patch.

## Native features adopted

- Native SQLite storage, conversations, checkpoints, replay policy, committed live documents, and queued submissions.
- Native read/write/edit/bash tools, including batched edits, bounded output, efficient text reads, diagnostics, and shell output spill files. Nested codemode calls retain failed shell output and spill diagnostics, using Pi's UTF-8 byte/line truncation helpers. Durable 1.1.0 does not support image reads, so that case uses Pi coding-agent's image reader through the same guarded environment.
- Native named prompt sections and atomic model/thinking/tool configuration. Already-named sessions skip title history reads; new titles use a bounded sample from native entry pages.
- Native skill catalog formatting.
- Codemode's validated `// @options:` source header, tool-presence checks with `"name" in tools`, and image validation using base64 data URIs. Script options can lower Carmel's output and deadline limits, but cannot raise them.
- Native threshold, background, and overflow compaction. Small model windows get scaled reserve/tail settings: Durable's `enabled` flag controls overflow recovery too, so the old threshold-only disable workaround is removed.
- Pi's `azure` provider identifier.

Workspace authorization, container execution, credential selection, nested-call admission limits, and issue review/cron policy remain Carmel responsibilities. Pi's host filesystem resource loaders bypass the guarded environment, so Carmel retains guarded discovery. Prompt argument helpers are not public Pi 1.1.0 exports, so their positional/default/slice semantics remain in the adapter. Native Durable task primitives could underpin future application workflows, but do not replace cron scheduling or issue review policy by themselves.

## Prompt cache stability

Carmel does not inject a clock into system instructions or user messages, matching Pi coding-agent/TUI's default prompt. For relative scheduling, the model checks time with bash when available or asks the user. Native message timestamps remain storage metadata.

Named sections reduce redundant storage writes. They preserve the request prefix when the selected model supports mid-conversation system changes; otherwise Pi collapses section updates into the leading system prompt. Keeping a changing clock out of the prompt protects conversation-history caching in both cases. MCP tools are sorted by name within each configured server, keeping native declarations and Codemode's embedded catalog stable when a reconnect returns the same tools in another order.

Pi Durable is experimental. Versions are pinned to 1.1.0, and the storage contracts, stable entry IDs, restart replay policies, and streaming/reconnect behavior are covered by integration tests. See the [Pi Durable announcement](https://earendil.com/posts/pi-durable/) and [upstream package documentation](https://github.com/earendil-works/pi/tree/main/packages/durable).
