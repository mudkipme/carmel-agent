# Core concepts

A few terms come up everywhere in Carmel Agent. This page explains how they fit together.

## Accounts

Every account is either an **administrator** or a regular **user**.

- Administrators manage accounts and the instance's model provider credentials.
- Everyone can create agents, model entries, and sessions, use anything shared with the instance, and change their own name, password, theme, and fast task model.

See [Users and sign-in](/self-hosting/users-and-sign-in).

## Providers and models

A **provider** is a configured connection to a model service such as Anthropic, OpenAI, or Ollama. Providers and their credentials belong to the whole instance and are managed by administrators. Their keys never reach a browser.

A **model entry** is what people pick in agents and sessions: a model from one of those providers. Anyone can create model entries and share them with the instance.

## Agents

An **agent** is a configured assistant. It has a name, description, and appearance, a system prompt, prompt templates, a default model and thinking level, permissions, MCP servers, and integrations. You own the agents you create and can share them with everyone on the instance.

See [Agents](/guide/agents).

## Environments

An **environment** is the machine an agent works on: a runner container with its `/workspace`, a persistent home at `/home/agent`, scratch space at `/tmp`, mounts, a terminal, a browser, network access, and secrets.

Each new agent gets its own environment, but several agents can share one — they then share files, tool installs, browser sign-ins, and secrets, while each keeps its own prompt, model, memory, and permissions.

Inside its environment, each agent has a **working folder**. By default this is `/workspace/<agent id>`. Commands, terminals, file tools, and the file manager start there.

See [Workspace, terminal, and browser](/guide/workspace).

## Sessions

A **session** is one conversation with an agent. Sessions always belong to one person and are never shared, even on a shared agent. Runs happen on the server, so a session keeps working when you close the tab.

See [Chat and sessions](/guide/chat).

## Home

**Home** is your private, continuous conversation with an agent. Messaging apps, task results, and scheduled notices arrive there, and Home has private memory that only you and that agent can see.

See [Home and memory](/guide/home-and-memory).

## Tasks and schedules

A **task** is a unit of delegated work with a brief, discussion, run history, and review. Tasks wait in the agent's queue and run one at a time.

A **schedule** runs a prompt once or on a recurring basis, in a fresh session.

See [Tasks](/guide/tasks) and [Schedules](/guide/schedules).

## Permissions

An agent's permissions decide which tools exist during its runs:

| Permission       | What it allows                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Read files**   | Read, search, find, and list files in the working folder and mounts. Download files in the browser.                   |
| **Write files**  | Create and replace files. Create, upload, move, copy, and delete in the browser.                                      |
| **Edit files**   | Patch-style edits. Edit and rename in the browser.                                                                    |
| **Run commands** | Bash in the environment's sandbox container, the web terminal, the shared browser, and stdio MCP servers.             |
| **Web access**   | Web search and URL fetching, remote MCP servers, the built-in browser skill (with Run commands), and model downloads. |

New agents start with read, write, and edit enabled. Run commands and web access are off until you turn them on.

## Sharing

Sharing is opt-in. You can share agents and model entries you own. People who can use a shared agent chat with it in their own private sessions, but only the owner can change its settings.

::: warning
A shared agent carries its environment with it. People who use it run commands with that environment's secrets and browser sign-ins. Share an agent with secrets the way you would hand someone the credential.
:::

See the [Security model](/reference/security) for the full picture.
