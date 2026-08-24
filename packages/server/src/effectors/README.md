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

## What is still on the far side of the seam

`runtime/agent-runtime.ts` is migrated for prompt dispatch only. Still holding
Pi types directly:

- `startAgentRun` / `openRunHarness` — constructs `AgentHarness`, subscribes,
  aborts. Moves behind `AgentDriver.observe`; `RetryBranch.observe` becomes
  `onUserMessagePersisted`.
- `compactIfNeeded` — replace with `AgentDriver.compactIfNeeded`, which reports
  `failed` with the token numbers instead of swallowing the error into a
  `console.warn`. That reporting is the point: a long session whose compaction
  failed keeps accepting turns and heads for the context wall with nobody told.
- `recordRunConfiguration` — replace with `reconcileSessionState`.
- `finalizeRun` / `prepareAgentRunPrompt` — branch reads and rewinds, onto
  `SessionLog`.
- `services/pi-session-storage.ts` — fork and transcript-replace reach through
  `getStorage()` for `createEntryId`/`appendEntry`, which 0.84 makes private.
  Needs a third port for archive operations.
- `runtime/run-events.ts` — already an anti-corruption layer for event *shapes*;
  the 0.83 adapter calls it. Only its `AgentHarnessEvent` import is exposed.
