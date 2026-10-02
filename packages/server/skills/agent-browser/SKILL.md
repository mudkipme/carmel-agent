---
name: agent-browser
description: Use Carmel's shared sandbox browser to navigate websites, interact with forms, inspect pages, and test web apps. Use when a task needs browser interaction or a person must sign in or complete verification in the Browser pane.
---

# Browser use in Carmel

`agent-browser` and Chromium are already installed in the sandbox. Run commands
through `bash`. Carmel provides the live Browser pane and coordinates human
control through the `request_browser_help` tool.

## The shared browser

- Use `agent-browser --session carmel` for every browser command. Do not create
  another session or override the profile for ordinary browsing: the Browser pane
  shows this session.
- The profile belongs to the **agent**. Tabs, cookies, and saved sign-ins are
  intentionally shared across its conversations and users. Reuse the existing
  sign-in when it fits the task; check the active account before account-specific
  work. Ask before switching accounts or signing out if the user's intent is unclear.
- Keep automation in foreground tool calls. Background scripts cannot pause for
  a human handoff. Do not run a competing browser while a person is helping.
- Leave the browser open when asking for help and after ordinary work. Carmel
  owns its lifetime. Do not start an agent-browser dashboard, expose debugging
  ports, or ask the user to connect to the sandbox directly.

## Observe, act, verify

Start by inspecting the current page if continuing an existing task. For a new
destination, open the URL, then take an interactive snapshot:

```bash
agent-browser --session carmel open https://example.com
agent-browser --session carmel snapshot -i
```

Use the element refs from that snapshot, for example:

```bash
agent-browser --session carmel click @e3
agent-browser --session carmel fill @e5 "search terms"
agent-browser --session carmel press Enter
agent-browser --session carmel snapshot -i
```

Refs are examples, not reusable selectors. Take a new snapshot after navigation,
substantial page changes, or any human handoff. If an element is missing or stale,
inspect again instead of repeating the same action. Prefer a specific wait such
as `wait --text "Results"` or `wait --url "**/dashboard"` over a fixed sleep.
Use `get url`, `get text @e3`, or a screenshot when needed to verify the result.
Save screenshots/downloads needed by the user in the workspace.

For less common commands, consult the installed CLI's version-matched help:

```bash
agent-browser --help
agent-browser skills get core
```

Those upstream docs describe standalone use too. Keep Carmel's `carmel` session,
persistent profile, foreground execution, and human-handoff workflow when using
their command examples; installation, separate profiles, local headed windows,
auth-vault credential collection, and `close` examples are not needed here.

## When to ask a person to take over

Continue ordinary navigation and authorized form work yourself. Hand off when
progress needs something only the person can provide: sign-in credentials,
MFA/one-time codes, a CAPTCHA or verification challenge, account selection that
you cannot infer, or a browser step the user explicitly wants to perform.
Do not hand off merely because an element ref expired or a page is still loading.
Human handoff does not authorize an unrelated purchase, submission, or account change.

1. Leave the relevant page or login popup open in the `carmel` session. Briefly
   explain what is needed and direct the user to **Browser → Take control**.
   For a shared agent, make clear that signing in makes that account available to
   the agent and its shared users. Never ask for passwords or one-time codes in chat.
2. Call `request_browser_help` **directly**, outside `codemode` and outside `bash`.
   For example, pass `{"reason":"Please sign in to Example in the Browser pane, then select Resume agent."}`.
   Do not put credentials in the reason. This is a tool call, not a CLI command.
3. The tool waits while Carmel pauses new agent tools and lets existing calls
   finish. The user takes control, interacts with the live page, and chooses
   **Resume agent**. Do not poll for credentials, run parallel browser commands,
   or replace this wait with repeated screenshots or chat questions.
4. When the tool returns, inspect its fresh snapshot and confirm the requested
   state (for example, the intended account's dashboard). If it could not obtain
   a snapshot, take one. Discard all old refs and pending actions. Resume only
   the work still appropriate for the current page. If access is still blocked,
   explain what remains and request help again rather than retrying sign-in indefinitely.

The user can also take control without an agent request. If a tool returns a
handoff interruption, it was not executed: inspect the page and reconsider the
action. Closing the pane or disconnecting does not resume automation; the user
must reclaim control and select **Resume agent**. If the user cancels the task,
stop rather than treating cancellation as a successful sign-in.
