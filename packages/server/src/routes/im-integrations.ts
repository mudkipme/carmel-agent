import { Hono } from "hono";
import { imConnectSchema, imQrBeginSchema, imSettingsSchema } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { jsonValidator } from "../validation.ts";
import {
  beginImConnect,
  beginImQr,
  deleteImIntegration,
  finishSetup,
  ImError,
  listImDeliveries,
  listImIntegrations,
  listImSetups,
  ownedSetup,
  serializeImSetup,
  updateImIntegration,
} from "../services/im-integrations.ts";
import { ImProviderError } from "../im/platform.ts";

export function createImIntegrationRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof ImError) return c.json({ error: error.message }, error.status);
    if (error instanceof ImProviderError) return c.json({ error: error.message }, 400);
    return c.json(
      {
        error:
          "Cannot configure the messaging integration. Check the supplied credentials and try again.",
      },
      400,
    );
  });
  route.get("/agents/:agentId/integrations", (c) =>
    c.json(listImIntegrations(c.get("user").id, c.req.param("agentId"))),
  );
  route.get("/agents/:agentId/integrations/setups", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(listImSetups(c.get("user").id, c.req.param("agentId")));
  });
  route.get("/agents/:agentId/integrations/deliveries", (c) =>
    c.json(listImDeliveries(c.get("user").id, c.req.param("agentId"))),
  );
  route.post("/agents/:agentId/integrations/connect", jsonValidator(imConnectSchema), async (c) => {
    const { platform, ...credential } = c.req.valid("json");
    c.header("Cache-Control", "no-store");
    return c.json(
      await beginImConnect(c.get("user").id, c.req.param("agentId"), platform, credential),
    );
  });
  route.post("/agents/:agentId/integrations/qr", jsonValidator(imQrBeginSchema), async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      await beginImQr(c.get("user").id, c.req.param("agentId"), c.req.valid("json").platform),
    );
  });
  route.get("/agents/:agentId/integrations/setup/:setupId", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      serializeImSetup(
        ownedSetup(c.get("user").id, c.req.param("agentId"), c.req.param("setupId")),
      ),
    );
  });
  route.delete("/agents/:agentId/integrations/setup/:setupId", (c) => {
    const row = ownedSetup(c.get("user").id, c.req.param("agentId"), c.req.param("setupId"));
    if (["authorizing", "pairing"].includes(row.status)) finishSetup(row.id, "cancelled");
    return c.json({ ok: true });
  });
  route.patch(
    "/agents/:agentId/integrations/:integrationId",
    jsonValidator(imSettingsSchema),
    (c) => {
      updateImIntegration(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("integrationId"),
        c.req.valid("json"),
      );
      return c.json({ ok: true });
    },
  );
  route.delete("/agents/:agentId/integrations/:integrationId", (c) => {
    deleteImIntegration(c.get("user").id, c.req.param("agentId"), c.req.param("integrationId"));
    return c.json({ ok: true });
  });
  return route;
}
