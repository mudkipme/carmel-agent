import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../paths.ts";
import { errorMessage } from "../errors.ts";
import type { ToolProvider } from "../effectors/contracts/tool-provider.ts";
import { loadExtensionToolProviders } from "../effectors/pi-0-85/extension-tools.ts";
import { builtinToolProviders } from "./tool-providers/index.ts";

/**
 * Administrator-installed Pi extensions, loaded once at startup.
 *
 * `extensionsRoot` is deliberately under the data directory and never an agent
 * workspace: Pi's loader scans `cwd/.pi/extensions/` before any configured
 * path, so pointing it at a workspace would turn "an agent can write a file"
 * into "an agent can run code in the server process". See
 * `effectors/pi-0-85/extension-tools.ts` for the full note.
 *
 * Loading is opt-in. With no directory present, or `CARMEL_AGENT_EXTENSIONS`
 * unset, Carmel runs exactly as it did before extensions existed.
 */

export const extensionsRoot = process.env.CARMEL_AGENT_EXTENSIONS_DIR ?? join(dataDir, "extensions");

export type ExtensionRegistry = {
  readonly providers: readonly ToolProvider[];
  readonly extensionProviders: readonly ToolProvider[];
  readonly errors: readonly { readonly path: string; readonly error: string }[];
};

let registry: ExtensionRegistry = { providers: builtinToolProviders, extensionProviders: [], errors: [] };

export function getToolProviders() {
  return registry.providers;
}

export function getExtensionRegistry() {
  return registry;
}

/**
 * Load extensions and register their tools.
 *
 * Called once from server startup. Extensions are not reloaded per request:
 * jiti-loaded modules keep module-level state, and re-importing them under a
 * live agent run would give one run two versions of the same tool.
 */
export async function loadInstalledExtensions(): Promise<ExtensionRegistry> {
  if (!extensionsEnabled()) {
    registry = { providers: builtinToolProviders, extensionProviders: [], errors: [] };
    return registry;
  }

  try {
    const { providers, errors } = await loadExtensionToolProviders(
      { root: extensionsRoot, entries: installedEntries() },
      (agentId) => ({ cwd: "", agentId }),
      { notify: (message, level) => console.log(`[extension:${level}] ${message}`) },
    );
    for (const failure of errors) console.warn(`Extension failed to load (${failure.path}): ${failure.error}`);
    // Built-ins first: `collectAgentTools` gives a tool name to whoever claims
    // it first, so this ordering is what stops an extension shadowing `bash`.
    registry = { providers: [...builtinToolProviders, ...providers], extensionProviders: providers, errors };
  } catch (error) {
    console.warn("Extension loading failed; continuing with built-in tools only:", errorMessage(error));
    registry = { providers: builtinToolProviders, extensionProviders: [], errors: [] };
  }
  return registry;
}

function extensionsEnabled() {
  return process.env.CARMEL_AGENT_EXTENSIONS === "1" && existsSync(extensionsRoot);
}

/** Top-level directories under the extensions root, each one extension. */
function installedEntries() {
  return readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}
