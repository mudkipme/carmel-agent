# Open WebUI Import

Carmel Agent can import Open WebUI JSON chat exports into the currently selected agent.

## How To Import

1. Select the target agent.
2. Open the import dialog from the sidebar.
3. Choose an Open WebUI `.json` export file.
4. Import.

Imported sessions use the selected agent's default model and thinking level. After import, Carmel opens the first imported session.

## Supported Export Shapes

The importer accepts:

- an array of chat objects
- an object with `chats`, `data`, or `items`
- a single chat-like object with `chat`, `messages`, or `history`

For Open WebUI history graphs, Carmel follows the current branch from `history.currentId` through `parentId` links, then imports that branch in order.

## Imported Content

Carmel converts:

- user text turns
- assistant text turns
- image attachments encoded as data URLs
- assistant model names
- token usage and cost fields when present
- reasoning output from structured `output` arrays
- reasoning details embedded in HTML `<details type="reasoning">` blocks

Chat titles, creation timestamps, and update timestamps are preserved when available. Otherwise Carmel uses sensible defaults.

## Skipped Content

Chats with no importable user or assistant messages are skipped. If no sessions can be imported, the API returns an error instead of creating empty sessions.

The importer is intentionally conservative: unsupported attachment types and malformed image data are ignored rather than creating broken messages.
