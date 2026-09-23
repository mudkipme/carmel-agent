# Extensions

Carmel's tools come from **providers**. Built-in providers ship with Carmel;
extension providers are Pi extensions an administrator installs on the server.

```
effectors/contracts/tool-provider.ts     the port + `collectAgentTools`
effectors/pi-0-87/extension-tools.ts     loads Pi extensions, synthesizes their context
runtime/tool-providers/                  the built-in providers
runtime/extension-registry.ts            loads once at startup, owns the provider list
```

## Security: read this before enabling it

An extension is a TypeScript module loaded with jiti **into the Carmel server
process**. It has `fs`, `child_process`, `process.env`, and the SQLite file.
Carmel's container sandbox and workspace boundaries constrain the *agent*; they
do not constrain extension code.

So installing an extension is equivalent to giving its author shell access on
the host, including every user's sessions and the provider credentials. It
breaks the README's "sessions are always private to the user who created them".
Two gates exist, and it is worth being clear about what each one does:

- **Installation is administrator-only and off by default.** Requires
  `CARMEL_AGENT_EXTENSIONS=1` and a directory the admin controls.
- **Enablement is per agent, and also administrator-only** — including for the
  agent's owner (`assertAgentExtensionAccess`). Owning an agent is not enough to
  arm an extension on it, because that would be a privilege escalation rather
  than a preference.

Neither gate contains an extension once it runs. They control *who decides*, not
*what it can reach*. Sandboxed out-of-process execution is the thing that would,
and the `ToolProvider` port exists so that becomes a second adapter rather than
a second implementation.

### The discovery trap

`discoverAndLoadExtensions(paths, cwd, agentDir)` scans `cwd/.pi/extensions/`
**before** it looks at `paths`. The natural `cwd` for Carmel is the agent
workspace — which is writable through the file browser and by the agent itself.
Wiring it that way would mean any user who can write a file into a workspace
gets code execution in the server process.

`extensionsRoot` is therefore passed for both `cwd` and `agentDir`, and must
never be, or be inside, an agent workspace.

## Setup

```sh
export CARMEL_AGENT_EXTENSIONS=1
mkdir -p data/extensions/my-extension     # or $CARMEL_AGENT_EXTENSIONS_DIR
# data/extensions/my-extension/index.ts exports a default Pi extension factory
```

Restart, then `GET /api/extensions` (admin) lists what loaded, what failed, and
the tool names each provider contributes. Add a provider id to an agent's
`enabledExtensions` to arm it there.

## What works, and what does not

Extensions that **register tools** work. `pi.registerTool({...})` is harvested
from the loaded extension and adapted onto the harness.

Extensions that expect Pi's **terminal or session runtime** do not. The
`ExtensionContext` Carmel synthesizes is partial: `cwd`, `model`, `mode`
(`"print"`), `hasUI: false`, and `ui.notify` are real; cosmetic terminal calls
(`setStatus`, `setWidget`, …) are no-ops; everything else throws a message
naming what was reached for. `ExtensionUIContext` alone has around thirty
members, nearly all terminal widgets and themes, so enumerating stubs would be a
lie that rots as Pi adds more.

Commands, slash commands, renderers, and UI panes are not wired up. Only tools.

## Invariants `collectAgentTools` enforces

- A tool is offered only if the agent has the capability it declares. Providers
  declare; the registry checks — so a provider cannot grant itself a permission.
- Built-ins are ordered first and the first claim on a tool name wins, so an
  extension cannot shadow `bash` or `read`.
- Extension providers contribute nothing until the agent's allowlist names them.
  Built-ins ignore the allowlist, so an empty list is the safe default rather
  than an agent with no tools.

Extension tools declare **no** capability. An in-process extension can do
anything a permission would have withheld, so claiming one would describe an
enforcement that does not exist. Per-agent enablement is the real gate.

## Two reworks are coming

Keep pi-facing extension code in `effectors/pi-0-87/`:

1. **Pi v2** reshapes `ExtensionAPI` along with the harness.
2. **Sandboxing** moves execution out of process. The registry, the admin API,
   the schema, and the allowlist all survive that; `adaptExtensionTool` becomes
   an RPC proxy. This is why `ExtensionHostInfo` is serializable and the
   synthesized context is built from data plus callbacks — hand an extension a
   live Carmel object and that stops being true.
