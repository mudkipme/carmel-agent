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
ENV AGENT_BROWSER_CONFIG="/etc/agent-browser/config.json"

RUN apk add --no-cache chromium curl font-noto font-noto-cjk font-noto-emoji podman py3-pip python3 ttf-freefont wget && \
    ln -sf /usr/bin/python3 /usr/local/bin/python

RUN mkdir -p /etc/agent-browser /data/agent-browser/downloads /data/agent-browser/profile && \
    printf '%s\n' \
      '{' \
      '  "$schema": "https://agent-browser.dev/schema.json",' \
      '  "executablePath": "/usr/bin/chromium-browser",' \
      '  "args": "--no-sandbox,--disable-dev-shm-usage,--disable-gpu",' \
      '  "ignoreHttpsErrors": true,' \
      '  "downloadPath": "/data/agent-browser/downloads",' \
      '  "profile": "/data/agent-browser/profile"' \
      '}' \
      > /etc/agent-browser/config.json

RUN npm install -g agent-browser@0.27.0 @tobilu/qmd && \
    agent-browser --version && \
    qmd --version

COPY --from=build /app /app

RUN mkdir -p /data

EXPOSE 8797
VOLUME ["/data"]

CMD ["pnpm", "serve"]
