# Questions and session credentials

Interactive session agents have two direct tools: `ask_user_question` and, when bash is enabled, `request_secret`. They run outside Codemode. Both are sequential, so in a round with other calls, the calls before the request run first and the calls after it wait for the response. Issue attempts keep their existing `report_issue` / `needs_input` workflow instead.

`ask_user_question` accepts a question, up to seven choices with stable IDs and optional descriptions, single or multiple selection, and optional free text. A validated answer becomes the result of the tool call that asked, and the chat shows it there as a receipt. Declines and expiry produce the same kind of result. Agents are instructed not to repeat declined requests without a new user instruction.

## Waiting and continuation

Requests live in metadata storage with their session, native conversation and tool-call identities. Tool replay finds the same request. The tool call parks on Durable's `carmel.user-request` signal, with the request's expiry as its deadline. A parked call holds no process, so Carmel's run ends and releases its resources while the human considers the form; the native run stays open and the chat shows the request card instead of Resume.

Requests survive refreshes and server restarts. A pending request gates new prompts and transcript edits/forks so its answer cannot be attached to a different branch. Requests expire after seven days; session credentials do not expire with their request.

Answering stores the answer and marks its delivery pending before attempting continuation. The client starts a run without a new prompt. Carmel delivers the signal to the parked call and resumes the conversation; the call reads the response from the request record, returns it as its result, and marks delivery submitted. The signal carries only how the request ended, never an answer or credential. A crash after the signal is kept delivers it again as a duplicate, and an early signal wakes a call whose park was not stored yet. If continuation cannot start, the card retains **Continue agent**. Read-only reconnects never start work automatically.

Stopping a parked run cancels the call, which declines its request; nothing is left to deliver. An expired request wakes its call at the deadline the next time the conversation runs. Requests made before calls parked had ended their run; their response is still submitted as a new input with the request ID `user-request:<request-id>`.

## Secret submission

`request_secret` accepts an environment-variable name and a reason, never a credential value. An available credential returns only its ID, name and scope. `replaceExisting: true` requests a different session credential even when an agent default exists.

The password form submits directly to `/api/sessions/:id/requests/:requestId/secret`. Its value exists only in component memory until submission; it bypasses the composer, persistent client drafts, conversation submissions, request records and run events. This endpoint validates without echoing payloads, returns only metadata, and disables response caching.

New session credentials require `CARMEL_SECRET_KEY`. The server encrypts untrusted values with AES-256-GCM, even when the submitted string begins with the internal ciphertext prefix. Without the key, the write fails and the request stays pending. Preserve this key with backups; changing it makes existing values unreadable. Existing agent-settings credentials retain their existing storage policy.

The model receives only an availability receipt, an environment-variable name and an opaque secret reference. It uses `$GITHUB_TOKEN` in bash without needing the literal key. Ordinary answers and safe receipts can appear in transcript exports; form submission never puts credential values there.

## Scope and promotion

Credentials provided through chat default to the current session. They survive restarts and are deleted with that session. Forking or referencing a session does not copy its credentials. Each command resolves agent defaults plus current-session credentials; a session value overrides an agent default of the same name. Values are injected into command processes, never baked into long-lived container configuration. Configured MCP connections resolve the same scope when a run starts.

The agent can call `promote_secret({ secretRef })` when future-session reuse fits the user's intent. Promotion updates the same encrypted record to environment scope, preserving its reference, so every agent in the environment can use it. It is idempotent and refuses name collisions. No extra approval is needed for reuse the user already authorized. Future sessions can discover the credential metadata and use it; **Agent Settings → Environment** lists it alongside the environment's other secrets.

Cards also provide promotion, return-to-session-scope, and revocation controls. Demotion removes availability from other sessions and refuses name collisions. Revocation affects future executions, not processes already running. Agent-level credentials survive deletion of the session that supplied them.

Only the session owner can provide its credentials. Promotion, demotion, and management of agent-level credentials additionally require ownership of the agent. A shared agent carries agent-level credentials to everyone allowed to run it; non-owner runners cannot promote into it.

## Shell trust boundary

Session scope controls selection and injection, not operating-system isolation. Containers, workspaces and browsers remain shared per environment. Arbitrary shell code receiving a key can print, encode, copy or transmit it through files or background processes.

Shell output is redacted before streaming and spill-file persistence. Session tools also redact known values from text results, structured results, details, diagnostics and errors before Durable commits them. This prevents common accidental disclosures, including chunked output, but cannot guarantee secrecy against transformations, binary output or deliberate exfiltration. Values shorter than four characters retain the existing redaction policy and are not matched.

A strict guarantee that models and agent code can never access a credential value requires a separate broker with constrained destinations, operations and responses. Environment injection intentionally grants the shell access to the value.
