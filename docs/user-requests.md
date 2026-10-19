# Questions and session credentials

Interactive session agents have two direct tools: `ask_user_question` and, when bash is enabled, `request_secret`. They run outside Codemode and must be the only tool call in their turn. If a model combines a request with other tools, those tools are skipped and the model is told to retry the request alone. Issue attempts keep their existing `report_issue` / `needs_input` workflow instead.

`ask_user_question` accepts a question, up to seven choices with stable IDs and optional descriptions, single or multiple selection, and optional free text. Validated answers enter the transcript and model context as a response associated with the request ID. Declines and expiry produce an explicit receipt. Agents are instructed not to repeat declined requests without a new user instruction.

## Waiting and continuation

Requests live in metadata storage with their session, native conversation and tool-call identities. Tool replay finds the same request. The request tool returns a safe receipt and Durable's termination control; the run ends and releases its resources while the human considers the form.

Requests survive refreshes and server restarts. A pending request gates new prompts and transcript edits/forks so its answer cannot be attached to a different branch. Requests expire after seven days; session credentials do not expire with their request.

Answering stores the answer and a pending delivery receipt before attempting continuation. The client starts a run without a new prompt. Carmel submits the saved receipt using the stable native request ID `user-request:<request-id>` and acknowledges delivery after native admission. A crash between those writes retries the same submission instead of creating another turn. If continuation cannot start, the card retains **Continue agent**. Read-only reconnects never start work automatically.

## Secret submission

`request_secret` accepts an environment-variable name and a reason, never a credential value. An available credential returns only its ID, name and scope. `replaceExisting: true` requests a different session credential even when an agent default exists.

The password form submits directly to `/api/sessions/:id/requests/:requestId/secret`. Its value exists only in component memory until submission; it bypasses the composer, persistent client drafts, conversation submissions, request records and run events. This endpoint validates without echoing payloads, returns only metadata, and disables response caching.

New session credentials require `CARMEL_SECRET_KEY`. The server encrypts untrusted values with AES-256-GCM, even when the submitted string begins with the internal ciphertext prefix. Without the key, the write fails and the request stays pending. Preserve this key with backups; changing it makes existing values unreadable. Existing agent-settings credentials retain their existing storage policy.

The model receives only an availability receipt, an environment-variable name and an opaque secret reference. It uses `$GITHUB_TOKEN` in bash without needing the literal key. Ordinary answers and safe receipts can appear in transcript exports; form submission never puts credential values there.

## Scope and promotion

Credentials provided through chat default to the current session. They survive restarts and are deleted with that session. Forking or referencing a session does not copy its credentials. Each command resolves agent defaults plus current-session credentials; a session value overrides an agent default of the same name. Values are injected into command processes, never baked into long-lived container configuration. Configured MCP connections resolve the same scope when a run starts.

The agent can call `promote_secret({ secretRef })` when future-session reuse fits the user's intent. Promotion updates the same encrypted record to agent scope, preserving its reference. It is idempotent and refuses name collisions. No extra approval is needed for reuse the user already authorized. Future sessions can discover the credential metadata and use it; agent settings lists it alongside other agent credentials.

Cards also provide promotion, return-to-session-scope, and revocation controls. Demotion removes availability from other sessions and refuses name collisions. Revocation affects future executions, not processes already running. Agent-level credentials survive deletion of the session that supplied them.

Only the session owner can provide its credentials. Promotion, demotion, and management of agent-level credentials additionally require ownership of the agent. A shared agent carries agent-level credentials to everyone allowed to run it; non-owner runners cannot promote into it.

## Shell trust boundary

Session scope controls selection and injection, not operating-system isolation. Containers, workspaces and browsers remain shared per agent. Arbitrary shell code receiving a key can print, encode, copy or transmit it through files or background processes.

Shell output is redacted before streaming and spill-file persistence. Session tools also redact known values from text results, structured results, details, diagnostics and errors before Durable commits them. This prevents common accidental disclosures, including chunked output, but cannot guarantee secrecy against transformations, binary output or deliberate exfiltration. Values shorter than four characters retain the existing redaction policy and are not matched.

A strict guarantee that models and agent code can never access a credential value requires a separate broker with constrained destinations, operations and responses. Environment injection intentionally grants the shell access to the value.
