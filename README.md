# Carmel Agent

Carmel Agent is a local agent harness for coding and research workflows. It wraps the `@earendil-works/pi-*` runtime with a SQLite-backed API, a React control surface, configurable models/providers, per-agent workspaces, sessions, skills, and a file editor.

## Project Layout

- `packages/server` - Hono API, SQLite/Drizzle persistence, auth, agent runtime wiring, file APIs, provider/model/agent/session routes.
- `packages/client` - Vite + React UI with the chat harness, settings dialogs, file explorer, and Monaco editor.
- `packages/shared` - shared TypeScript types used by the client and server.
- `data/` - default local data directory for SQLite and per-agent workspaces. This directory is runtime state, not source.

## Requirements

- Node.js 24
- pnpm 11

## Setup

Install dependencies:

```sh
pnpm install
```

Create a login user:

```sh
pnpm --filter @carmel-agent/server user:create
```

Start both API and web client:

```sh
pnpm dev
```

The API listens on `http://localhost:8797` by default. The Vite client listens on `http://localhost:5173`.

## Configuration

Useful environment variables:

- `DATABASE_URL` - SQLite path. Defaults to `data/carmel-agent.sqlite`.
- `CARMEL_AGENT_DATA_DIR` - base data directory used for the database and default agent workspaces.
- `CARMEL_AGENT_DIR` - agent runtime directory. Defaults to `data/pi-agent`.
- `CARMEL_GLOBAL_SKILLS_DIR` - additional global skills directory.
- `EXA_API_KEY` - enables the `exa_search` server tool when an agent has network permission.
- `HOST` - API bind host. Defaults to `0.0.0.0`.
- `PORT` - API port. Defaults to `8797`.

Provider API keys and OAuth credentials are stored in SQLite. Treat the data directory as sensitive.

## Runtime Model

An agent stores its workspace, selected skills, system prompt, prompt templates, default model, thinking level, and permissions. The server creates a `pi-coding-agent` session for each run, streams agent events to the browser as NDJSON, and persists messages back to SQLite when the run ends.

Agent permissions control which tools are exposed:

- file read/search/list
- file write/edit
- bash
- network search/fetch
- browser JavaScript
- browser artifacts
- browser document extraction

File API operations are constrained to the agent working directory. Agent read tools can also read selected skill directories so skills can be loaded and inspected.

## Database Migrations

The server runs migrations on startup and records applied migrations in `schema_migrations`. Existing databases are upgraded with compatibility migrations, while new databases are created with the current schema.

## Scripts

```sh
pnpm dev          # run API and client together
pnpm dev:server   # run only the API
pnpm dev:client   # run only the Vite client
pnpm build        # type-check and build all packages
pnpm lint         # run ESLint
pnpm serve        # run the server entrypoint
```

## Docker

Build the image:

```sh
docker build -t carmel-agent .
```

Run it with a persistent data volume:

```sh
docker run --rm -p 8797:8797 -v carmel-agent-data:/data carmel-agent
```

The Docker image serves the built client from the API server and includes browser tooling dependencies used by agent workflows.
