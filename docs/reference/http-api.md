# HTTP API

The web client talks to the server over a JSON HTTP API under `/api`. The same API is available to your own scripts.

::: tip Looking for model access?
To call your configured models from other tools, use the [OpenAI-compatible API](/reference/openai-api) with an API key instead.
:::

## OpenAPI description

Every HTTP route is declared with its request and response schemas, and the full contract is generated into [`packages/shared/openapi.yaml`](https://github.com/mudkipme/carmel-agent/blob/main/packages/shared/openapi.yaml). Use it to explore the API or generate a client.

## Authentication

The `/api` routes authenticate with the session cookie set at sign-in, for password and single sign-on logins alike. Requests that change data must come from the server's own origin or one listed in `CARMEL_ALLOWED_ORIGINS`. Repeated failed logins for the same username and source are rate limited.

## WebSockets

Three endpoints are WebSockets rather than HTTP routes, so they are not in the OpenAPI document. All of them authenticate with the session cookie and check the request `Origin`.

| Path            | Purpose                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/api/updates`  | One shared connection per browser for live run events and state-change notifications. Heartbeat every 15 seconds. |
| `/api/terminal` | The [web terminal](/guide/workspace#web-terminal).                                                                |
| `/api/browser`  | The [shared browser](/guide/workspace#shared-browser) view and control.                                           |

State notifications only name the topics that changed; clients reload the affected resources over HTTP.

## Tasks

Task endpoints keep their original `/issues` paths for compatibility, while task pages in the web client live at `/agents/:agentId/tasks`. (The `/api/agents/:agentId/tasks` endpoints manage schedules.)

| Endpoint                                               | Purpose                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `POST /api/agents/:agentId/issues`                     | Create a task. `queue: true` also queues it.                 |
| `POST /api/agents/:agentId/issues/:issueId/runs`       | Queue instructions. `fresh: true` starts a new conversation. |
| `POST /api/agents/:agentId/issues/:issueId/updates`    | Steer a running task.                                        |
| `DELETE /api/agents/:agentId/issues/:issueId/queue`    | Remove queued work.                                          |
| `POST /api/agents/:agentId/issues/:issueId/queue/move` | Reorder with `direction: "up" \| "down"`.                    |

## Stability

The HTTP API is shaped by the web client's needs and deployed with it. It may change between releases; check the OpenAPI document for the version you run.
