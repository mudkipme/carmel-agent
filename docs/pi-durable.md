# Pi Durable storage

Carmel uses Pi 1.1.0 and `@earendil-works/pi-durable` for execution and conversation storage. Pi Durable's native Node SQLite backend replaces `pi-session-backend-sqlite-node` and the harness formerly shipped inside `pi-agent-core`. Carmel's metadata, authentication, issues, and schedules remain in the existing Drizzle database.

## Storage and backups

`CARMEL_PI_SESSION_DIR` selects the native storage directory, defaulting to `data/pi-sessions.sqlite.durable/`. It contains one SQLite file per Carmel session, named with a hash of the session ID. Separate native sessions keep tool registries, credentials, checkpoints, and entry lookups scoped to a single Carmel conversation.

Back up the metadata database and the whole session directory with the server stopped. The runtime opens Durable storage directly; historical importers and metadata migrations have been retired after verification of the deployed data. Retired database files can be kept separately as archives, but the app never reads them.

Saved message and image-link IDs remain addressable through a session-scoped Durable entry index. New entries use native `durable:<id>` identifiers. The active conversation document stores the selected branch independently of public message IDs.

Forks and edits use append-only conversation branches. A non-truncating edit creates fresh IDs for the rewritten suffix and retains the original branch. Cross-session forks use a consistent SQLite snapshot, including WAL contents, and require all Durable work to be idle so executable checkpoints cannot be copied into another session.

## Recovery and observation

Pi owns generation checkpoints, tool intent, results, retry policy, compaction, steering submissions, and live progress. Reconnect reads capture history and committed progress on the same native transaction line. The wire adapter handles batched deltas, final unflushed content, and snapshot replacement when a slow observer exhausts the native event backlog.

After an unexpected process exit, requesting a run without new input resumes the selected conversation's checkpoint after installing current credentials and permitted tools. It does not rewind and resubmit the user message. A new prompt first settles pending work and then submits its new input. Read-only requests never start scheduling. A deliberate stop uses Durable's abort protocol and settles pending work rather than leaving it resumable.

Tools default to `replay: "unsafe"`. Pi records intent before executing them; after interruption it returns an error result instead of repeating a possible external effect. Read-only tools can explicitly opt into safe replay. Codemode is unsafe as a whole, because nested calls can change files or remote services. Its committed nested-call details survive recovery; Carmel no longer maintains a separate memo ledger or result-failure patch.

## Native features adopted

- Native SQLite storage, conversations, checkpoints, replay policy, committed live documents, and queued submissions.
- Native read/write/edit/bash tools, including batched edits, bounded output, efficient text reads, diagnostics, and shell output spill files. Durable 1.1.0 does not support image reads, so that case uses Pi coding-agent's image reader through the same guarded environment.
- Native context-token estimation and skill catalog formatting.
- Codemode's validated `// @options:` source header, tool-presence checks with `"name" in tools`, and image validation using base64 data URIs. Script options can lower Carmel's output and deadline limits, but cannot raise them.
- Native threshold, background, and overflow compaction. Small model windows get scaled reserve/tail settings: Durable's `enabled` flag controls overflow recovery too, so the old threshold-only disable workaround is removed.
- Pi's `azure` provider identifier.

Workspace authorization, container execution, credential selection, nested-call admission limits, and issue review/cron policy remain Carmel responsibilities. Pi's host filesystem resource loaders bypass the guarded environment, so Carmel retains guarded discovery. Prompt argument helpers are not public Pi 1.1.0 exports, so their positional/default/slice semantics remain in the adapter. Native Durable task primitives could underpin future application workflows, but do not replace cron scheduling or issue review policy by themselves.

Pi Durable is experimental. Versions are pinned to 1.1.0, and the storage contracts, stable entry IDs, restart replay policies, and streaming/reconnect behavior are covered by integration tests. See the [Pi Durable announcement](https://earendil.com/posts/pi-durable/) and [upstream package documentation](https://github.com/earendil-works/pi/tree/main/packages/durable).
