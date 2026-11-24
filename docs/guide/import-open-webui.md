# Import from Open WebUI

Bring your chat history from Open WebUI into Carmel Agent. Imported chats become ordinary sessions with the agent you choose.

## Importing

1. Export your chats from Open WebUI as JSON.
2. In Carmel Agent, select the agent the chats should belong to.
3. Open **Import Open WebUI export** from the sidebar and choose the `.json` file.
4. Select **Import**.

Imported sessions use the agent's default model and thinking level. When the import finishes, Carmel Agent opens the first imported session.

## What is imported

- User and assistant messages.
- Images attached as data URLs.
- The assistant model name of each reply.
- Token usage and cost, when present.
- Reasoning, from structured `output` arrays or from `<details type="reasoning">` blocks.
- Chat titles and creation and update times, when available.

For chats with edits and regenerations, Carmel Agent imports the branch that was selected in Open WebUI.

## What is skipped

- Chats with no user or assistant messages.
- Unsupported attachment types and malformed images. They are dropped instead of creating broken messages.

If nothing in the file can be imported, Carmel Agent shows an error and creates no sessions.

## Supported file shapes

The importer accepts:

- an array of chat objects,
- an object with `chats`, `data`, or `items`, or
- a single chat-like object with `chat`, `messages`, or `history`.

For Open WebUI history graphs, Carmel Agent follows the current branch from `history.currentId` through `parentId` links.
