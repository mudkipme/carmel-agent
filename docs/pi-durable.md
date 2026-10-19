# Pi Durable storage

Carmel uses Pi 1.3.0 and `@earendil-works/pi-durable` for execution and conversation storage. Pi Durable's native Node SQLite backend replaces `pi-session-backend-sqlite-node` and the harness formerly shipped inside `pi-agent-core`. Carmel's metadata, authentication, issues, and schedules remain in the existing Drizzle database.

[Questions and session credentials](user-requests.md) use native run termination and idempotent submissions, with request lifecycle and encrypted credential storage owned by Carmel.

## Storage and backups

`CARMEL_PI_SESSION_DIR` selects the native storage directory, defaulting to `data/pi-sessions.sqlite.durable/`. It contains one SQLite file per Carmel session, named with a hash of the session ID. Separate native sessions keep tool registries, credentials, checkpoints, and entry lookups scoped to a single Carmel conversation.

Back up the metadata database and the whole session directory with the server stopped. The runtime opens Durable storage directly; historical importers and metadata migrations have been retired after verification of the deployed data. Retired database files can be kept separately as archives, but the app never reads them.

Saved message and image-link IDs remain addressable through a session-scoped Durable entry index. New entries use native `durable:<id>` identifiers. The active conversation document stores the selected branch independently of public message IDs.

Forks and edits use append-only conversation branches. A non-truncating edit creates fresh IDs for the rewritten suffix and retains the original branch. Cross-session forks use a consistent SQLite snapshot, including WAL contents, and require all Durable work to be idle so executable checkpoints cannot be copied into another session.

## Message references

Type `@` in the composer or use its mention button to choose workspace files, folders, or another conversation. Folder entries open for browsing; “Mention folder” selects the current folder. File and folder mentions insert their paths inline at the cursor, leaving the caret after the path so typing can continue. Paths with spaces are quoted. Removing an inline mention also removes its attached reference. Conversation references appear as removable chips. Saved references have clickable links. Up to ten references can accompany a message, including one with no text.

The server validates file paths against the agent's readable workspace and conversation references against the sender's ownership. Files and folders pass their paths to the agent's filesystem tools. Conversation references read a recent page from the selected native Durable branch, excluding thinking, tools, and nested reference context. Excerpts have a 6,000-character limit per conversation and a 24,000-character combined limit; they do not copy a complete session or subscribe to future changes.

Durable's input `entry` stores a `carmel.referenced-input` with display text and structured reference metadata separately from model-facing source context. Reloads, edits, and forks preserve that snapshot. Retrying a referenced message resolves its selected sources again, checking current access and reading current history. No new metadata database or cross-session execution is involved.

## Recovery and observation

Pi owns generation checkpoints, tool intent, results, retry policy, compaction, steering submissions, and live progress. Reconnect reads capture history and committed progress on the same native transaction line. The wire adapter handles batched deltas, final unflushed content, and snapshot replacement when a slow observer exhausts the native event backlog. Snapshot recovery scans only missing entry IDs and restores live tool starts and native nested-tool slots without duplicating starts across successive snapshots.

After an unexpected process exit, requesting a run without new input resumes the selected conversation's checkpoint after installing current credentials and permitted tools. It does not rewind and resubmit the user message. A new prompt first settles pending work and then submits its new input. Read-only requests never start scheduling. A deliberate stop uses Durable's abort protocol and settles pending work rather than leaving it resumable.

Connection snapshots report pending Durable work separately from the current process's active run. After a restart, the chat offers Resume and Stop for that saved work. Stop also works without a live run ID or provider credentials. Retry and transcript edits remain guarded until the checkpoint settles.

Tools default to `replay: "unsafe"`. Pi records intent before executing them; after interruption it returns an error result instead of repeating a possible external effect. Guarded read/grep/find/ls and the built-in skill loader explicitly opt into safe replay. Native Durable Codemode is replay-safe: Pi journals delivered results and reattaches each nested call by its stable key. Completed effects are reused; interrupted nested calls follow their own replay policy. A failed unsafe call can be caught by the script, while an interrupted safe read may run again. Calls admitted by the old unsafe Codemode implementation retain that original policy and settle as interrupted.

## Native features adopted

- Native SQLite storage, conversations, checkpoints, replay policy, committed live documents, and queued submissions.
- Native read/write/edit/bash tools, including batched edits, bounded output, efficient text reads, diagnostics, and shell output spill files. Native image reads use the same guarded environment, with lazy Photon processing in a worker for conversion and resizing to the selected model's limits.
- Tools register native `ToolRegistration` definitions and return native `ToolExecutionResult` values. Bash exposes retained output, truncation, spill path, and exit code to programs. Schema tools return their structured value even on an error when a value is present; scripts must check fields such as `exitCode`. Other failed calls reject with their diagnostics. Tools without explicit output schemas return text to Codemode scripts; MCP structured content remains in native result details unless the server declares an output schema. Image values exposed to scripts must be part of a declared structured output, which scripts can pass to `image()`.
- OpenRouter's per-key model lists are cached under a hash of the credential and configured endpoint. Shared legacy OpenRouter rows are ignored by model runtimes, and each OpenRouter configuration refreshes separately. Other providers retain their shared catalog cache.
- Native named prompt sections and atomic model/thinking/tool configuration. Already-named sessions skip title history reads; new titles use a bounded sample from native entry pages.
- Native skill catalog formatting.
- Native Durable Codemode, nested tool tasks, validated `// @options:` source headers, native tool discovery, and the bounded prompt catalog. Scripts can check `"name" in tools`, discover permitted tools with `searchTools()`/`describeTool()`, and show images with `image(block)`. Script options can lower Carmel's output and deadline limits, but cannot raise them.
- Native threshold, background, and overflow compaction. Small model windows get scaled reserve/tail settings: Durable's `enabled` flag controls overflow recovery too, so the old threshold-only disable workaround is removed.
- Pi's `azure` provider identifier.

Pi 1.3.0 still has no Durable grep/find/ls implementations. Those three guarded Agent-loop tools retain a small bridge into native `ToolRegistration`; Carmel's generic tool/result compatibility layers are gone.

Workspace authorization, container execution, credential selection, nested-call admission limits, and issue review/cron policy remain Carmel responsibilities. Pi's host filesystem resource loaders bypass the guarded environment, so Carmel retains guarded discovery. Prompt argument helpers are still not public exports (`parseCommandArgs` and `substituteArgs` live only in the package's internal `dist/core/prompt-templates` module), so their positional/default/slice semantics remain in the adapter, including the 1.3.0 rule that `""` and `''` are real arguments. Native Durable task primitives could underpin future application workflows, but do not replace cron scheduling or issue review policy by themselves.

## Durable Codemode

Carmel registers Pi's native Codemode implementation and prompt section. Carmel supplies its guarded execution environment, permitted native tool registry, sequential scheduling, admission limits, and browser handoff. Pi owns argument repair/validation, replay intent, nested results, output limits, script journals, cancellation of owned work, and script recovery. Nested results do not become transcript messages.

The default limits remain 60 seconds, 64 MiB of VM memory, and 250 nested calls per script. Limits are memoized in the native tool task and admitted calls use native nested-call documents; reattaching an existing nested task does not consume run admission again. The deadline includes time spent interrupted. Native `store()` and `load()` keep JSON values per conversation, commit changes only on successful scripts, and fork as of the selected entry.

Native output includes elapsed time, text markers, console grouping, and spill/image paths. The server forwards native nested start/update/end events and `pi.live.nestedTools` snapshots through the shared protocol into the chat. Saved Codemode results render Pi's native `details.calls`. The old tool/result adapters, MCP script envelopes, `codemodeCalls` schema, custom admission document, and parent-slot progress copies are removed. Aborted parents may have no saved call details; cancellation is observed through native events and snapshots. Nested tool control hints do not terminate the model run; direct model calls retain native termination behavior. Snapshot replacement restores nested progress without emitting duplicate top-level tool starts or counting nested completions twice.

```javascript
const result = await tools.bash({ command: "npm test" });
text({ exitCode: result.exitCode, output: result.output });
store("lastTestExit", result.exitCode);
```

## Removed compatibility layers

The previous `AgentHarness`/`AgentLane` facade, generic prompt-dispatch port, filtered event bus, old message-event reconstruction, fake queue watch, and HTTP delta batching timer are retired. Runs call native `Conversation.configure`, `submit`, `abort`, and `waitForIdle`. Steering and issue delivery read native `Submission.status()` and `InboxDoc`; stopping queued input uses `abortSubmission`.

Native batched `message_update.changes` now cross the shared protocol into the client. Pi owns progress batching, and HTTP supplies authentication, sequence numbers, replay bounds, and a terminal application result. Server and client must be deployed together because the old `message_delta`/`message_part` protocol is removed. Recorded stream fixtures use the new format.

`PiRun` handles the application-specific boundary between committed input settlement and delivered HTTP observations. It waits for event delivery before finalization and recovers missing committed entries when Durable replaces an observer backlog with a snapshot. It does not expose a second harness or lane API. The small `SessionLog` port remains for Carmel's public branch IDs and retry restoration; its implementation calls native storage operations directly.

Compaction errors come directly from native end events and retained snapshot failures, with one warning per failed task. Recovery is announced when a native compaction summary entry is placed, so a declined compaction cannot claim success. The settings forwarding proxy and unused session-wide entry-search facade are gone. Native settings select only the current run's extensions, preventing a previously enabled extension from leaking into a later run.

The remaining bridges protect application behavior: guarded workspace/resource reads, container execution, per-user credentials and personalized catalog caches, resolved model overrides, stable saved entry/image links, and issue/cron policy. Pi captures its `Models` object when opening storage, so the session's small model forwarding proxy is still needed to install fresh per-run credentials while HTTP readers share the same lease. Prompt argument helpers are still not public exports, and grep/find/ls have no Durable equivalents.

## Further 1.2.0 adoption

Pi's optional `models.*` Codemode helpers remain disabled. Exposing classifiers and image generation needs application policy for which models and paid operations scripts may invoke; scripts currently reach the agent's configured tools.

Deferred tools and native `tool_search` could reduce large MCP catalogs in the prompt. Adoption needs to reconcile Carmel's permission and allowlist filtering with Durable's separate model-visible and program-callable tools, including discovery after reconnect.

The optional bounded `ExecutionEnv.listFiles` can support future tree listing after implementing Carmel's path and mount authorization.

OpenRouter regional catalog filtering needs its configured endpoint passed into Pi's provider configuration before refresh; the cache scope alone does not configure the upstream request. Synchronous model serializers still use the shared catalog lookup and should eventually read the matching personalized catalog too.

The upgrade also brings MCP structured results that may be arrays, primitives, or null, stricter misplaced Codemode options, and provider retry/timeout fixes. Carmel already passes structured MCP values through without an object-only restriction. Pi's terminal clipboard, themes, and CLI extension-start changes do not apply to Carmel's web client and Durable run path. See the [1.2.0 release](https://pi.dev/changelog/releases/1.2.0), [Durable changelog](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/CHANGELOG.md), and [MCP changelog](https://github.com/earendil-works/pi/blob/v1.2.0/packages/mcp/CHANGELOG.md).

## Prompt cache stability

Carmel does not inject a clock into system instructions or user messages, matching Pi coding-agent/TUI's default prompt. For relative scheduling, the model checks time with bash when available or asks the user. Native message timestamps remain storage metadata.

Named sections reduce redundant storage writes. They preserve the request prefix when the selected model supports mid-conversation system changes; otherwise Pi collapses section updates into the leading system prompt. Keeping a changing clock out of the prompt protects conversation-history caching in both cases. MCP tools are sorted by name within each configured server, keeping native declarations and Codemode's embedded catalog stable when a reconnect returns the same tools in another order.

Pi Durable is experimental. Versions are pinned to 1.3.0, including `@earendil-works/chord`, which Pi Durable depends on at that exact version. The storage contracts, stable entry IDs, restart replay policies, and streaming/reconnect behavior are covered by integration tests. Storage errors now fail and close the native session; pending waits reject instead of retrying operations on it. Existing live version-1 tool tasks migrate to Pi's version-2 tagged model/nested-call format. See the [Pi Durable announcement](https://earendil.com/posts/pi-durable/) and [upstream package documentation](https://github.com/earendil-works/pi/tree/v1.3.0/packages/durable).

## Pi 1.3.0

The 1.3.0 bump is small on top of the 1.2.0 adoption above. These behaviors arrive through the packages Carmel already calls, with no extra adapter:

- Model switching drops thinking blocks from earlier assistant messages produced by a different model, instead of sending them as text.
- OpenAI GPT-6 thinking-level changes with an API key keep the prompt cache (`compat.supportsMidConvoEffort`).
- Malformed final tool-call arguments fail validation with `argumentsError` and `arguments: {}`, instead of running on the JSON parsed before the error. The chat shows that error, including the raw text, in the tool input.
- Provider retries cover `Unable to forward upstream stream` and `The service is temporarily unavailable`. Gemini 4 sends `thinkingLevel`. Xiaomi MiMo exposes only `off` and `high`. Claude Haiku 5.5 and Opus 5 send `thinking: {type: "disabled"}` for `off`. Kimi Code uses Chat Completions at `https://api.kimi.com/coding/v1`; a `models.json` base URL for `kimi-coding` must include `/v1`. Carmel has no built-in Kimi override.
- After compaction, the system baseline leads the model context when the kept history includes an assistant message.
- `toBase64` encodes images in 8 KiB chunks. Carmel does not share a SQLite file with host tables, so the new storage `prefix` option is unused. Chord's host-runtime rewrite is also unused: Carmel only uses `Context`, `JsonValue`, `BACKGROUND_CONTEXT`, and `withAbortSignal`.

`CodemodeSandbox.close()` now returns after requesting worker shutdown, not after the worker exits. Each Carmel script waits on `onWorkerStarted` until that worker exits, so an aborted script cannot leave a thread behind. Pi's CLI also caps live workers at two across its sessions. That cap is not copied: concurrent Carmel sessions each run their own script, and waiting for the worker this call started already bounds leaks to in-flight scripts. Node 24 is the runtime; the Bun hang this change avoids does not apply.

Not adopted, because 1.3.0 does not replace the custom code:

- Durable grep, find, and ls still do not exist. The guarded Agent-loop bridge stays. `ExecutionEnv.listFiles` is an optional tree listing, not those tools, and Pi's host resource loaders still bypass the guarded environment.
- Prompt helpers remain internal. The adapter keeps their semantics, including empty quoted arguments.
- Deferred tools and `@earendil-works/pi-durable/tool-search` still need Carmel's permission and allowlist filtering reconciled with Durable's separate model-visible and program-callable tools.
- `models.classify()` and `models.generateImages()` stay off. Scripts may call the agent's configured tools; exposing paid classifier and image calls needs a separate policy.
- OpenRouter regional catalog filtering still needs the configured endpoint passed into Pi's provider configuration before refresh. The cache scope alone does not set that request.
- `/share`, `sessionShareDestination`, resumed-session `--tools`, themes, and terminal clipboard are CLI features. Carmel's web client and Durable run path do not use them.

See the [1.3.0 release](https://github.com/earendil-works/pi/releases/tag/v1.3.0).
