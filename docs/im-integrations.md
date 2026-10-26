# Private messaging integrations

Open **Agent settings → Integrations** to connect Telegram, Feishu, or Lark. Connections belong to the combination of the current user and the selected agent. A shared agent's users each connect their own dedicated bot; their credentials, paired sender, conversation, and notification destination are separate.

Set a stable `CARMEL_SECRET_KEY` before connecting. IM setup refuses to store credentials without encryption, including in development. Preserve this key with backups. Credentials stay on the server and never enter agent prompts, sandbox environments, or bootstrap responses.

The server receives Telegram updates by long polling and Feishu/Lark events over WebSockets. Only outbound connectivity is required; no public webhook or inbound tunnel is needed. The integrations run in the Carmel server, independently of the agent's sandbox network permission. Run one Carmel server process per database.

## Telegram

1. Create a dedicated bot with **@BotFather** in Telegram.
2. Select **Connect Telegram** and enter its bot token.
3. Select **Open bot**, then send the `/start` command carried by the link. Alternatively, send the displayed `/pair` command.

The one-time token expires after ten minutes. Carmel binds the numeric sender and private chat IDs, so changing a username does not change access. Other senders and all group messages are ignored. One bot cannot serve multiple Carmel integrations. Remove any previous webhook and stop other polling processes before connecting; Carmel does not silently take over another application's bot.

## Feishu and Lark

Select **Scan QR code**, scan with the mobile app, and approve creation of the personal bot. Carmel performs the `PersonalAgent` registration flow, captures the credentials on the server, and follows the Feishu-to-Lark tenant-brand switch when needed. The browser receives the verification link and setup status, never the device code or app secret.

After registration, open the bot and send the displayed `/pair` command from your own account. This final step verifies the actual person sending messages. The registration response's `open_id` can identify the bot itself and is not used as a sender allowlist.

If QR registration is unavailable in your tenant, choose **Use existing app** and enter its App ID and App Secret. In the platform's developer console:

- Enable the bot capability and publish the app to the intended users.
- Grant permission to receive private messages, send bot messages, and retrieve message resources for image input.
- Subscribe to `im.message.receive_v1` using **long connection** mode.

QR provisioning may preconfigure these capabilities, but tenant approval, app publication, and availability policies can still require action. Connection errors appear in Integrations. Cancelling setup discards local registration secrets; it does not delete an app already created at Feishu/Lark.

## Conversations

Send text or an image in the paired private chat. Telegram, Feishu/Lark, and the web share your private **Home** conversation with this agent. Messages contribute to the same context and appear in Home on the web. Each IM reply returns to its originating integration; ordinary web replies are not broadcast to IM. Replies use the durable output queue; thinking and raw tool output are never sent.

Existing integrations adopt one of their current conversations as Home. Carmel prefers the default notification integration's valid conversation, then the most recently updated valid conversation. Other conversations remain in Sessions. Accepted older inputs retain their original destination; migration does not merge transcripts or resend queued deliveries.

Images are limited to 10 MB each and five per message. Files, voice, video, group conversations, and shared bots are outside this version's scope.

Commands:

- `/new`: begin a fresh Home model context while retaining history, saved memory, and background jobs. Finish or stop the current reply and pending inputs first.
- `/stop`: stop the Home reply and clear pending Home user messages across web and IM. Issue jobs and schedules continue. Automated Home replies stay paused until you send another message or resume.
- `/status`: show the connection, Home reply state, and shared input queue.
- `/web`: open Home. Configure `CARMEL_PUBLIC_URL` for an absolute link; otherwise the bot returns its relative path.
- `/help`: list commands.

Up to twenty user messages can wait across Home channels. Inputs run in admission order. Disabling or removing a connection cancels its pending inputs and deliveries while preserving Home. Reconnecting a bot and switching between Agents and Sessions views do not reset Home.

## Proactive messages and scheduled tasks

An enabled integration can expose `send_user_message({ text, platform? })` to this user's runs of the agent, including scheduled tasks and issues. The server supplies the user and agent identity; the model cannot supply an arbitrary recipient or chat ID. No active IM conversation is required. Choose a platform when several are available, or mark one connection as the default notification destination.

Turn off **Allow proactive messages** to keep incoming chat while preventing notifications. Disabling the integration stops both directions and cancels queued output. The server rechecks access before accepting prompts and before sending messages; an agent becoming private suspends other users' integrations.

For reminders or conditional alerts, ask the agent to schedule a task with `notifyPlatform`, or select a notification destination in the task form. Include the conditions in the task prompt, for example: “Check the build; if it failed, send me the failure summary via Telegram.” The saved destination is supplied to each future run, which is instructed to call `send_user_message` when the conditions apply. Delivery depends on the run actually making that tool call; it is not an unconditional broadcast of every task result. If the model fails before notification, the failure remains in task history.

The tool returns a delivery ID and its current status. **Pending** means queued, not received. Task history shows message delivery separately from the agent's execution outcome; Integrations also lists recent deliveries.

## Restarts and delivery failures

Incoming event IDs are durably deduplicated. Telegram's offset advances only after durable input admission. The output queue retries explicit rate limits and safe transient failures with backoff, without rerunning the agent. Large replies are split and each confirmed chunk is recorded.

If a network error or restart happens after a provider may have accepted a message but before confirmation, delivery is marked **uncertain**, not blindly retried. Check the chat before resending. Exactly-once delivery cannot be guaranteed by these APIs.

Inputs interrupted during execution are not automatically replayed. Carmel reports the interruption; inspect the saved conversation before resubmitting. Disconnecting removes credentials, sender bindings, and queued integration records while retaining session history. Replacing a bot is staged until pairing succeeds; rotating credentials for the same verified bot keeps its sender and session.
