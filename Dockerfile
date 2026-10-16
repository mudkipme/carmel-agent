# carmel-agent server image: the API + built web client. Agent bash runs in a
# separate per-agent sandbox container built from Dockerfile.runner, so this
# image only needs the Node runtime and the host-side file/search tooling.
FROM node:25-trixie-slim AS base

WORKDIR /app

# ripgrep and fd back the server-side grep/find tools, which Pi runs as host
# processes and would otherwise download at first use. Everything an agent
# reaches from bash belongs in Dockerfile.runner, not here.
RUN apt-get update && \
  apt-get install -y --no-install-recommends fd-find ripgrep && \
  rm -rf /var/lib/apt/lists/*

FROM base AS deps

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update && \
  apt-get install -y --no-install-recommends g++ make python3 && \
  rm -rf /var/lib/apt/lists/* && \
  corepack enable && \
  corepack prepare pnpm@11.20.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json .oxlintrc.json ./
COPY packages/client/package.json packages/client/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json

FROM deps AS build

RUN pnpm install --frozen-lockfile

COPY packages packages

# Local checkouts can have restrictive file modes. Runtime files must remain
# readable when Compose runs the server under the host user's numeric UID.
RUN chmod -R a+rX /app && pnpm build

# Install into a fresh workspace so the virtual store contains only server and
# shared runtime dependencies. tsx is a production dependency of the server.
# Compilers and pnpm (including its cache) stay in these intermediate stages.
FROM deps AS runtime-deps

RUN pnpm --filter @carmel-agent/server... install --prod --frozen-lockfile && \
  chmod -R a+rX /app

FROM base AS app

ENV NODE_ENV="production"
ENV HOST="0.0.0.0"
ENV PORT="8797"
ENV CARMEL_AGENT_DATA_DIR="/data"
ENV CARMEL_CONTAINERIZED="1"

COPY --from=runtime-deps /app/node_modules /app/node_modules
COPY --from=runtime-deps /app/packages/server /app/packages/server
COPY --from=runtime-deps /app/packages/shared /app/packages/shared
COPY --from=build /app/packages/server/src /app/packages/server/src
COPY --from=build /app/packages/server/skills /app/packages/server/skills
COPY --from=build /app/packages/server/tsconfig.json /app/packages/server/tsconfig.json
COPY --from=build /app/packages/shared/src /app/packages/shared/src
COPY --from=build /app/packages/shared/tsconfig.json /app/packages/shared/tsconfig.json
COPY --from=build /app/packages/client/dist /app/packages/client/dist
COPY --chmod=644 LICENSE /app/LICENSE

LABEL org.opencontainers.image.source="https://github.com/mudkipme/carmel-agent" \
      org.opencontainers.image.licenses="MIT"

RUN mkdir -p /data && chown node:node /data

# Compose overrides the numeric identity to match the host user.
USER node

EXPOSE 8797
VOLUME ["/data"]

# Start directly: a numeric host UID may have no writable package-manager home.
WORKDIR /app/packages/server
CMD ["node", "--import", "tsx", "src/index.ts"]
