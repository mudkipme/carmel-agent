# iOS Client Plan

A native SwiftUI client for an existing self-hosted Carmel Agent server — full feature parity with the web app, on iPhone and iPad.

Written against the server at commit `30bd6f7`. Protocol details below were verified in `packages/server/src/routes/`, `packages/server/src/runtime/run-stream.ts`, `packages/server/src/serializers.ts`, and `packages/client/src/lib/remote-agent.ts` — they are what the code does, not what the README says.

- **Target** — iOS 18 / iPadOS 18
- **Server** — unchanged for v1
- **Endpoints** — 40
- **Estimate** — 11–15 weeks, one engineer

## Three Corrections To The Brief

All three change what gets built, so they come first.

### It Is Not SSE

The server streams **NDJSON**, not Server-Sent Events. `createRunStream` in `packages/server/src/runtime/run-stream.ts` writes `JSON.stringify(envelope) + "\n"` with `content-type: application/x-ndjson`. There is no `data:` framing, no `event:` field, no `id:` line, and no `Last-Event-ID` handling. `EventSource` semantics and `URLSessionEventSource`-style libraries do not apply.

This is good news. NDJSON over `URLSession.bytes(for:)` is about thirty lines of Swift, and the resume protocol the server does implement — an `?after=` sequence cursor with explicit gap detection — is stricter and more reliable than SSE's.

### There Is No OpenAPI Document

The repo has no spec of any kind. `swift-openapi-generator` is still the right call, but *authoring the document is a work item*, not a given. Roughly half of it can be derived mechanically from the Zod schemas in `packages/shared/src/schemas.ts`; the response half has to be hand-written from the TypeScript types and kept honest by a CI check. See [Getting An OpenAPI Document](#getting-an-openapi-document).

### Auth Is A Cookie, Not A Token

`createAuthSession` sets an opaque `carmel_session` cookie: `httpOnly`, `SameSite=Lax`, `Secure` only when `NODE_ENV=production`, 30-day lifetime, SHA-256 hashed server-side. There is no bearer scheme and no refresh flow.

`URLSession` handles this transparently, and one detail makes it work in the client's favour: `rejectCrossOriginMutations` allows any mutating request that sends **no** `Origin` header, and `URLSession` sends none. So do not add one — a helpful "let's set Origin for correctness" commit will break every POST in the app.

## The API You Are Actually Targeting

Forty endpoints under `/api`, all behind `requireAuth` except five public ones. Everything is JSON except the two streams and three image endpoints. Errors are uniformly `{"error": string}` with a meaningful status.

### Streaming And Transcript

| Endpoint | Notes |
| --- | --- |
| `POST /api/agents/{id}/run` | Starts a run. Body `{sessionId, modelRefId?, thinkingLevel?, promptInput?}`. **200 returns a live NDJSON stream** plus headers `x-agent-run-id` and `x-agent-event-cursor`. `409` means the session already has a run in flight (body and the `x-agent-run-id` header both carry its id). `404` agent/session/model, `400` no credentials for the model's provider. |
| `GET /api/agent-runs/{runId}/events?after={n}` | Rejoins a run from sequence `n`. `200` NDJSON, `404` run finished or not yours, `409` replay gap (the buffer holds 1000 events), `400` cursor ahead of the run. |
| `POST /api/agent-runs/{runId}/abort` | `{ok:true}` or `404`. A 404 here is normal — the run finished before the abort landed. |
| `GET /api/sessions/{id}/connection` | The recovery primitive: `{session, activeRun\|null}`, where `session` carries the **entire** transcript. Also the only way to read a transcript at all. |
| `GET /api/sessions/{id}/images/{msgIdx}/{imgIdx}`<br>`.../tool-result-images/{msgIdx}/{partIdx}`<br>`.../attachments/{msgIdx}/{attachmentId}` | Binary image bodies, `cache-control: private, max-age=31536000, immutable`. Feed these straight to `AsyncImage` or a URLCache-backed loader. |

### Everything Else

| Group | Endpoints | Access |
| --- | --- | --- |
| Auth | `POST /auth/login`, `/auth/logout`, `/auth/setup`, `GET /auth/status`, `POST /auth/account` | first four public |
| Bootstrap | `GET /bootstrap`, `GET /health` | any user |
| Users | `GET/POST /users`, `PATCH /users/{id}`, `POST /users/{id}/password`, `DELETE /users/{id}`, `PUT /users/{id}` | admin, except `PUT` (self) |
| Models | `PUT /models/{id}`, `DELETE /models/{id}` | owner |
| Providers | `PUT/DELETE /provider-configs/{id}`, `GET /provider-configs/{id}/models?refresh` | admin |
| OAuth | `GET /oauth/providers`, `POST /provider-configs/{id}/oauth/login`, `GET /oauth/flows/{id}`, `POST /oauth/flows/{id}/input` | admin |
| Agents | `PUT/DELETE /agents/{id}`, `GET /agents/{id}/settings`, `GET /agents/{id}/commands` | owner / visible |
| Files | `GET /agents/{id}/files`, `.../files/content`, `.../files/raw`, `PUT .../files/content`, `POST/PATCH/DELETE .../files` | permission-gated |
| Tasks | `GET/POST /agents/{id}/tasks`, `PATCH/DELETE .../tasks/{taskId}`, `POST .../run`, `GET .../runs` | owner |
| Sessions | `POST /sessions`, `POST /sessions/import/open-webui`, `PATCH /sessions/{id}`, `POST .../fork`, `POST .../messages/truncate`, `PATCH .../messages/{entryId}`, `DELETE /sessions/{id}` | owner |
| Extensions | `GET /extensions` | admin |

### Six Behaviours To Encode, Not Discover

- **Upsert-by-id.** `PUT /agents/{id}`, `PUT /models/{id}`, and `PUT /users/{id}` create *or* update. The web client mints ids locally (`agent_<uuid>`, `model_<uuid>`). Do the same in Swift — there is no separate create endpoint.
- **Delete returns a new bootstrap.** `DELETE /models/{id}` and `DELETE /provider-configs/{id}` respond with a full `BootstrapPayload`, not `{ok:true}`. Replace the store wholesale from it.
- **Agent lists are redacted.** `serializePublicAgent` blanks `systemPrompt` and `promptTemplates` in `/bootstrap`. The owner-only `GET /agents/{id}/settings` is the only place they exist — the settings screen must fetch it on open, exactly as `AgentSettingsDialog` does.
- **409 is a first-class outcome.** Any session or agent mutation while a run holds the lease returns 409. So does editing the model or provider a live run depends on. Surface it as "this session is busy", never as a generic failure.
- **Thinking levels are model-dependent.** The server clamps on write (`resolveSupportedThinkingLevel`), and the picker's options come from `ModelRef.thinkingLevelMap`: `xhigh` and `max` are offered only when the map has a non-null entry for them. Port that rule or the picker will offer levels the server silently downgrades.
- **Login is rate-limited.** Five failures per IP+username per 15 minutes, then `429`. Do not auto-retry a stored credential in a loop.

## Getting An OpenAPI Document

The document is the project's contract, so it belongs in this repo — `packages/shared/openapi.yaml` — not in the iOS repo where it would rot silently.

### Half Of It Writes Itself

Every request body is already a Zod v4 schema in `packages/shared/src/schemas.ts`, and Zod 4 ships `z.toJSONSchema()`. A ~60-line script emits all 20 request schemas as OpenAPI components:

```ts
// packages/shared/scripts/emit-openapi-components.ts
import { z } from "zod";
import * as S from "../src/schemas.ts";

const requestSchemas = {
  LoginRequest: S.loginRequestSchema,
  SetupRequest: S.setupRequestSchema,
  AgentRunRequest: S.agentRunRequestSchema,
  AgentConfigRequest: S.agentConfigRequestSchema,
  SessionPatchRequest: S.sessionPatchRequestSchema,
  AgentTaskCreate: S.agentTaskCreateSchema,
  // ...
};

const components = Object.fromEntries(
  Object.entries(requestSchemas).map(([name, schema]) =>
    [name, z.toJSONSchema(schema, { target: "openapi-3.0" })]),
);
```

Response shapes are plain TypeScript types (`User`, `AgentConfig`, `Session`, `ModelRef`, `AgentTask`) with no runtime schema, so those get hand-written once against `packages/shared/src/index.ts` and `serializers.ts`. Watch `serializers.ts` specifically — it is where fields get dropped (`apiKey`, `responseId`, `diagnostics`) and added (`hasApiKey`, `hasOAuth`).

### Keeping It Honest

A spec that drifts is worse than no spec. Add one test to the existing server suite (`node --test`, already wired up):

- Walk the Hono router's registered routes and assert every `method + path` appears in `openapi.yaml`, and vice versa. This catches an added endpoint the same day it lands.
- For each documented response, validate one real fixture body against the schema with Ajv.

Ten minutes of CI, and it removes the single largest source of "the generated client compiles but 404s".

### Generator Setup

```swift
// Package.swift (excerpt)
dependencies: [
  .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.9.0"),
  .package(url: "https://github.com/apple/swift-openapi-runtime",   from: "1.8.0"),
  .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.1.0"),
]
```

```yaml
# Sources/CarmelAPI/openapi-generator-config.yaml
generate: [types, client]
accessModifier: public
namingStrategy: idiomatic
filter:
  paths: [ ... ]   # the stream/transcript family is excluded
```

Run the plugin as a *build* plugin so the generated code is never committed and can never be stale. Vendor `openapi.yaml` into the iOS package via a git submodule or a one-line sync script in CI.

## Generated Client Vs. Hand-Written Seam

Two things resist generation, and they overlap:

1. **The NDJSON streams**, which need response headers (`x-agent-run-id`) read alongside a body consumed incrementally, plus status-specific branching on 400/404/409.
2. **Anything returning a `Session`**, because `Session.messages` is Pi's `AgentMessage` union — a discriminated union of five roles with heterogeneous content parts, defined by `@earendil-works/pi-agent-core` and never validated by a Zod schema on the way out. Expressing it in OpenAPI 3.0 would be an exercise in `oneOf` archaeology that breaks the next time Pi bumps a minor version.

So split on that line:

| Client | Covers | Endpoints |
| --- | --- | --- |
| Generated | Auth, bootstrap, users, models, provider configs, OAuth flows, agents, agent commands, files, tasks, extensions, session delete | 33 |
| Hand-written | Everything returning a `Session` (create, import, patch, fork, truncate, edit message, connection) and the two run streams plus abort | 7 |

The hand-written half is one file of ~250 lines sharing a single `AgentMessage` codec and one `URLSession` instance with the generated transport, so cookies, TLS trust, and the base URL are configured once. Do *not* attempt to route the transcript through `OpenAPIValueContainer` and re-decode — that is strictly more code than writing the seven calls.

### Day-One Spike

`swift-openapi-urlsession`'s support for incremental response bodies is the one assumption worth testing before the plan depends on it. Spike it in the first two days: point a generated client at `/api/agent-runs/{id}/events` declared as `application/x-ndjson` with `format: binary`, and check whether bytes arrive as they are produced or after the run ends.

If they arrive incrementally, `HTTPBody.asDecodedJSONLines(of:)` from `OpenAPIRuntime` gives framing for free and the hand-written half can shrink. If they buffer, the plan above stands unchanged. Either way that costs two days, not two weeks — and the recommendation is to keep the streams hand-written regardless, because of the headers.

## The Run Stream

This is the heart of the app, and `packages/client/src/lib/remote-agent.ts` is a precise, hard-won specification of it. Port its state machine faithfully; every branch in it exists because of a real failure mode.

### The Wire Format

One JSON object per line: `{"sequence": 41, "event": {...}}`. Sequences start at 1 and are strictly consecutive.

| Event | Payload | Client effect |
| --- | --- | --- |
| `message_start` | `message` | Seeds the streaming assistant message |
| `message_delta` | `contentIndex`, `field: text\|thinking`, `delta` | Appends to that content part; pad the array with empty text parts up to `contentIndex` |
| `message_part` | `contentIndex`, `part` | Replaces a whole part. Tool calls arrive this way, never as deltas |
| `message_end` | `message` | Authoritative message; append to history, clear the streaming buffer |
| `tool_execution_start` / `_end` | `toolCallId`, `toolName`, `isError` | Drives the spinner on the tool card |
| `turn_end` | `errorMessage?` | Shows a turn error |
| `context_pressure` | `level`, `message` | Persistent banner; survives run end |
| `run_recovered` | `message` | **Clears** the error a previous `turn_end` set, then shows a warning |
| `agent_end` | — | Not terminal. Persistence and title generation still follow |
| `run_finished` | — | **The only terminal event.** Refetch the session afterwards for the title |

Deltas are coalesced server-side on a 50 ms timer, so the client gets roughly 20 updates a second, not one per token. That is already the right cadence for SwiftUI — do not add a second layer of throttling, but do keep the streaming message out of the diffed history array so a delta re-renders one row.

### The State Machine

1. `POST /agents/{id}/run`. On **200**, capture `x-agent-run-id` and start consuming the body.
2. On **409**, a run is already live: `GET /sessions/{id}/connection`, adopt `activeRun.runId` and `activeRun.eventCursor`, and jump to step 4.
3. If the POST fails at the transport layer, the client does not know whether the run started. Poll `/connection` with backoff until it reports an `activeRun` (attach to it) or reports none (the prompt never landed; surface the error).
4. Watch loop: `GET /agent-runs/{runId}/events?after={lastSequence}`.
   - `404` — the run finalized. Stop, refetch the session.
   - `409` — replay gap. Re-read `/connection`, reset the cursor, retry.
   - `400` — cursor ahead of the run. Fatal client bug; do not retry.
   - `200` — consume. **A clean EOF without `run_finished` is not terminal** — reconnect.
5. Backoff on reconnect: 100 ms, doubling, capped at 2 s. Show a non-blocking "Reconnecting…" chip rather than an error.
6. Validate every envelope: `sequence == lastSequence + 1`, or throw and reconnect from the last good cursor. Silently accepting a gap corrupts the transcript.

### Why This Is A Gift On iOS

Runs live on the server, not in the connection. The cursor protocol means backgrounding the app, losing Wi-Fi, and force-quitting mid-run all reduce to the same recovery: on foreground, `GET /connection`, and if `activeRun` is non-null, resume from its cursor. No background URLSession, no keep-alive, no partial-state persistence. Build `scenePhase` handling on this from day one rather than bolting it on.

### Swift Shape

```swift
actor RunStream {
    struct Envelope: Decodable { let sequence: Int; let event: RunEvent }

    func events(runId: String, after: Int) -> AsyncThrowingStream<Envelope, Error> { ... }

    private func consume(_ request: URLRequest) async throws -> (String?, URLSession.AsyncBytes) {
        let (bytes, response) = try await session.bytes(for: request)
        let http = response as! HTTPURLResponse
        switch http.statusCode {
        case 200:  break
        case 400:  throw RunError.cursorAhead
        case 404:  throw RunError.runGone
        case 409:  throw RunError.replayGap
        default:   throw RunError.http(http.statusCode)
        }
        return (http.value(forHTTPHeaderField: "x-agent-run-id"), bytes)
    }
    // bytes.lines gives NDJSON framing directly — one JSONDecoder call per line.
}
```

`URLSession.AsyncBytes.lines` is exactly the framing NDJSON needs, which is the single reason this endpoint being NDJSON rather than SSE makes the client *simpler*. The run session must be a foreground `URLSession`; background sessions do not deliver incremental bodies.

## The Transcript Codec

One Swift file, and the highest-risk file in the app. It must decode Pi's message union from two sources that are *not* identical.

### The Subtlety That Will Bite

Messages from `GET /sessions/{id}/connection` pass through `serializeMessageForDisplay`: image parts are rewritten to `{type, mimeType, url}` pointing at the image endpoints, tool results are truncated to 8 000 characters, `details` is summarised, and `responseId`/`diagnostics` are stripped. Messages arriving on the **run stream** are raw Pi messages: images carry inline base64 `data` and tool results are complete.

So the same message renders one way while streaming and another after a reload. The image part must accept `data` or `url` (mirroring the web client's `imageSrc()`), and the tool-result view must not assume completeness. Worth an explicit test with both fixtures.

### Shape

```swift
enum AgentMessage {
    case user(UserMessage)                    // content: String | [ContentPart]
    case userWithAttachments(UserMessage)     // + attachments: [ChatAttachment]
    case assistant(AssistantMessage)          // + usage, stopReason, errorMessage
    case toolResult(ToolResultMessage)        // toolCallId, isError, content, details
    case artifact(ArtifactMessage)            // not rendered by the web client
    case unknown(role: String, raw: JSONValue)
}

enum ContentPart {
    case text(String)
    case thinking(String)
    case image(mimeType: String, data: String?, url: String?)
    case toolCall(id: String, name: String, arguments: JSONValue)
    case unknown(JSONValue)
}
```

Three rules for this file:

- **Never fail the decode.** An unrecognised role or part becomes `.unknown` and renders as a neutral placeholder. Pi is pinned at 0.83 today and will move; one new content part must not blank a transcript.
- **Round-trip losslessly.** Message editing sends content back to the server. Keep the raw JSON alongside the parsed form so an edit rewrites only the text part, exactly as `updateUserMessageContent` does.
- **Port the shared helpers verbatim.** `applyStreamingEvent`, `isEditableAssistantMessage`, `updateUserMessageContent`, `updateAssistantMessageContent`, and `resolveModelRef` live in `packages/shared` precisely because client and server must agree exactly. Port them with their tests, not from memory.

### Also To Port From `packages/shared`

- `resolveModelRef` and the Ollama defaults — needed for the model label, image support, and context window.
- The thinking-level rule from `pi-ai`: offer a level only if `thinkingLevelMap[level]` exists and is non-null; clamp the session's stored level into that set before displaying.
- `parseSlashCommand` and `skillCommandName` for the composer's command palette.
- Session sort order: pinned descending by `pinnedAt`, then by `updatedAt` descending.

## App Architecture

Swift 6 language mode, strict concurrency on from the first commit — retrofitting it onto a streaming app is miserable.

```text
CarmelAgent/                 App target: scenes, intents, extensions host
  CarmelKit/                 Package (multiplatform, no UIKit)
    CarmelAPI/               Generated client + openapi.yaml (build plugin)
    CarmelTranscript/        AgentMessage codec, streaming fold, shared-helper ports
    CarmelStream/            RunStream actor, reconnect state machine
    CarmelStore/             Server registry, Keychain, bootstrap cache, models
  CarmelUI/                  SwiftUI views, shared across app + extensions
  Extensions/
    ShareExtension/          Share text, images, files into a session
    WidgetExtension/         Widgets + Live Activity UI
    IntentsExtension/        App Intents / Shortcuts
```

### State

- **`ServerConnection`** (actor, one per configured server) — base URL, `URLSession` with its own cookie storage and TLS delegate, generated client, hand-written client. Multiple servers are a first-class concept; self-hosters routinely run a LAN one and a remote one.
- **`BootstrapStore`** (`@Observable`) — the mirror of the web app's Zustand store. `GET /bootstrap` on launch and after any mutation that returns a fresh payload. Users, agents, provider configs, model refs, model catalog, session metadata.
- **`SessionRuntime`** (one per open session, `@Observable`) — transcript, streaming message, pending tool call ids, run state, context pressure, error. This is `RemoteAgent`. Keep `streamingMessage` a separate property from `messages` so a delta invalidates one view.
- **Persistence** — SwiftData or a small GRDB store caching bootstrap and the last N transcripts, for instant cold launch and read-only offline. The server stays authoritative; the cache is never written back.

### Networking Details That Matter For Self-Hosted

- **Cookies** — a per-server `HTTPCookieStorage` (grouped container) so two servers cannot collide. Mirror the session cookie into the Keychain so relaunch does not force a login; restore it before the first request.
- **TLS** — assume self-signed certificates and plain HTTP on a LAN. Handle it explicitly rather than blanketing ATS: allow `http` only for local networking (`NSAllowsLocalNetworking`), and for an untrusted certificate show a one-time fingerprint prompt, then pin the SPKI hash in the Keychain for that server. Never accept an arbitrary certificate silently.
- **Local network permission** — declare `NSLocalNetworkUsageDescription`; connecting to `192.168.x.x` triggers the prompt on iOS 14+.
- **No `Origin` header.** Add a lint or a test asserting the app never sets one.

## Navigation And HIG

The web app is a resizable sidebar with two tabs (Sessions / Files), a header, a chat pane, and modal dialogs for agent settings and message editing. That maps cleanly, but "translate the layout" is the wrong instinct — translate the *information hierarchy*.

### iPad — Three-Column `NavigationSplitView`

- **Sidebar** — agent picker at top, then sessions (pinned section first). Files move out of this column entirely.
- **Content** — the session list when an agent is selected, or the file browser when the Files tab is active.
- **Detail** — the chat, or the file viewer/editor.
- Multiple windows (one session per window), drag and drop of images and files into the composer, hardware-keyboard shortcuts, and pointer hover states. Stage Manager sizes must not break the composer.

### iPhone — `NavigationStack` With A Bottom Tab Bar

- Tabs: **Chats**, **Files**, **Tasks**, **Settings**. The web app hides Files and Tasks behind a sidebar tab and an agent-settings dialog respectively; on iPhone they deserve to be top-level, because on a phone you are far more likely to check a scheduled task's outcome than to edit an agent's mounts.
- Agent switching is a menu on the Chats navigation title, not a persistent row.
- Chat is a single scroll view with the composer pinned in a `safeAreaInset(edge: .bottom)` — the native equivalent of the visual-viewport keyboard dance in `packages/client/src/lib/viewport.ts`, which can then be dropped rather than ported.

### Composer

The one place to deviate deliberately from the web app. Web sends on Enter with a desktop pointer and inserts a newline on touch; on iOS, Return always inserts a newline and a send button commits — with `⌘↩` as the hardware-keyboard shortcut. Attachment source is a menu (Photos / Camera / Scan Document / Files), gated on `currentModel.input.contains("image")` exactly as the web app gates the paperclip. Enforce the same limits: 10 images, 20 MB each.

### Non-Negotiables

- Dynamic Type through XXL, including code blocks (monospaced, scaled, horizontally scrollable).
- VoiceOver: tool call cards announce name plus state; the streaming message is a live region that does not re-announce on every delta.
- Reduce Motion honoured by the streaming cursor and any transitions.
- Theme follows the system, with an explicit Light/Dark/System override in Settings to match the web app's Appearance section.

## Feature Parity Matrix

Everything the web client does, and where it lands. Nothing here is optional for the parity goal.

| Area | Web feature | iOS surface | Notes |
| --- | --- | --- | --- |
| Chat | Send text, streaming reply | Chat detail | See The Run Stream |
| Chat | Markdown + syntax-highlighted code | Custom renderer | `AttributedString` markdown is not enough (tables, code fences). Use `swift-markdown` plus a highlighter; needs a copy button per block |
| Chat | Collapsible thinking blocks | `DisclosureGroup` | Auto-expanded while streaming, collapsed after, as on web |
| Chat | Tool call cards: input, output, images, Running/Complete/Error | Expandable card | JSON pretty-printed; long output scrolls, not truncates |
| Chat | Image attachments in and out | PhotosPicker / camera / scanner | 10 files, 20 MB, base64 on the wire |
| Chat | Image lightbox with zoom | Zoomable full-screen cover | |
| Chat | Usage / cost footer, abort and error states | Message footer | `.monospacedDigit()` |
| Chat | Context pressure banner, run recovered | Inline banner | Persists past run end; cleared on next run |
| Chat | Abort a run | Stop button | 404 on abort is success |
| Conversation | Fork from a message | Message context menu | 409 with `safeEntryId` when the cut point is invalid — offer to fork there instead |
| Conversation | Edit user message (+ remove images) | Edit sheet | `removedImageIndexes` / `removedAttachmentIds` |
| Conversation | Edit assistant message | Edit sheet | Only when it has text and no tool calls |
| Conversation | Retry from a message | Context menu | Edit with `truncate: true`, then run |
| Conversation | Truncate a branch | Context menu | Same 409 cut-point rule |
| Conversation | Copy message | Context menu | |
| Sessions | List, pin, sort, rename, delete | Sidebar / Chats tab | Swipe actions; pinned section |
| Sessions | Create session | Toolbar + | Inherits agent default model and thinking level |
| Sessions | Fork lineage badge | Row subtitle | `forkedFrom` |
| Sessions | Switch model mid-session | Composer menu | Grouped by provider, as in `ModelCommandDialog` |
| Sessions | Import Open WebUI JSON | Files importer | Whole JSON goes in the request body; warn on large exports |
| Agents | Select, create, delete | Agent menu | |
| Agents | Settings: name, description, sharing, system prompt, prompt templates | Form | Must fetch `/agents/{id}/settings`; the list payload is redacted |
| Agents | Permissions: read / write / edit / bash / network | Toggles | Explain the consequence under each, as the web app does |
| Agents | Working dir mode + extra mounts | Form | Host paths are admin-only (`assertAgentHostPathAccess`) — hide for non-admins |
| Agents | Enabled extensions | Admin section | From `GET /extensions`; admin-only to read and to set |
| Skills | Slash command palette | Composer `/` sheet | `GET /agents/{id}/commands`, refetched on open |
| Skills | Prompt templates as commands | Same palette | Inserts the template body |
| Skills | Skill invocation rendering | Collapsible user bubble | Port `parseSkillInvocation` |
| Files | Browse workspace, toggle hidden | Files tab / iPad column | Directories first, then case-insensitive name |
| Files | View and edit text files | Editor | 4 MiB cap, binary rejected. No drop-in CodeMirror — see Risks |
| Files | Image preview | Inline | `/files/raw`, 32 MiB cap |
| Files | Create, rename, delete | Context menu | Hide actions the agent's permissions forbid; the server enforces 403 anyway |
| Tasks | List, create, edit, pause, delete | Tasks tab | cron / interval / once + timezone |
| Tasks | Run now | Row action | Returns `{outcome, detail}` |
| Tasks | Run history, next/last run, last error | Task detail | Colour-code `succeeded` / `failed` / `missed` / `skipped` |
| Settings | Model entries: add, edit, share, delete | Settings → Models | Including `thinkingLevelMap`, context window, max tokens |
| Settings | Browse provider's model catalog | Picker with refresh | `GET /provider-configs/{id}/models?refresh=true` |
| Settings | Provider configs (admin) | Settings → Providers | API key write-only; the server returns `hasApiKey`/`hasOAuth` only |
| Settings | Provider OAuth login (admin) | Guided flow | See below |
| Settings | Users (admin): create, role, reset password, delete | Settings → Users | |
| Settings | Account: email, password, fast task model, theme | Settings → Account / Appearance | |
| Onboarding | First-run admin setup | Setup screen | `GET /auth/status` → `needsSetup` |
| Onboarding | Login / logout | Server list → login | 429 after 5 failures |

### The OAuth Flow Deserves A Design Pass

`useProviderOAuth` starts a flow, opens `auth.url` in a new tab, then polls `GET /oauth/flows/{id}` every second while the state machine walks `pending → auth → input → success`, prompting for a code, a manual paste, or a selection depending on `prompt.kind`.

On iOS this becomes an `ASWebAuthenticationSession` (or a Safari view for the device-code case) plus a sheet driven by the polled state, with the manual-code field pre-filled from the clipboard. It is admin-only and easy to defer, but do not forget it — without it, an admin cannot log a provider in from the phone.

## iOS Platform Features

Ordered by value-per-effort. The first two are what make the iOS client genuinely better than the web app on a phone, rather than merely equal to it.

### Live Activity For An In-Flight Run

The single best fit. Runs are server-side, long, and multi-stage, and the event stream already reports the stage: which tool is executing, whether the model is thinking, whether the turn errored. A Live Activity on the Lock Screen and in the Dynamic Island showing the agent name, elapsed time, and current tool — ending on `run_finished` — is exactly the interaction the web app cannot offer. It needs no server change: the app updates it locally while it holds the stream, and refreshes on foreground via `/connection`.

### Run-Finished Notifications

A local notification scheduled when the app backgrounds during a run, plus a `BGAppRefreshTask` that polls `/connection` (and, for scheduled tasks, `/agents/{id}/tasks`) and notifies on completion or failure. Best-effort by nature — iOS decides when background refresh runs. Real push needs a server change; ship the local version first and treat APNs as the follow-up it deserves to be.

### Share Extension

Share text, a URL, an image, or a file from any app into a chosen agent and session — either appending to the composer or sending immediately. For a coding agent this is the highest-traffic entry point on a phone.

### App Intents, Shortcuts, Siri

- *Ask &lt;agent&gt;* — parameterised intent that creates a session, prompts, and returns the reply. Composable in Shortcuts and automations.
- *Run task &lt;name&gt;* — wraps `POST /agents/{id}/tasks/{taskId}/run`.
- Spotlight indexing of sessions via `CSSearchableItem`, so a transcript is findable from the home screen.

### Widgets

A scheduled-task status widget (next run, last outcome), a recent-sessions widget, and a Control Center / Lock Screen control that opens a new session with a chosen agent.

### Capture And Files

- Camera and `VisionKit` document scanner as attachment sources — scan a whiteboard or a page of code and hand it to the agent.
- Quick Look for workspace files the in-app editor will not open; document picker to export a file out or import one in.
- **Optional, ambitious** — a File Provider extension exposing the agent workspace inside Files.app. Large, and worth it only once the rest ships.

### Security And Continuity

- Face ID / Touch ID app lock, with credentials in the Keychain behind biometry so a 30-day cookie expiry does not mean retyping a password on a phone.
- Handoff (`NSUserActivity`) so a session open on iPad continues on iPhone, and vice versa.
- Multiple servers with per-server credentials, TLS pins, and cookie jars.

### iPad-Specific

Multi-window scenes, drag and drop into the composer, the full hardware-keyboard shortcut set (`⌘N` new session, `⌘K` commands, `⌘↩` send, `Esc` abort), pointer hover states, and Stage Manager resilience.

## Optional Server Changes

**None of these block v1.** The app can ship against the server exactly as it stands today. Listed in the order worth doing them.

| Change | Why | Size |
| --- | --- | --- |
| `openapi.yaml` + a route-coverage test | Removes the whole class of "generated client compiles but 404s". Benefits any future client, not just iOS | M |
| APNs device registration + push on run/task completion | Turns best-effort background polling into a real notification. Needs a device-token table and a sender; the run lifecycle already has the exact hook (`finishAgentRun`) | M |
| Transcript pagination on `/sessions/{id}/connection` | Today a long session is one large JSON body with no windowing. Fine on a laptop; not on a phone on cellular. A `?limit`/`?before` tail would fix cold-open time and memory | M |
| Per-device API tokens alongside cookies | Lets a user revoke one device without logging out everywhere, and removes the cookie-jar bookkeeping from the client | S |
| `GET /sessions/{id}` (metadata only) | Currently metadata comes only from `/bootstrap`; a widget or intent that wants one session has to fetch everything | S |
| Bonjour / mDNS advertisement | Turns "type an IP and port" into picking a server from a list on the LAN | S |

## Delivery Phases

Sequenced so the riskiest unknown is settled in week one and each phase ends at something usable. Sizes assume one experienced iOS engineer.

### Phase 0 — Spike (3–5 days)

A throwaway app that logs in, reads `/bootstrap`, and streams one run end to end. Hand-authored `openapi.yaml` for six endpoints only. Verifies cookie auth through `URLSession`, mutations passing `rejectCrossOriginMutations` with no `Origin`, incremental NDJSON delivery, and whether `swift-openapi-urlsession` streams or buffers.

**Exit** — tokens visibly appearing on a device, against a real server.

### Phase 1 — Contract And Foundations (1.5–2 weeks)

Full `openapi.yaml` plus the Zod emitter and the route-coverage test in the server repo. Generated client building via the build plugin. `ServerConnection`, Keychain, TLS trust prompt, multi-server registry. App shell: setup, login, split view, session list, agent picker, theme.

**Exit** — you can add a server, log in, and browse sessions. No chat yet.

### Phase 2 — Chat Core (2–3 weeks)

The heart. Transcript codec with fixtures from both sources, `RunStream` actor and its full reconnect state machine, streaming fold, markdown and code rendering, tool call cards, thinking blocks, images, usage footer, abort, context pressure, background/foreground resume.

**Exit** — a run survives airplane-mode toggling and an app kill mid-stream, and resumes with an intact transcript.

### Phase 3 — Conversation Control (1–1.5 weeks)

Fork, edit user and assistant messages, image removal, retry, truncate (with the 409 `safeEntryId` path), pin, rename, delete, attachments from all four sources, model switching, slash-command palette.

**Exit** — chat parity with the web app.

### Phase 4 — Agents, Files, Tasks (2–2.5 weeks)

Agent settings form including permissions, mounts, prompt templates, and the admin-gated fields. File browser, viewer, editor, create/rename/delete, image preview. Task list, scheduling form, run-now, run history.

**Exit** — everything except Settings is reachable on device.

### Phase 5 — Settings And Admin (1–1.5 weeks)

Model entries and the provider catalog picker, provider configs, the OAuth login flow, user administration, account, appearance, extensions. Role-gating audited across the app.

**Exit** — full feature parity. This is the shippable milestone.

### Phase 6 — Platform Features (1.5–2 weeks)

Live Activity, share extension, App Intents and Shortcuts, widgets, local notifications and background refresh, Handoff, Spotlight, iPad multi-window, keyboard shortcuts, biometric lock.

**Exit** — the app is better on a phone than the web app is.

### Phase 7 — Polish And Ship (1–2 weeks)

Accessibility audit, Dynamic Type at every size, long-transcript performance, memory under large images, error copy review, TestFlight, App Store metadata.

**Exit** — submitted.

**Total: 11–15 weeks.** Phases 5 and 6 are the ones to cut or defer under time pressure — they are broad rather than deep, and mostly forms. Phase 2 is the one that must not be rushed.

## Testing

- **Recorded stream fixtures.** Add a script to this repo that captures real NDJSON from a run (text-only, tool-heavy, thinking-heavy, error, abort, compaction) into `fixtures/`. Both the server's protocol tests and the Swift stream tests then replay the same bytes. This is the highest-leverage test asset in the project.
- **Stream state machine.** Swift Testing over a stub transport that can inject a gap, a 409, a 404, a mid-line EOF, and a socket drop. Assert that no gap is ever accepted, that `run_finished` is the only terminal event, and that reconnect always resumes at exactly `lastSequence + 1`.
- **Codec round-trips.** Decode both the display-serialized and raw forms of the same message; assert an edit rewrites only the intended field.
- **Contract drift.** The server-side route-coverage test, in CI on every push.
- **Snapshot tests** for message rendering in light and dark, at default and XXL Dynamic Type.
- **One XCUITest** covering login → send → kill network mid-run → restore → intact transcript. It is the regression that matters most and the one unit tests cannot cover.

## Risks And Open Questions

| Risk | Mitigation |
| --- | --- |
| `swift-openapi-urlsession` buffers streaming responses | Settled in the Phase 0 spike; the plan already keeps both streams hand-written on `URLSession.bytes`, so a negative result costs nothing |
| Pi's message shape changes on a version bump (pinned at 0.83 today) | `.unknown` cases in the codec; never fail a decode. Fixtures regenerated against each Pi bump |
| No CodeMirror equivalent for the file editor | Ship read-only syntax highlighting plus a plain monospaced `UITextView` editor first. Full editing affordances are a later, separable project; the web app remains available for heavy editing |
| Whole-transcript fetch on open | Cache locally, render windowed, show the tail immediately. Pagination is the real fix if long sessions become common |
| Self-signed TLS is the norm for self-hosters | Explicit fingerprint-confirmation flow with a Keychain-pinned SPKI, plus a local-networking ATS exception. Never a blanket "accept all" |
| Admin surfaces leaking to non-admins | Role comes from the bootstrap user; gate at the navigation level, and rely on the server's 403s as the backstop. Cover in the snapshot tests |

### Open Questions

1. **Where does the iOS code live?** Recommended: this repo under `ios/`, so the spec and its drift test sit next to the server they describe. A separate repo means vendoring the spec and losing that guarantee.
2. **Distribution** — App Store, or TestFlight/sideload? It affects nothing architecturally, but an App Store build wants the OAuth flow, a privacy manifest, and a story for "what is this app without a server".
3. **Minimum iOS version.** The plan assumes 18. Dropping to 17 costs some `@Observable` and Control-widget conveniences; dropping to 16 costs Live Activities' best behaviour.
4. **Is the admin surface in scope for v1?** Provider configs, user management, and extensions are ~1–1.5 weeks of forms that a single-user self-hoster configures once, from a desktop. Cutting them is the cheapest way to pull the timeline in, at a real cost to the "every feature" goal.
