import type { ToolProvider } from "../../effectors/contracts/tool-provider.ts";
import { bashToolProvider, filesystemToolProvider } from "./filesystem.ts";
import { networkToolProvider } from "./network.ts";

/**
 * Ordered, and the order is load-bearing: `collectAgentTools` gives the first
 * registration of a tool name to the provider that claimed it, so built-ins
 * listed here cannot be shadowed by anything registered after them.
 */
export const builtinToolProviders: readonly ToolProvider[] = [
  filesystemToolProvider,
  bashToolProvider,
  networkToolProvider,
];

export { bashToolProvider, filesystemToolProvider, networkToolProvider };
