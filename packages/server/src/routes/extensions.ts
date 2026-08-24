import { Hono } from "hono";
import { requireAdmin, type AuthVariables } from "../auth.ts";
import { getExtensionRegistry, extensionsRoot } from "../runtime/extension-registry.ts";
import type { InstalledExtension } from "@carmel-agent/shared";

/**
 * What extensions are installed, for the admin who decides which agents get
 * them. Admin-only to read as well as to act on: the list names third-party
 * code running in the server process, which is not a regular user's business.
 */
export function createExtensionRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get("/extensions", requireAdmin, (c) => {
    const registry = getExtensionRegistry();
    const installed: InstalledExtension[] = registry.extensionProviders.map((provider) => ({
      id: provider.id,
      label: provider.label,
      // Provisioned with an empty context purely to read names for the admin
      // list. Tools are built per agent at run time; this is a description, not
      // the thing an agent will use.
      toolNames: provider
        .provide({
          agentId: "",
          workingDir: "",
          permissions: { read: false, write: false, edit: false, bash: false, network: false },
          env: undefined as never,
        })
        .map((provided) => provided.tool.name),
    }));

    return c.json({
      root: extensionsRoot,
      enabled: process.env.CARMEL_AGENT_EXTENSIONS === "1",
      installed,
      errors: registry.errors,
    });
  });

  return route;
}
