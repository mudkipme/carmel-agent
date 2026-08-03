# carmel-agent server image: the API + built web client. Agent bash runs in a
# separate per-agent sandbox container built from Dockerfile.runner, so this
# image only needs the Node runtime and the host-side file/search tooling.
FROM node:24-trixie-slim AS base

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
  corepack prepare pnpm@11.1.2 --activate

FROM base AS deps

RUN apt-get update && \
  apt-get install -y --no-install-recommends g++ make python3 && \
  rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json .oxlintrc.json ./
COPY packages/client/package.json packages/client/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY packages packages

RUN pnpm build

FROM base AS app

ENV NODE_ENV="production"
ENV HOST="0.0.0.0"
ENV PORT="8797"
ENV CARMEL_AGENT_DATA_DIR="/data"

COPY --from=build /app /app

RUN mkdir -p /data

EXPOSE 8797
VOLUME ["/data"]

CMD ["pnpm", "serve"]
