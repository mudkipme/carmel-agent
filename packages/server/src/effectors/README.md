# Effectors

Carmel drives Pi's agent loop rather than merely assembling one, which is why
upstream churn costs us anything. This directory keeps the Pi-facing edits a
new release forces in a few adapter files instead of scattered through the run
path.

## Layout

| Path | Rule |
| --- | --- |
| `contracts/` | What Carmel needs, named in Carmel's terms. No Pi imports, with one documented exception in `contracts/messages.ts`. |
| `pi-0-99/` | Adapters onto the Pi we ship today. |
| `testing/` | Fakes, plus contract suites that any implementation must pass. |
| `dispatch-prompt.ts` | Policy over a port. Pi-free by construction. |

Two ports, not one, because upstream reshapes the loop and the store on
independent schedules:

- **`PromptDispatcher`** — sending composer text as a prompt, skill, or template.
- **`SessionLog`** — reading, rewinding and appending to the conversation branch.

Run configuration (model, thinking level, active tools) is lane state, written
by `reconcileLaneConfiguration` in the adapter.

## Porting to a new Pi

1. Copy `pi-0-99/` to `pi-<version>/` and fix it until it compiles.
2. Add a factory for it to `effectors.test.ts`. The existing contract suite runs
   against it unchanged.
3. Ship when it is green.

The suite is the deliverable. A v2 adapter is not reviewed into correctness; it
is pointed at `testing/session-log-contract.ts`, which either passes or names the
operation whose meaning changed.

## Compaction

Pi 0.99 does all of it: it checks the threshold at every checkpoint of a run,
and when a generation overflows it compacts and retries that generation once.
Carmel compacts nothing itself. `compaction-policy.ts` covers the one thing Pi
gets wrong, and the wording for what Pi reports.

What Pi gets wrong: its `shouldCompact()` answers "is the context over the
threshold?", not "will compacting help?". Two configurations separate those:

- **`window_below_reserve`** — the window is smaller than the 16,384 tokens
  reserved for summarization, so the threshold is negative and even an empty
  session asks to be compacted.
- **`retained_tail_exceeds_headroom`** — compaction retains ~20,000 tokens of
  recent history, so it cannot get below that. With Pi's defaults, any window at
  or below **36,384 tokens** is in this state -- most locally-served Ollama
  models given their real window.

For either, the run opens its harness with threshold compaction disabled, so Pi
stops paying for a summarization at every step that leaves the session over
budget. Pi's overflow recovery ignores `enabled` and stays available. Before the
prompt, the run warns (`context_pressure`) if such a session is already over
budget.

`ContextReporter` (`runtime/agent-runtime.ts`) turns Pi's compaction events into
what the user sees:

- **Overflow compacted** -> `run_recovered`. The overflowed attempt's `turn_end`
  already reached the client as an error, so the recovery has to retract it.
- **A compaction failed** -> a `context_pressure` warning with Pi's reason.
- **The run still ended on an overflow** -> a critical `context_pressure`: either
  compaction did not free enough room, or there was nothing to summarize.

## Branch integrity

`branch-integrity.ts` answers whether a branch is a context a provider will
accept: every tool call answered, every tool result called for. Pi keeps its own
branches valid -- the agent loop synthesizes an aborted tool result for anything
still pending when a run is cancelled -- so the only way Carmel reaches an
invalid branch is by moving the leaf itself.

Truncate and fork both do that by entry id, and both now refuse a cut that would
strand a tool call, answering `409` with the nearest entry that *would* be safe.
The refusal is offered rather than applied: silently extending the cut would
mean `truncate(entryId)` keeps messages the caller asked to drop. The UI never
hit this (it only offers these on user messages); the API had no guard at all.

Edit is safe by construction -- `truncate: true` is restricted to user messages,
and a user message cannot hold a tool call.

## Failure classification

`failure-classifier.ts` turns a provider or harness error into a category, a
retryable verdict, and a remedy. Before it, an expired credential, an exhausted
quota, a context overflow, and a malformed tool history all reached the user as
the same red box of provider text with no suggested action -- which matters more
in a multi-user instance than a single-user one, because the person who can fix
an auth or quota problem is usually not the person watching the session fail.

Two call sites, because there are two failure paths:

- `runtime/model.ts` `createAgentError` — exceptions out of the run body.
- `runtime/run-events.ts` `turn_end` — provider rejections, which do not throw;
  Pi turns them into an assistant message with `stopReason: "error"`. This is the
  common case, so classifying only in `createAgentError` would have missed it.

Pi's `isRetryableAssistantError` rides in as a *hint* rather than a dependency,
so its pattern list stays the source of truth for "transient" while the
classifier itself stays Pi-free. The hint only promotes an unrecognised failure;
it never overrides a specific match, because Pi reads any 429 as transient and
retrying an exhausted quota just burns the turn.

An unclassified failure keeps the provider's text verbatim: when the
classification is worst is when the raw text is worth most.

## Runtime limits

`run-guard.ts` stops a run that has gone wrong in a way nothing else catches.
Three gaps made it necessary, each verified rather than assumed:

- **Pi's agent loop has no iteration cap.** It runs until the model stops asking
  for tools. `grep maxIterations|maxSteps|maxTurns` over `agent-loop.js` returns
  nothing.
- **The bash tool only times out when the *model* passes a timeout.**
  `bash-operations.ts` guards on `typeof options.timeout === "number"`; omit the
  argument and the command runs until the container does.
- **`streamOptions.timeoutMs` was never set.** A provider connection that opened
  and never answered held the run, and with it the session's mutation lease, for
  the life of the process. Now set, default 10 minutes.

On a single-user machine any of these is an annoyance. On a shared instance it is
one user's agent holding another user's container CPU.

The guard counts finished tool calls (default 250) and watches for silence
(default 15 minutes), polled on a 30-second timer. Both are deliberately far
above ordinary work: a real task can make a hundred tool calls, but nothing
legitimate makes hundreds while producing no other activity for a quarter of an
hour. `CARMEL_AGENT_MAX_TOOL_CALLS`, `CARMEL_AGENT_STALL_TIMEOUT_MS`, and
`CARMEL_AGENT_REQUEST_TIMEOUT_MS` override them.

A stop aborts through the same `HarnessAbortGate` the HTTP stop path uses, then
throws `RunGuardError` into the run body so it is persisted like any other
failure. That routing matters for a reason the integration test asserts: Pi
synthesizes results for tool calls still pending when an abort lands, so a guard
stop cannot leave the branch unpromptable.

The failure classifier deliberately leaves these as `unknown`, which means the
guard's own message reaches the user verbatim. A category would replace a
precise sentence with a generic one.

## Prompt cache

Two changes, both about keeping the cached prefix intact rather than making it
smaller:

- **Skills and prompt templates are sorted** before they reach the system prompt
  (`runtime/resources.ts`). Pi discovers both with `readdirSync` and no ordering
  of its own, and `formatSkillsForSystemPrompt` emits them as given. Directory
  order is usually stable on one filesystem but nothing promises it, and a shift
  invalidates the whole prefix.
- **`PI_CACHE_RETENTION` defaults to `long`** (`env.ts`), so Anthropic caches for
  an hour instead of Pi's five-minute default. Carmel sessions are human-paced;
  reading a reply or going to a meeting exceeds five minutes, and each pause was
  a full miss on the entire prefix. One-hour writes cost more per token, so this
  trades dearer writes for far more hits. An explicit value in the environment or
  a `.env` file still wins.

Pi places the `cache_control` breakpoints itself -- system blocks, last tool,
last user message -- so nothing else is needed there.

Worth remembering when changing either: **every compaction is a full prefix
invalidation**, since it rewrites the history. That is the link between the
compaction work above and cache economics, and the reason disabling futile
threshold compaction matters beyond saving a model call.

## What is still on the far side of the seam

- `runtime/agent-runtime.ts` constructs `AgentHarness`, acquires the lane and
  subscribes to its events (through `observeHarnessEvents`) directly.
- `services/pi-session-storage.ts` owns session open/close, fork, transcript
  replace and entry rewrites against Pi's storage API.
- `runtime/run-events.ts` projects Pi's harness events onto the wire protocol.
