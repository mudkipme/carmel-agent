FROM node:24-alpine AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

RUN apk add --no-cache bash ca-certificates git && corepack enable

FROM base AS deps

RUN apk add --no-cache --virtual .build-deps g++ make python3

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json eslint.config.js ./
COPY packages/client/package.json packages/client/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY packages packages
COPY skills-lock.json skills-lock.json

RUN pnpm build

FROM base AS runner

ENV NODE_ENV="production"
ENV HOST="0.0.0.0"
ENV PORT="8797"
ENV CARMEL_AGENT_DATA_DIR="/data"

RUN apk add --no-cache curl podman py3-pip python3 wget && \
    ln -sf /usr/bin/python3 /usr/local/bin/python

COPY --from=build /app /app

RUN mkdir -p /data

EXPOSE 8797
VOLUME ["/data"]

CMD ["pnpm", "serve"]
