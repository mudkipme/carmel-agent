# carmel-agent server image: the API + built web client. Agent bash runs in a
# separate per-agent sandbox container built from Dockerfile.runner, so this
# image only needs the Node runtime and the host-side file/search tooling.
FROM node:25-trixie-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

# ripgrep and fd back the server-side grep/find tools, which Pi runs as host
# processes and would otherwise download at first use. Everything an agent
# reaches from bash belongs in Dockerfile.runner, not here.
RUN apt-get update && \
  apt-get install -y --no-install-recommends fd-find ripgrep && \
  rm -rf /var/lib/apt/lists/* && \
  corepack enable && \
  corepack prepare pnpm@11.20.0 --activate

FROM base AS deps

RUN apt-get update && \
  apt-get install -y --no-install-recommends g++ make python3 && \
  rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json .oxlintrc.json ./
COPY packages/client/package.json packages/client/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json

# better-sqlite3 13 includes N-API prebuilds in its package. Its installer creates
# obj.target even when using a prebuild; CI checks native loading by booting the
# finished server image and initializing a fresh database.
RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY packages packages

# Local checkouts can have restrictive file modes. Runtime files must remain
# readable when Compose runs the server under the host user's numeric UID.
RUN chmod -R a+rX /app && pnpm build

FROM base AS app

ENV NODE_ENV="production"
ENV HOST="0.0.0.0"
ENV PORT="8797"
ENV CARMEL_AGENT_DATA_DIR="/data"
ENV CARMEL_CONTAINERIZED="1"

COPY --from=build /app /app
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
