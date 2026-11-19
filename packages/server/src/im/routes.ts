import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, error, json, jsonBody } from "../openapi/routes.ts";
import {
  ImConnectRequestSchema,
  ImDeliverySchema,
  ImIntegrationSchema,
  ImQrBeginRequestSchema,
  ImSettingsRequestSchema,
  ImSetupSchema,
  OKSchema,
} from "../openapi/schemas.ts";
import type { AuthVariables } from "../auth.ts";
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
} from "./service.ts";
import { ImProviderError } from "./platform.ts";

export function createImIntegrationRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();
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
  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/integrations",
      operationId: "listImIntegrations",
      tags: ["Integrations"],
      request: { params: z.object({ agentId: z.string() }) },
      responses: {
        200: json(z.array(ImIntegrationSchema), "Success"),
        400: error,
        404: error,
        409: error,
      },
    }),
    (c) => c.json(listImIntegrations(c.get("user").id, c.req.param("agentId")), 200),
  );
  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/integrations/setups",
      operationId: "listImSetups",
      tags: ["Integrations"],
      request: { params: z.object({ agentId: z.string() }) },
      responses: {
        200: json(z.array(ImSetupSchema), "Success"),
        400: error,
        404: error,
        409: error,
      },
    }),
    (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(listImSetups(c.get("user").id, c.req.param("agentId")), 200);
    },
  );
  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/integrations/deliveries",
      operationId: "listImDeliveries",
      tags: ["Integrations"],
      request: { params: z.object({ agentId: z.string() }) },
      responses: {
        200: json(z.array(ImDeliverySchema), "Success"),
        400: error,
        404: error,
        409: error,
      },
    }),
    (c) => c.json(listImDeliveries(c.get("user").id, c.req.param("agentId")), 200),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/integrations/connect",
      operationId: "connectIm",
      tags: ["Integrations"],
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(ImConnectRequestSchema),
      },
      responses: { 200: json(ImSetupSchema, "Success"), 400: error, 404: error, 409: error },
    }),
    async (c) => {
      const { platform, ...credential } = c.req.valid("json");
      c.header("Cache-Control", "no-store");
      return c.json(
        await beginImConnect(c.get("user").id, c.req.param("agentId"), platform, credential),
        200,
      );
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/integrations/qr",
      operationId: "beginImQr",
      tags: ["Integrations"],
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(ImQrBeginRequestSchema),
      },
      responses: { 200: json(ImSetupSchema, "Success"), 400: error, 404: error, 409: error },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(
        await beginImQr(c.get("user").id, c.req.param("agentId"), c.req.valid("json").platform),
        200,
      );
    },
  );
  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/integrations/setup/{setupId}",
      operationId: "getImSetup",
      tags: ["Integrations"],
      request: { params: z.object({ agentId: z.string(), setupId: z.string() }) },
      responses: { 200: json(ImSetupSchema, "Success"), 400: error, 404: error, 409: error },
    }),
    (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(
        serializeImSetup(
          ownedSetup(c.get("user").id, c.req.param("agentId"), c.req.param("setupId")),
        ),
        200,
      );
    },
  );
  route.openapi(
    createRoute({
      method: "delete",
      path: "/agents/{agentId}/integrations/setup/{setupId}",
      operationId: "cancelImSetup",
      tags: ["Integrations"],
      request: { params: z.object({ agentId: z.string(), setupId: z.string() }) },
      responses: { 200: json(OKSchema, "Success"), 400: error, 404: error, 409: error },
    }),
    (c) => {
      const row = ownedSetup(c.get("user").id, c.req.param("agentId"), c.req.param("setupId"));
      if (["authorizing", "pairing"].includes(row.status)) finishSetup(row.id, "cancelled");
      return c.json({ ok: true }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "patch",
      path: "/agents/{agentId}/integrations/{integrationId}",
      operationId: "updateIm",
      tags: ["Integrations"],
      request: {
        params: z.object({ agentId: z.string(), integrationId: z.string() }),
        body: jsonBody(ImSettingsRequestSchema),
      },
      responses: { 200: json(OKSchema, "Success"), 400: error, 404: error, 409: error },
    }),
    (c) => {
      updateImIntegration(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("integrationId"),
        c.req.valid("json"),
      );
      return c.json({ ok: true }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "delete",
      path: "/agents/{agentId}/integrations/{integrationId}",
      operationId: "disconnectIm",
      tags: ["Integrations"],
      request: { params: z.object({ agentId: z.string(), integrationId: z.string() }) },
      responses: { 200: json(OKSchema, "Success"), 400: error, 404: error, 409: error },
    }),
    (c) => {
      deleteImIntegration(c.get("user").id, c.req.param("agentId"), c.req.param("integrationId"));
      return c.json({ ok: true }, 200);
    },
  );
  return route;
}
