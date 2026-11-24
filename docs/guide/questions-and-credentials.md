# Questions and credentials

Sometimes an agent needs something only you can provide: a decision between options, or a credential such as an API token. Instead of asking in plain chat, it can show you a private form.

## Questions

When an agent calls `ask_user_question`, a card appears in the conversation with the question, up to seven choices (single or multiple selection), and optionally a free-text field. Your answer becomes the result of the agent's request, and the chat shows it as a receipt.

You can also decline. Agents are instructed not to repeat a declined request unless you ask again.

## Providing a credential

When the agent's **Run commands** permission is on, it can call `request_secret` to ask for a credential by environment-variable name, such as `GITHUB_TOKEN`, with a reason. A password form appears in the chat.

The value you type goes straight to the server. It never passes through the message composer, drafts, the conversation transcript, or the model. The agent only learns that the credential is available and uses it as an environment variable — for example `$GITHUB_TOKEN` in a command.

::: info Requires an encryption key
New credentials are encrypted with the server's `CARMEL_SECRET_KEY`. If the server has no key, the form cannot be submitted and the request stays pending.
:::

## Where a credential applies

Credentials you provide through chat apply to **the current session** by default. They survive restarts, are deleted with the session, and are not copied when you fork or reference the session.

To reuse one in future sessions, **promote** it — from the card, or by letting the agent call `promote_secret` when that fits what you asked for. Promotion moves the credential to the agent's environment, where every agent in that environment can use it, and it appears in **Agent Settings → Environment** with the other secrets.

Cards also let you return a credential to session scope or revoke it. Revoking affects future commands, not processes that are already running.

| Action           | Who can do it                                                                    |
| ---------------- | -------------------------------------------------------------------------------- |
| Provide          | The session's owner.                                                             |
| Promote / demote | The session's owner, who must also own the agent.                                |
| Revoke           | The session's owner; environment-level credentials also require agent ownership. |

When a session credential and an environment secret share a name, the session value wins for that session's commands.

## Waiting for you

While a question or credential request is open, the agent's run pauses without holding any resources, and the chat shows the request card. You can take your time — requests survive reloads and server restarts, and expire after seven days.

You cannot send new messages or edit the conversation while a request is pending, so your answer always lands on the right branch. If continuing fails after you answer, the card offers **Continue** to try again. Stopping the run declines the request.

## Security boundaries

Session scope controls which credentials are injected into which commands. It is not operating-system isolation: the container, workspace, and browser are still shared across the environment, and shell code that receives a value can print, copy, or transmit it.

Carmel Agent redacts known values from command output and tool results before they are saved or shown, which prevents common accidents. It cannot stop deliberate exfiltration by code that has the value. See the [Security model](/reference/security#environment-secrets).
