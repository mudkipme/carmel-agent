# Sandbox and runner

When an agent has the **Run commands** permission, its commands run in a runner container — never in the server's host shell. The same container hosts the web terminal, the shared browser, and stdio MCP servers. Knowledge indexing uses separate, more restricted runner containers.

## How runners work

- One runner per **environment**, created on first use and reused across runs and agents in that environment.
- Idle runners are removed after `CARMEL_BASH_IDLE_MINUTES` (default 15). Open terminals, browser viewers, and paused browser handoffs keep a runner alive.
- The environment's workspace is mounted at `/workspace`, a private persistent home at `/home/agent`, and private scratch space at `/tmp`.
- Commands, terminals, browser processes, and MCP servers run as the configured non-root host UID and GID. The server uses the same IDs, so both can edit the mounted files.
- Containers drop all capabilities, run with `no-new-privileges`, and have memory, CPU, and PID limits.
- The server's environment, its databases, and the container socket are never mounted into a runner.
- Runners are labeled `carmel.managed=1` and removed on graceful shutdown and on startup.

Carmel Agent talks to the container runtime over its Docker-compatible REST API on a Unix socket; it never needs the `podman` or `docker` CLI. At startup it checks the effective identity and mount access before running any agent command.

## Resource limits

| Variable                   | Default | Description                           |
| -------------------------- | ------- | ------------------------------------- |
| `CARMEL_BASH_MEMORY_MB`    | `512`   | Memory cap per runner, in MB.         |
| `CARMEL_BASH_CPUS`         | `1`     | CPU limit per runner.                 |
| `CARMEL_BASH_PIDS_LIMIT`   | `512`   | Process limit per runner.             |
| `CARMEL_BASH_IDLE_MINUTES` | `15`    | Idle time before a runner is removed. |

Increase memory for agents that build large projects, run browsers heavily, or use model-backed tools like `qmd` in the shell.

## The runner image

The runner image defines the toolchain agents get. The default image, built from `Dockerfile.runner`, includes:

- **Shell and files:** bash, git, ripgrep, `fd` (also as `fdfind`), jq, file, less, tree, patch, rsync.
- **Network:** curl, wget, `ip`, `ss`, netstat, dig, nslookup, `nc`, and the OpenSSH client.
- **Processes:** ps, top, pgrep, lsof.
- **Archives:** tar, gzip, zip/unzip, xz, zstd.
- **Development:** Node.js and npm, Python with pip and venv, C/C++ compilers, make, pkg-config, and Python headers for native packages.
- **Browser and search:** Chromium, `agent-browser`, and `qmd`.

### Installing packages

Agents install tools without root, and installs persist in `/home/agent`:

- `npm install -g` installs into `/home/agent/.npm-global`.
- `pip install` uses a persistent virtual environment at `/home/agent/.venvs/default`.

Both need the environment's **Sandbox network access**. `apt install` is not available to agents; packages that need extra system libraries require a custom runner image.

If an image upgrade changes Python's minor version, startup reports that the virtual environment is stale instead of deleting it. Move the old one aside and reinstall its packages.

### Custom runner images

Build your own image from `Dockerfile.runner` to add system packages, then set `CARMEL_BASH_IMAGE` to it:

```sh
podman build -f Dockerfile.runner -t localhost/carmel-agent-runner:latest .
```

```dotenv
CARMEL_BASH_IMAGE=localhost/carmel-agent-runner:latest
```

A custom image must provide Node.js, `/usr/bin/python3`, and a working `python3 -m venv`. Registry images already on the host are reused, so pull explicitly after changing a moving tag. Restart the server to replace existing runners with the new image; their persistent files are kept.

## Network access

Each environment's **Sandbox network access** setting decides whether its runner gets the runtime's default network or none at all. Network tools in the image run with the same non-root identity and dropped capabilities as everything else.

This is independent of an agent's **Web access** permission, which governs Carmel Agent's own web tools. See [Security model](/reference/security#network-access).

## Mounts

Administrators can add host folders to an environment under **Agent Settings → Environment → Extra runner mounts**, each with a host path, an optional container path, and a read-only flag. Without a container path, the host path is used inside the container too, so paths match between file tools and commands.

- Mount sources must exist on the host. When the server is containerized, that is what `CARMEL_HOST_DATA_DIR` is for.
- For nested mounts, Carmel Agent creates missing mount points as the server user, so the runtime never leaves root-owned directories in a workspace. Both sources must be visible to the server.
- Targets inside a read-only parent mount must already exist. Symlinked mount-point paths are rejected.
- On SELinux hosts, runner bind mounts are relabeled with `:z`. Set `CARMEL_BASH_SELINUX_RELABEL=false` to disable this.

## GPU passthrough

Set `CARMEL_BASH_GPU` to one or more [CDI](https://github.com/cncf-tags/container-device-interface) device IDs to give runners GPU access:

```dotenv
CARMEL_BASH_GPU=nvidia.com/gpu=all
```

CDI must be configured on the host. It injects device nodes and driver libraries; CUDA developer tools such as `nvcc` must be in the runner image if agents need them.

Knowledge workers inherit this setting unless `CARMEL_KNOWLEDGE_GPU` is set; an empty `CARMEL_KNOWLEDGE_GPU` disables passthrough for them. Vulkan embeddings have been exercised on an RTX 3060; CUDA is supported as a configuration choice but not yet validated.

## Container socket detection

`CARMEL_PODMAN_SOCKET` sets the socket path explicitly. Despite its name, it works with Docker too. When unset, Carmel Agent tries, in order:

1. `DOCKER_HOST`, when it is a `unix://` path
2. `$XDG_RUNTIME_DIR/podman/podman.sock`
3. `/run/podman/podman.sock`
4. `/var/run/docker.sock`

With rootless Podman, the Podman service must run as the same host user as `CARMEL_HOST_UID`/`CARMEL_HOST_GID`.

## Testing a runner

To check non-root execution, file ownership, package installs, terminal execution, and persistence against a real runtime, with isolated temporary data:

```sh
CARMEL_SANDBOX_TEST_IMAGE=localhost/carmel-agent-runner:latest \
  pnpm --filter @carmel-agent/server test:sandbox-identity
```

Run it as your normal user against a rootless Podman socket or a rootful Docker/Podman socket. See [Development](/development/#integration-tests) for the browser and Knowledge checks.
