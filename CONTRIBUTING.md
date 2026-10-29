# Contributing

Use Node.js 24 and the pnpm version in `package.json`. Clone the repository, run `pnpm install --frozen-lockfile`, then `pnpm dev`. The API listens on port 8797 and the web client on 5173. Create an administrator account in the browser and configure your own model provider.

Keep real credentials, sessions, and workspace files outside Git. Copy `.env.example` to `.env` if needed; production and Compose require a stable encryption key. Development without a key stores credentials in plaintext. Use disposable test credentials.

## Before Opening A Pull Request

- Explain the user-visible problem and resulting behavior.
- Run `pnpm format` to format files with oxfmt, then `pnpm check` for formatting, lint, server/client tests, type-checking, and the client build.
- For UI changes, run `pnpm test:browser`. Install its matching CLI with `npm install -g agent-browser@0.38.2`, then `agent-browser install --with-deps`.
- For runner changes, build `Dockerfile.runner` and run the sandbox identity and browser checks described in [deployment.md](docs/deployment.md#local-development).
- Update the relevant configuration or runtime documentation when behavior changes.

Tests use Node's test runner. Prefer the smallest focused command while iterating, for example from `packages/server`: `DATABASE_URL=:memory: node --import tsx --test src/security.test.ts`. Browser regressions use an isolated fixture server; runtime integration checks use temporary data and their own containers. These checks do not need real model-provider credentials.

The client uses ordinary React hooks without React Compiler. Lint keeps the compiler diagnostics for refs, manual memoization, and synchronous state synchronization off; hook ordering and effect dependencies remain checked.

## Localization

The client uses Lingui with English source messages and Simplified Chinese (`zh-Hans`) and Traditional Chinese (`zh-Hant`) catalogs. Mark interface text with `<Trans>` from `@lingui/react/macro` or `i18n._()` from `useLingui()`. Translate static label tables when rendering them so they follow language changes. Keep protocol values, user content, and model prompts unchanged.

Run `pnpm --filter @carmel-agent/client i18n:extract` after changing messages, then update the PO files under `packages/client/src/locales`. Run `pnpm --filter @carmel-agent/client i18n:compile` to check for missing translations. Vite compiles catalogs and JSX macros for development and production; compiled TypeScript catalogs for tests are generated and ignored. The language selector is available at sign-in, setup, and Settings → Appearance, and the browser preference is used until a language is selected.

## Database Migrations

Metadata tables, foreign keys, and indexes are declared in `packages/server/src/db/schema.ts` and `im-schema.ts`. After changing them, run `pnpm --filter @carmel-agent/server db:generate --name=describe_change`, review the generated SQL, and commit it with its snapshot and journal under `packages/server/drizzle`. Run `pnpm --filter @carmel-agent/server db:check` to validate migration history. Keep already shipped migrations unchanged.

The server applies pending migrations through Drizzle's SQLite migrator before seeding or serving requests. `pnpm --filter @carmel-agent/server db:migrate` applies the same startup migrations without starting the server, using `DATABASE_URL` or the configured data directory. Back up deployed data before upgrading.

The initial baseline uses `IF NOT EXISTS` to adopt databases created before migration tracking. `legacy-upgrade.ts` runs once for those databases to preserve older secret scopes and pin pending IM inputs to their original sessions. Future schema changes belong in new generated migrations. Use `db:generate --custom --name=describe_change` for data backfills and SQLite features outside Drizzle's schema model, such as FTS5 and triggers. Pi's per-session databases remain managed by Pi Durable.

## Test Quality

Test observable behavior at the boundary that owns it. Each new test should name a credible regression and explain why existing coverage would not catch it. Keep independent security, protocol, persistence, lifecycle, and platform contracts. Prefer extending a meaningful case over duplicating the same guarantee at another layer.

Avoid source-code greps, fixture inventories, assertion-free probes, expected values computed by the function under test, and mocks that implement the behavior being asserted. Before removing a test, inspect its owner, callers, overlapping coverage, and history; identify the stronger proof that remains. A slow test or one resembling implementation is not automatically unnecessary.

## Dependencies And Licensing

Keep Pi packages on one coordinated version; adapter and storage changes need their integration tests. Transitive security overrides live in `pnpm-workspace.yaml`; remove them when upstream dependency ranges include the fixed versions. Run `pnpm audit` after dependency changes.

UI components and the original shadcn 4.7.0 Tailwind utilities are committed as source, with the upstream license in `packages/client/SHADCN_LICENSE`; the shadcn CLI is not a runtime or build dependency. Run `pnpm dlx shadcn@latest` from `packages/client` when deliberately adding or updating components, and review the generated changes.

Carmel Agent is MIT licensed. Preserve dependency copyright/license notices when adding or redistributing third-party code. Contributions are under the repository's MIT license.
