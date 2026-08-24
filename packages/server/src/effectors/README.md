# Effectors

Carmel drives Pi's agent loop rather than merely assembling one, and that is the
whole reason upstream churn costs us anything. Pi is mid-rewrite: 0.84 swapped
the working v1 `AgentHarness` for a v2 scaffold, and the v2 engine now landing on
`origin/dev` threads an explicit `Context` through every method, makes
`AgentHarness` an interface, unexports `AgentHarnessEvent`, replaces
`subscribe()` with `events.on()`, and renames most of the session surface
(`moveTo` -> `moveLane`/`navigateTree`, `getBranch()` -> `findEntriesOnBranch()`,
`SessionTreeEntry` -> `Entry`, `session.buildContext()` -> a standalone
`buildSessionContext(entries)`, `getStorage()` private).

This directory exists so that list stops being a list of edits scattered through
the run path and becomes a list of edits to two adapter files.

## Layout

| Path | Rule |
| --- | --- |
| `contracts/` | What Carmel needs, named in Carmel's terms. No Pi imports, with one documented exception in `contracts/messages.ts`. |
| `pi-0-83/` | Adapters onto the Pi we ship today. The only place that imports Pi to talk to the loop. |
| `testing/` | Fakes, plus contract suites that any implementation must pass. |
| `dispatch-prompt.ts` | Policy over a port. Pi-free by construction. |

Two ports, not one, because upstream reshapes the loop and the store on
independent schedules:

- **`AgentDriver`** — the seven harness operations Carmel actually calls, plus
  `PromptDispatcher`, the four-method slice that slash-command dispatch needs.
- **`SessionLog`** — the session tree operations, plus `reconcileSessionState`,
  the change-detection policy that no adapter gets a say in.

## Porting to a new Pi

1. Copy `pi-0-83/` to `pi-<version>/` and fix it until it compiles.
2. Add a factory for it to `effectors.test.ts`. The existing contract suite runs
   against it unchanged.
3. Ship when it is green.

The suite is the deliverable. A v2 adapter is not reviewed into correctness; it
is pointed at `testing/session-log-contract.ts`, which either passes or names the
operation whose meaning changed. That suite has already earned its keep once —
see the `thinkingLevel` note in `contracts/session-log.ts`, a redundant write on
the first turn of every new session, found by running the fake and the real
adapter through the same cases.

## Compaction

`compaction-policy.ts` decides whether compaction is worth attempting, as a pure
function of tokens, the model's window, and the settings. It exists because
Pi's `shouldCompact()` answers "is the context over the threshold?" and Carmel
was reading it as "will compacting help?". Two configurations separate those:

- **`window_below_reserve`** — the window is smaller than the 16,384 tokens
  reserved for summarization, so the threshold is negative and even an empty
  session asks to be compacted.
- **`retained_tail_exceeds_headroom`** — compaction retains ~20,000 tokens of
  recent history, so it cannot get below that. With Pi's defaults, any window at
  or below **36,384 tokens** is in this state: compaction is requested, runs,
  costs a summarization call, and leaves the session over the threshold, once
  per turn, forever. Reachable through Settings -> Models by giving an Ollama
  entry its real window.

Both are now reported instead of attempted. Beyond that, the driver re-measures
after compacting rather than trusting the call (`ineffective` vs `compacted`),
distinguishes Pi's benign "Nothing to compact" from a real failure, and the run
calls it *before* the prompt as well as after -- a session can be over budget at
the start of a turn without having grown, because moving it onto a
smaller-window model is enough. Outcomes the user can act on reach the client as
a `context_pressure` run event.

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

## Context recovery

`turn-recovery.ts` decides whether a failed turn gets one more attempt.

Only `context_overflow` is recovered: it is the one provider rejection Carmel
can actually fix between attempts. Auth, quota, and a malformed tool history all
need a person, and retrying them spends the user's tokens to reach the same
answer.

Compaction runs before every prompt, so an overflow means the turn started
inside its budget and left it. Two causes, two repairs:

- **The estimate was wrong.** `estimateContextTokens` is a character heuristic;
  the provider's count is ground truth. Nothing durable happened, so the run
  rewinds past the user message and the failed reply both and sends the message
  again — the transcript ends up as though it never happened.
- **A tool result ballooned the context mid-turn.** The turn *did* work, so
  rewinding would discard the expensive part. The run keeps it and sends a
  continuation prompt instead, at the cost of a visible extra turn.

The rule is `turnProducedToolResults`: tool results are the durable part, while
assistant text before an overflow is usually a preamble the retry produces
again.

Two things this needed that are worth remembering:

- **The compaction is forced.** The provider has already rejected this context as
  too large, which outranks the local estimate that let the turn start. Without
  `force`, recovery would consult the estimate that was just proven wrong and
  decline to act — the exact case the resend path exists for. `force` does not
  override an `impossible` verdict, which is about the model, not the estimate.
- **`run_recovered` clears the client's error.** The failing `turn_end` reached
  the client before the server knew the failure was recoverable, so reporting
  the recovery honestly means retracting what was already shown.

One attempt per run. A second overflow after a successful compaction is
information the user needs, not a reason to spend more tokens.

## What is still on the far side of the seam

`runtime/agent-runtime.ts` is migrated for prompt dispatch only. Still holding
Pi types directly:

- `startAgentRun` / `openRunHarness` — constructs `AgentHarness`, subscribes,
  aborts. Moves behind `AgentDriver.observe`; `RetryBranch.observe` becomes
  `onUserMessagePersisted`.
- `recordRunConfiguration` — replace with `reconcileSessionState`.
- `finalizeRun` / `prepareAgentRunPrompt` — branch reads and rewinds, onto
  `SessionLog`.
- `services/pi-session-storage.ts` — fork and transcript-replace reach through
  `getStorage()` for `createEntryId`/`appendEntry`, which 0.84 makes private.
  Needs a third port for archive operations.
- `runtime/run-events.ts` — already an anti-corruption layer for event *shapes*;
  the 0.83 adapter calls it. Only its `AgentHarnessEvent` import is exposed.
