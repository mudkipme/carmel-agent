# Contributing

Use Node.js 24 and the pnpm version in `package.json`. Clone the repository, run `pnpm install --frozen-lockfile`, then `pnpm dev`. The API listens on port 8797 and the web client on 5173. Create an administrator account in the browser and configure your own model provider.

Keep real credentials, sessions, and workspace files outside Git. Copy `.env.example` to `.env` if needed; production and Compose require a stable encryption key. Development without a key stores credentials in plaintext. Use disposable test credentials.

## Before Opening A Pull Request

- Explain the user-visible problem and resulting behavior.
- Run `pnpm check` for lint, server/client tests, type-checking, and the client build.
- For UI changes, run `pnpm test:browser`. Install its matching CLI with `npm install -g agent-browser@0.38.2`, then `agent-browser install --with-deps`.
- For runner changes, build `Dockerfile.runner` and run the sandbox identity and browser checks described in [deployment.md](docs/deployment.md#local-development).
- Update the relevant configuration or runtime documentation when behavior changes.

Tests use Node's test runner. Prefer the smallest focused command while iterating, for example from `packages/server`: `DATABASE_URL=:memory: node --import tsx --test src/security.test.ts`. Browser regressions use an isolated fixture server; runtime integration checks use temporary data and their own containers. These checks do not need real model-provider credentials.

The client uses ordinary React hooks without React Compiler. Lint keeps the compiler diagnostics for refs, manual memoization, and synchronous state synchronization off; hook ordering and effect dependencies remain checked.

## Test Quality

Test observable behavior at the boundary that owns it. Each new test should name a credible regression and explain why existing coverage would not catch it. Keep independent security, protocol, persistence, lifecycle, and platform contracts. Prefer extending a meaningful case over duplicating the same guarantee at another layer.

Avoid source-code greps, fixture inventories, assertion-free probes, expected values computed by the function under test, and mocks that implement the behavior being asserted. Before removing a test, inspect its owner, callers, overlapping coverage, and history; identify the stronger proof that remains. A slow test or one resembling implementation is not automatically unnecessary.

## Dependencies And Licensing

Keep Pi packages on one coordinated version; adapter and storage changes need their integration tests. Transitive security overrides live in `pnpm-workspace.yaml`; remove them when upstream dependency ranges include the fixed versions. Run `pnpm audit` after dependency changes.

UI components and the original shadcn 4.7.0 Tailwind utilities are committed as source, with the upstream license in `packages/client/SHADCN_LICENSE`; the shadcn CLI is not a runtime or build dependency. Run `pnpm dlx shadcn@latest` from `packages/client` when deliberately adding or updating components, and review the generated changes.

Carmel Agent is MIT licensed. Preserve dependency copyright/license notices when adding or redistributing third-party code. Contributions are under the repository's MIT license.
