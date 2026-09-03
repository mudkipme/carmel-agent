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
  corepack prepare pnpm@11.20.0 --activate

FROM base AS deps

RUN apt-get update && \
  apt-get install -y --no-install-recommends g++ make python3 && \
  rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json .oxlintrc.json ./
COPY packages/client/package.json packages/client/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json

# better-sqlite3 ships prebuilt binaries and falls back to compiling from source
# when the download fails -- silently, because g++/make/python3 are present above
# for exactly that fallback. That fallback is not equivalent: a source build
# against this base image's Node headers aborts the process with
# "RemoveEnvironmentCleanupHook: Assertion `(env) != nullptr' failed" when a
# Statement is finalized during teardown, which takes the server down at random.
# Fail the build instead of shipping a binary that crashes a few times an hour.
RUN pnpm install --frozen-lockfile && \
  if find node_modules/.pnpm -maxdepth 7 -type d -name obj.target -path '*better-sqlite3*' | grep -q .; then \
    echo "ERROR: better-sqlite3 was compiled from source instead of using its prebuilt binary."; \
    echo "The prebuild download probably failed. Re-run the build; do not ship this image."; \
    exit 1; \
  fi

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
