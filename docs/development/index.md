# Contributing

This section is for people changing Carmel Agent itself. For contribution policy — pull request expectations, test quality, migrations, localization, and licensing — see [CONTRIBUTING.md](https://github.com/mudkipme/carmel-agent/blob/main/CONTRIBUTING.md).

## Local development

Requirements: Node.js 24 and pnpm 11.

```sh
pnpm install
pnpm dev
```

The API listens on `http://localhost:8797` and the Vite client on `http://localhost:5173`. Open the client and create your administrator account on the welcome screen, then add a provider.

If the API runs somewhere other than `http://localhost:8797`, set `CARMEL_SERVER_URL` before `pnpm dev:client`. For LAN hostnames, set `CARMEL_DEV_HOSTS=host1,host2` so the Vite dev server accepts them.

Development can run without `CARMEL_SECRET_KEY`, in which case credentials are stored in plain text. Use disposable credentials, or set a key. Copy `.env.example` to `.env` if needed.

### Sandboxed commands

For bash in development, pull the published runner image and make sure your container socket is reachable. To use a local build instead:

```sh
podman build -f Dockerfile.runner -t localhost/carmel-agent-runner:latest .
export CARMEL_BASH_IMAGE=localhost/carmel-agent-runner:latest
```

## Scripts

| Command             | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `pnpm dev`          | Run the API and client together.                                 |
| `pnpm dev:server`   | Run only the API.                                                |
| `pnpm dev:client`   | Run only the Vite client.                                        |
| `pnpm build`        | Type-check and build all packages, including this site.          |
| `pnpm format`       | Format files with oxfmt.                                         |
| `pnpm format:check` | Check formatting without writing.                                |
| `pnpm lint`         | Run oxlint.                                                      |
| `pnpm test`         | Run server and client tests.                                     |
| `pnpm test:browser` | Browser regressions (requires `agent-browser` and its Chromium). |
| `pnpm check`        | Formatting, lint, migrations, tests, and build — what CI runs.   |
| `pnpm openapi`      | Regenerate the OpenAPI document and typed client table.          |
| `pnpm serve`        | Run the API without watching, serving the built client.          |
| `pnpm docs:dev`     | Preview this documentation site with live reload.                |
| `pnpm docs:build`   | Build the documentation site into `docs/.vitepress/dist`.        |

## Project layout

| Path                | Contents                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/server`   | Hono API, SQLite/Drizzle metadata, Pi Durable session storage, auth, agent runtime, sandbox, file APIs. |
| `packages/client`   | Vite + React UI for chat, files, settings, sessions, and agent management.                              |
| `packages/shared`   | Types and the OpenAPI contract shared by client and server.                                             |
| `docs`              | This documentation site (VitePress).                                                                    |
| `Dockerfile`        | Server image.                                                                                           |
| `Dockerfile.runner` | Sandbox runner image.                                                                                   |
| `compose.yaml`      | Compose deployment, written for rootless Podman.                                                        |

## Tests

Tests use Node's test runner. While iterating, run the smallest focused command, for example from `packages/server`:

```sh
DATABASE_URL=:memory: node --import tsx --test src/security.test.ts
```

None of the tests need real model-provider credentials.

### Browser regressions

`pnpm test:browser` uses the `agent-browser` CLI:

```sh
npm install -g agent-browser@0.38.2
agent-browser install --with-deps
```

Set `AGENT_BROWSER_BIN` if the executable is outside your `PATH`. The suite builds the client and starts a fixture server on an ephemeral loopback port with an in-memory database, a temporary data directory, and no schedulers or container socket. It covers the browser pane, handoff, reload, navigation, and mobile accessibility without a container.

### Integration tests

These run against a real container runtime, with temporary data and their own containers. They never touch a running deployment, start the production scheduler, or reap other containers.

```sh
# Runner identity, ownership, pip/npm installs, terminal execution, and persistence.
CARMEL_SANDBOX_TEST_IMAGE=localhost/carmel-agent-runner:latest \
  pnpm --filter @carmel-agent/server test:sandbox-identity

# Browser streaming, remote sign-in, reconnect, and profile-lock recovery.
CARMEL_BROWSER_TEST_IMAGE=localhost/carmel-agent-runner:latest \
  pnpm --filter @carmel-agent/server test:browser-sandbox

# Knowledge indexing, retrieval, hash checks, Home indexing, and forgetting.
pnpm --filter @carmel-agent/server test:knowledge-sandbox
pnpm --filter @carmel-agent/server test:knowledge-shell-sandbox
```

For an embedding test with a local model (CPU when `CARMEL_TEST_GPU` is omitted):

```sh
CARMEL_TEST_GPU=nvidia.com/gpu=all \
CARMEL_TEST_EMBED_MODEL=/absolute/path/Qwen3-Embedding-0.6B-Q8_0.gguf \
pnpm --filter @carmel-agent/server test:knowledge-sandbox
```

Run the identity check as your normal user, against either a rootless Podman socket or a rootful Docker/Podman socket.

## Working on these docs

The site is built with [VitePress](https://vitepress.dev). Pages are Markdown files under `docs/`, and navigation lives in `docs/.vitepress/config.mts`.

```sh
pnpm docs:dev      # http://localhost:5173 with live reload
pnpm docs:build    # static output in docs/.vitepress/dist
pnpm docs:preview  # serve the built output
```

The build fails on dead links, so `pnpm check` catches broken cross-references. To host the site under a sub-path, such as a GitHub Pages project site, set `DOCS_BASE`:

```sh
DOCS_BASE=/carmel-agent/ pnpm docs:build
```

The `Docs` workflow (`.github/workflows/docs.yml`) builds and publishes the site to GitHub Pages whenever `docs/` changes on `main`, and can also be run manually. It sets `DOCS_BASE` from the Pages configuration, so a custom domain needs no change.

When behavior changes, update the page that describes it. Keep user guides focused on what people see and do, and put implementation detail in this section.

## Releases and CI

GitHub Actions tests pull requests without registry credentials and publishes images only for pushes to `main` and `v*` tags in `mudkipme/carmel-agent`. Publishing authenticates with `GITHUB_TOKEN` and `packages: write`. Branch protection should require the `check`, `browser`, and `containers` jobs. See [Backups and upgrades](/self-hosting/backups-and-upgrades#release-tags) for the tags that are published.
