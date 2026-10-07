# Security

## Reporting A Vulnerability

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/mudkipme/carmel-agent/security/advisories/new). If that option is unavailable, email **i@mudkip.me**. Include the affected version or commit, reproduction steps using disposable credentials, and the impact. Keep live secrets and private transcripts out of public issues.

Security fixes target the current release and `main`; older versions may need an upgrade.

## Deployment Trust

Use a stable `CARMEL_SECRET_KEY` and HTTPS, and back up the key with the data. Encryption protects stored provider credentials and agent secrets; transcripts, files, and browser profiles remain sensitive. Production startup requires the key, while development without it stores credentials in plaintext.

Prefer rootless Podman. The server's container socket gives it control over the host runtime; a rootful Docker socket effectively grants host root access. Administrators may select host paths and extra mounts. Treat administrators, configured MCP servers, custom skills, and shared agents with credentials as trusted parties.

An agent's browser profile and secrets travel with that agent. Sharing it lets its users act with those credentials. Output redaction prevents common accidental disclosure; it cannot contain malicious code that has access to a secret. See [runtime-and-security.md](docs/runtime-and-security.md) for the permission and isolation boundaries.
