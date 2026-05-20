FROM node:24-trixie-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends bash ca-certificates git && \
    rm -rf /var/lib/apt/lists/* && \
    corepack enable

FROM base AS deps

RUN apt-get update && \
    apt-get install -y --no-install-recommends g++ make python3 && \
    rm -rf /var/lib/apt/lists/*

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

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      chromium \
      curl \
      fonts-freefont-ttf \
      fonts-noto \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      podman \
      python3 \
      python3-pip \
      ripgrep \
      wget && \
    rm -rf /var/lib/apt/lists/* && \
    ln -sf /usr/bin/python3 /usr/local/bin/python

RUN mkdir -p /etc/agent-browser /data/agent-browser/downloads /data/agent-browser/profile && \
    printf '%s\n' \
      '{' \
      '  "$schema": "https://agent-browser.dev/schema.json",' \
      '  "executablePath": "/usr/bin/chromium",' \
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
