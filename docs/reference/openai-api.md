# OpenAI-compatible API

Carmel Agent exposes your models through an OpenAI-compatible endpoint, so editors, scripts, and other tools can use the providers your instance is configured with — without ever seeing the provider keys.

This endpoint gives direct model access. It does not run Carmel Agent agents, their tools, or their permissions.

## Create a key

Open **Settings → API Keys**, give the key a name, and create it. Copy it right away — it is shown only once. Keys are stored hashed. Revoking a key, or deleting its user, takes effect immediately.

## Connect a client

```text
Base URL:       https://<your-carmel-host>/api/v1
Authorization:  Bearer carmel-...
```

::: code-group

```sh [curl]
curl https://carmel.example.com/api/v1/chat/completions \
  -H "Authorization: Bearer $CARMEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-5",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'
```

```python [Python]
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://carmel.example.com/api/v1",
    api_key=os.environ["CARMEL_API_KEY"],
)

reply = client.chat.completions.create(
    model="anthropic/claude-sonnet-5",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)
```

```ts [TypeScript]
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://carmel.example.com/api/v1",
  apiKey: process.env.CARMEL_API_KEY,
});

const reply = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-5",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(reply.choices[0].message.content);
```

:::

## Endpoints

### `GET /api/v1/models`

Lists the models the key's owner can use in the app: their own model entries, shared ones, and entries without a provider config. Model IDs are `provider/modelId`, such as `anthropic/claude-sonnet-5`. If two visible entries would share an ID, both are listed by their model entry ID instead.

### `POST /api/v1/chat/completions`

Supported parameters:

| Parameter                                | Notes                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `model`, `messages`                      | Required.                                                                   |
| `stream`, `stream_options.include_usage` | Server-sent events, as with OpenAI.                                         |
| `tools`, `tool_choice`                   | `auto` and `none`. `required` and named functions fall back to `auto`.      |
| `temperature`, `top_p`                   |                                                                             |
| `max_tokens`, `max_completion_tokens`    |                                                                             |
| `reasoning_effort`                       | Sets the thinking level. Reasoning text is returned as `reasoning_content`. |

Not supported: `n > 1` and structured `response_format` (rejected), and remote image URLs — send images as base64 `data:` URLs.

## Tool calls

Carmel Agent does not run tools on this endpoint. Tool calls come back as `tool_calls`; your client runs them and sends the results as `tool` messages in its next request, exactly as with OpenAI.

## Privacy and attribution

Requests go to the provider through Pi with the model's server-side credentials. None of the caller's headers are forwarded, and the Carmel Agent key never reaches the provider. The provider sees Pi's `User-Agent` and attribution headers.

Some providers route prompt caching by session. Carmel Agent derives a session ID from the system prompt and first user message; send an `x-session-id` header to set it explicitly.

## Browser clients

Browser apps may call these endpoints from any origin with a bearer key. CORS preflights allow `Authorization`, `Content-Type`, `x-session-id`, and common SDK headers. Cookies never authenticate these requests.

`/v1` also works as an alias on the server.
