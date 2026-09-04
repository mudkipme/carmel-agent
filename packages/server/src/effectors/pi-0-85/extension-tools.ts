import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { ProvidedTool, ToolProvider } from "../contracts/tool-provider.ts";

/**
 * Load admin-installed Pi extensions and expose their tools as providers.
 *
 * ## Why this does not use the obvious argument
 *
 * `discoverAndLoadExtensions(paths, cwd, agentDir)` scans `cwd/.pi/extensions/`
 * and `agentDir/extensions/` *before* it looks at `paths`. The obvious `cwd` for
 * Carmel is the agent's workspace -- which is writable through the file browser
 * and by the agent itself. Passing it would mean any user who can write a file
 * into a workspace gets arbitrary code execution in the Carmel server process:
 * outside the container, with the database, every user's sessions, and the
 * provider credentials.
 *
 * So `root` is an administrator-only directory and is passed for both `cwd` and
 * `agentDir`, which points every one of Pi's discovery paths at ground the
 * admin controls. **`root` must never be, or be inside, an agent workspace.**
 *
 * ## What loading an extension means
 *
 * Everything. An extension is a TypeScript module loaded with jiti into this
 * process: full `fs`, `child_process`, `process.env`, the SQLite file. Carmel's
 * container sandbox and workspace boundaries constrain the *agent*, not
 * extension code. Per-agent enablement limits which agents an extension can act
 * through; it does not limit what the extension can reach.
 */

export type ExtensionLoadRequest = {
  /** Administrator-only directory. Never an agent workspace. */
  readonly root: string;
  /** Extension entries under `root`, as accepted by Pi's loader. */
  readonly entries: readonly string[];
};

export type ExtensionLoadResult = {
  readonly providers: readonly ToolProvider[];
  readonly errors: readonly { readonly path: string; readonly error: string }[];
};

/**
 * Serializable description of the agent a tool is running for.
 *
 * Serializable on purpose. When extension execution moves out of this process,
 * the context is rebuilt in the child from exactly this -- so nothing here may
 * become a live Carmel object, however convenient that would be today.
 */
export type ExtensionHostInfo = {
  readonly cwd: string;
  readonly agentId: string;
  readonly model?: { readonly provider: string; readonly modelId: string };
};

export type ExtensionHostCallbacks = {
  /** Where an extension's `ctx.ui.notify` goes. */
  readonly notify?: (message: string, level: "info" | "warning" | "error") => void;
};

export async function loadExtensionToolProviders(
  request: ExtensionLoadRequest,
  host: (agentId: string) => ExtensionHostInfo,
  callbacks: ExtensionHostCallbacks = {},
): Promise<ExtensionLoadResult> {
  const loaded = await discoverAndLoadExtensions([...request.entries], request.root, request.root);

  const providers = loaded.extensions
    .filter((extension) => extension.tools.size > 0)
    .map((extension): ToolProvider => {
      const id = providerIdFor(extension.path);
      const tools = [...extension.tools.values()];
      return {
        id,
        source: "extension",
        label: extension.sourceInfo?.source ?? id,
        provide(context): ProvidedTool[] {
          return tools.map((registered) => ({
            providerId: id,
            // No capability gate. An in-process extension can do anything a
            // permission would have withheld, so claiming one here would
            // describe an enforcement that does not exist. Per-agent
            // enablement is the real gate.
            tool: adaptExtensionTool(registered.definition as unknown as PiToolDefinition, () =>
              createExtensionToolContext(host(context.agentId), callbacks),
            ),
          }));
        },
      };
    });

  return { providers, errors: loaded.errors };
}

/**
 * Pi's own `wrapRegisteredTool` needs an `ExtensionRunner`, which is welded to
 * the CLI's `SessionManager` and TUI. It only uses the runner as a context
 * factory, and the wrapping itself is this: supply the fifth argument Pi's
 * `ToolDefinition.execute` takes and the harness does not.
 *
 * Reimplemented rather than imported because `wrapToolDefinition` is not in the
 * package's public exports. It is the one piece that a move to out-of-process
 * execution replaces outright, which is why it is this small and this isolated.
 */
function adaptExtensionTool(
  definition: PiToolDefinition,
  createContext: () => unknown,
): AgentHarnessTool<ExecutionToolContext> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    constrainedSampling: definition.constrainedSampling,
    prepareArguments: definition.prepareArguments,
    executionMode: definition.executionMode,
    // The harness passes Carmel's tool context as the fourth argument; the
    // extension expects Pi's. Substituting here is the whole adaptation.
    //
    // 0.85 also reordered the harness side -- the update callback took the
    // abort signal's third position, and the signal moved onto the invocation
    // `Context` -- while the extension contract kept its 0.83 shape, so this is
    // now a reorder as well as a substitution.
    execute: (toolCallId, params, onUpdate, _toolContext, _invocation, context) =>
      definition.execute(toolCallId, params as never, context.abortSignal, onUpdate as never, createContext() as never),
  } as AgentHarnessTool<ExecutionToolContext>;
}

type PiToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  constrainedSampling?: unknown;
  prepareArguments?: unknown;
  executionMode?: unknown;
  execute: (
    toolCallId: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: never,
    ctx: never,
  ) => Promise<unknown>;
};

/** Cosmetic terminal calls. Doing nothing is the correct server behaviour. */
const UI_NO_OPS = new Set([
  "setStatus",
  "setWorkingMessage",
  "setWorkingVisible",
  "setWorkingIndicator",
  "setHiddenThinkingLabel",
  "setWidget",
  "setFooter",
  "setHeader",
  "setTitle",
  "pasteToEditor",
  "setEditorText",
  "setToolsExpanded",
  "addAutocompleteProvider",
  "setEditorComponent",
]);

/**
 * A partial `ExtensionContext`.
 *
 * `ExtensionUIContext` alone has around thirty members, nearly all of them
 * terminal widgets, themes, and editor components that a web server has no
 * answer for. Enumerating stubs for all of them would be a lie that rots as Pi
 * adds more, so anything not deliberately supported throws through a proxy
 * naming what was reached for. Pi does the same thing in
 * `createExtensionRuntime`, which ships "throwing stubs for action methods".
 *
 * The consequence is worth stating plainly: this is partial Pi-extension
 * compatibility. An extension that only registers tools works; one that expects
 * to drive a terminal fails at the moment it tries, with a message that says so.
 */
export function createExtensionToolContext(info: ExtensionHostInfo, callbacks: ExtensionHostCallbacks) {
  const ui = unsupportedProxy("ctx.ui", {
    notify: (message: string, level: "info" | "warning" | "error" = "info") =>
      callbacks.notify?.(String(message), level),
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    getToolsExpanded: () => false,
    ...Object.fromEntries([...UI_NO_OPS].map((name) => [name, () => {}])),
  });

  return unsupportedProxy("ctx", {
    ui,
    // "print" rather than "rpc": `hasUI` is documented as true in TUI and RPC
    // modes, and an extension that trusts that and opens a dialog would hang.
    mode: "print",
    hasUI: false,
    cwd: info.cwd,
    model: info.model,
    scopedModels: [],
    signal: undefined,
    isIdle: () => false,
    isProjectTrusted: () => true,
    hasPendingMessages: () => false,
  });
}

function unsupportedProxy(label: string, supported: Record<string, unknown>) {
  return new Proxy(supported, {
    get(target, property) {
      if (property in target) return target[property as string];
      if (typeof property === "symbol") return undefined;
      throw new Error(
        `${label}.${property} is not available in Carmel. This extension expects Pi's terminal or session runtime, which the server does not provide.`,
      );
    },
    has: () => true,
  });
}

/** Stable across restarts, and readable in the admin list and agent allowlist. */
export function providerIdFor(extensionPath: string) {
  return `ext:${extensionPath.replace(/\\/g, "/").replace(/^.*\/(?=[^/]+\/[^/]+$)/, "").replace(/[^a-zA-Z0-9._/-]/g, "_")}`;
}
