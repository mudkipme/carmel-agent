# Messaging apps

Connect a Telegram, Feishu, or Lark bot to talk to an agent's [Home](/guide/home-and-memory) from your phone, and to receive notifications from tasks and schedules.

Connections are personal: each one belongs to you and one agent. On a shared agent, everyone connects their own dedicated bot, with separate credentials, conversations, and notification settings.

## Before you start

- The server needs a stable `CARMEL_SECRET_KEY`. Integrations refuse to store credentials without encryption, even in development.
- The server only needs **outbound** internet access. Carmel Agent receives Telegram updates by long polling and Feishu/Lark events over WebSockets, so no public webhook or tunnel is required.

Open **Agent Settings → Integrations** to connect.

## Telegram

1. Create a dedicated bot with **@BotFather** in Telegram and copy its token.
2. Select **Connect Telegram** and paste the token.
3. Select **Open bot** and send the `/start` command it opens with. Alternatively, send the `/pair` command shown on screen.

The pairing code expires after ten minutes. Carmel Agent binds your numeric user and chat IDs, so changing your username does not affect access. Messages from anyone else, and all group messages, are ignored.

::: warning One bot, one integration
Use a bot that nothing else is using. Remove any existing webhook and stop other programs polling the bot before connecting — Carmel Agent will not silently take over another application's bot.
:::

## Feishu and Lark

1. Select **Scan QR code** and scan it with the Feishu or Lark mobile app.
2. Approve creating the personal bot. Carmel Agent completes the registration and switches between Feishu and Lark automatically when needed.
3. Open the new bot and send the `/pair` command shown on screen from your own account.

If QR registration is unavailable in your organization, choose **Use existing app** and enter an App ID and App Secret. In the developer console:

- Enable the bot capability and publish the app to the intended users.
- Grant permissions to receive private messages, send messages as the bot, and read message resources (for image input).
- Subscribe to `im.message.receive_v1` using **long connection** mode.

Your organization's approval or availability policies may still require action after QR setup. Connection errors appear in **Integrations**. Cancelling setup does not delete an app that was already created in Feishu or Lark.

## Chatting

Send text or images in the private chat with your bot. The bot, the web, and any other connected app all share your one Home conversation with the agent, so context carries across them.

Each reply goes back to the app the message came from; replies to messages sent on the web are not broadcast to your apps. Thinking and raw tool output are never sent.

Images are limited to 10 MB each and five per message. Files, voice, video, and group chats are not supported.

### Commands

| Command   | What it does                                                                              |
| --------- | ----------------------------------------------------------------------------------------- |
| `/new`    | Start a fresh Home context, keeping history, memory, and background work.                 |
| `/stop`   | Stop the current Home reply and clear pending messages. Tasks and schedules keep running. |
| `/status` | Show the connection, Home reply state, and message queue.                                 |
| `/web`    | Get a link to Home on the web. Requires `CARMEL_PUBLIC_URL` for an absolute link.         |
| `/help`   | List commands.                                                                            |

Up to twenty messages can wait across all Home channels; they run in the order received.

## Notifications and scheduled tasks

An enabled integration lets the agent send you messages from your runs — including tasks and schedules — with `send_user_message`. It can only message you, never an arbitrary chat. If you connect several apps, mark one as the **Default notification destination**.

To get alerts from a schedule or task, choose a **Notification destination** in its form, or ask the agent to set one. Put the conditions in the prompt:

> Check the build. If it failed, send me the failure summary via Telegram.

Delivery depends on the run actually sending the message, so this is not an unconditional broadcast of every result. If a run fails before sending, the failure stays in its history.

Turn off **Allow proactive messages, including scheduled task alerts** to keep chatting while blocking notifications. Disabling the integration stops both directions.

## Delivery status

**Integrations** lists recent deliveries, and task history shows each message's delivery separately from the run's outcome.

| Status        | Meaning                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Pending**   | Queued, not yet confirmed.                                                                                             |
| **Sent**      | Confirmed by the platform.                                                                                             |
| **Failed**    | Could not be sent after retries.                                                                                       |
| **Uncertain** | A network error or restart happened after the platform may have accepted the message. Check the chat before resending. |

Carmel Agent retries rate limits and transient errors with backoff, without rerunning the agent. Long replies are split into chunks. Exactly-once delivery is not possible with these APIs, so uncertain messages are never retried blindly.

Incoming messages are deduplicated across restarts. A message whose processing was interrupted by a restart is reported, not replayed — check the conversation before resending.

## Changing or removing a connection

- Replacing a bot takes effect only after the new bot is paired. Rotating the token for the same bot keeps your pairing and conversation.
- Disconnecting removes credentials, pairing, and queued messages, but keeps your Home history.
- If a shared agent becomes private, other people's integrations with it are suspended.
