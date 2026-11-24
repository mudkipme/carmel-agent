# Production setup

Before you invite other people or expose Carmel Agent beyond your own machine, work through this page.

## Checklist

- [ ] **Set a stable `CARMEL_SECRET_KEY` before adding any credentials.** It encrypts provider keys, OAuth logins, environment secrets, and messaging-app credentials. Changing it later makes existing secrets unreadable.
- [ ] **Serve Carmel Agent over HTTPS.** Session cookies are marked secure when `NODE_ENV=production`, which the server image sets.
- [ ] **Run exactly one server per `data/` directory.** Never scale to several replicas or point two servers at the same data: each server runs its own schedulers, so scheduled tasks and queued work would run twice.
- [ ] **Back up `data/` and the secret key together.** See [Backups and upgrades](/self-hosting/backups-and-upgrades).
- [ ] **Keep the container socket available.** With rootless Podman, run `loginctl enable-linger <user>` so the user socket stays alive without an active login session.
- [ ] **Prefer rootless Podman** over a rootful Docker socket.
- [ ] **Set `CARMEL_PUBLIC_URL`** to the address people use. It is required for single sign-on and used for links from messaging apps.
- [ ] **Configure your reverse proxy**, including WebSockets, `CARMEL_TRUSTED_PROXY`, and if needed `CARMEL_ALLOWED_ORIGINS`.
- [ ] **Decide how people sign in.** See [Users and sign-in](/self-hosting/users-and-sign-in).

## Reverse proxy

The server listens on `PORT` (default `8797`) and serves both `/api/*` and the web client from the same process. Proxy everything to `http://127.0.0.1:8797`, or to the container's published port.

### WebSockets

Forward WebSocket upgrades for these paths:

| Path            | Used for                                                         |
| --------------- | ---------------------------------------------------------------- |
| `/api/updates`  | Live run progress and state notifications for every open client. |
| `/api/terminal` | The web terminal.                                                |
| `/api/browser`  | The shared browser view.                                         |

The update connection sends a heartbeat every 15 seconds; set the proxy's idle timeout above that.

### Forwarded headers

Pass the usual `Host` and `X-Forwarded-*` headers. Carmel Agent only trusts `X-Forwarded-For` (used for login rate limiting) and `X-Forwarded-Host` (used for same-origin checks) when the direct peer is listed in `CARMEL_TRUSTED_PROXY`. Without it, the request's own `Host` is used and login limits see the proxy's IP.

```dotenv
CARMEL_TRUSTED_PROXY=127.0.0.1
CARMEL_PUBLIC_URL=https://carmel.example.com
```

### Examples

::: code-group

```text [Caddyfile]
carmel.example.com {
  reverse_proxy 127.0.0.1:8797
}
```

```nginx [nginx]
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl;
  server_name carmel.example.com;

  client_max_body_size 0;

  location / {
    proxy_pass http://127.0.0.1:8797;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 1h;
    proxy_buffering off;
  }
}
```

:::

Caddy forwards WebSockets and headers by default. For nginx, `client_max_body_size 0` allows large workspace uploads (Carmel Agent caps them at 2 GiB itself), and disabling buffering keeps streamed downloads flowing.

### Separate origins

If the browser loads the web client from a different origin than the API, add that origin to `CARMEL_ALLOWED_ORIGINS` (comma-separated). Mutating requests with cookies from any other origin are rejected.

## Resource planning

Each environment's runner is capped by default at 1 CPU, 512 MB of memory, and 512 processes, and is removed after 15 idle minutes. Knowledge workers default to 2 CPUs and 4 GiB. Adjust these in [Sandbox and runner](/self-hosting/sandbox) to match your host and workloads.

Runs are bounded too: 250 tool calls per run, 15 minutes without activity, and 10 minutes per provider request. Two scheduled runs may execute at once. See [Run limits](/reference/environment-variables#run-limits).
