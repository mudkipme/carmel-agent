import type { Context } from "hono";
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, error, json, jsonBody, success } from "../openapi/routes.ts";
import {
  IssueSchema,
  IssueCreateRequestSchema,
  IssueDetailSchema,
  IssueNoteRequestSchema,
  IssuePatchRequestSchema,
  IssueQueueMoveRequestSchema,
  IssueRunRequestSchema,
} from "../openapi/schemas.ts";
import type { AuthVariables } from "../auth.ts";
import {
  addIssueNote,
  runIssue,
  acceptIssue,
  reopenIssue,
  cancelIssue,
  createIssue,
  deleteIssue,
  interruptIssue,
  IssueError,
  readIssues,
  readIssueView,
  updateIssue,
  removeIssueFromQueue,
  moveQueuedIssue,
  sendIssueUpdate,
} from "./service.ts";

export function createIssueRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();

  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/issues",
      operationId: "listIssues",
      tags: ["Issues"],
      description: "The caller's own issues on this agent",
      request: { params: z.object({ agentId: z.string() }) },
      responses: { 400: error, 409: error, 200: json(z.array(IssueSchema), "Issues"), 404: error },
    }),
    (c) => respond(c, () => readIssues(c.get("user").id, c.req.param("agentId"))),
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/issues",
      operationId: "createIssue",
      tags: ["Issues"],
      description: "Saves an agent-owned brief without starting work.",
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(IssueCreateRequestSchema),
      },
      responses: { 409: error, 201: json(IssueDetailSchema, "Issue"), 400: error, 404: error },
    }),
    (c) =>
      respond(
        c,
        () => createIssue(c.get("user").id, c.req.param("agentId"), c.req.valid("json")),
        201,
      ),
  );

  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/issues/{issueId}",
      operationId: "getIssue",
      tags: ["Issues"],
      request: { params: z.object({ agentId: z.string(), issueId: z.string() }) },
      responses: { 400: error, 409: error, 200: json(IssueDetailSchema, "Issue"), 404: error },
    }),
    (c) =>
      respond(c, () =>
        readIssueView(c.get("user").id, c.req.param("agentId"), c.req.param("issueId")),
      ),
  );

  route.openapi(
    createRoute({
      method: "patch",
      path: "/agents/{agentId}/issues/{issueId}",
      operationId: "updateIssue",
      tags: ["Issues"],
      description: "Edit an idle brief or move unstarted work between backlog and todo.",
      request: {
        params: z.object({ agentId: z.string(), issueId: z.string() }),
        body: jsonBody(IssuePatchRequestSchema),
      },
      responses: { 400: error, 200: json(IssueDetailSchema, "Issue"), 404: error, 409: error },
    }),
    (c) =>
      respond(c, () =>
        updateIssue(
          c.get("user").id,
          c.req.param("agentId"),
          c.req.param("issueId"),
          c.req.valid("json"),
        ),
      ),
  );

  route.openapi(
    createRoute({
      method: "delete",
      path: "/agents/{agentId}/issues/{issueId}",
      operationId: "deleteIssue",
      tags: ["Issues"],
      description:
        "Deletes the issue and all attempt sessions. Refused while a run is in progress.",
      request: { params: z.object({ agentId: z.string(), issueId: z.string() }) },
      responses: { 400: error, 200: success, 404: error, 409: error },
    }),
    (c) =>
      respond(c, async () => {
        await deleteIssue(c.get("user").id, c.req.param("agentId"), c.req.param("issueId"));
        return { ok: true };
      }),
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/issues/{issueId}/interrupt",
      operationId: "interruptIssue",
      tags: ["Issues"],
      description: "Stops the current run. The issue stays open for a reply.",
      request: { params: z.object({ agentId: z.string(), issueId: z.string() }) },
      responses: { 400: error, 409: error, 200: json(IssueDetailSchema, "Issue"), 404: error },
    }),
    (c) =>
      respond(c, () =>
        interruptIssue(c.get("user").id, c.req.param("agentId"), c.req.param("issueId")),
      ),
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/issues/{issueId}/cancel",
      operationId: "cancelIssue",
      tags: ["Issues"],
      description: "Stops any run and closes the issue as cancelled.",
      request: { params: z.object({ agentId: z.string(), issueId: z.string() }) },
      responses: { 400: error, 409: error, 200: json(IssueDetailSchema, "Issue"), 404: error },
    }),
    (c) =>
      respond(c, () =>
        cancelIssue(c.get("user").id, c.req.param("agentId"), c.req.param("issueId")),
      ),
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/issues/{issueId}/runs",
      operationId: "runIssue",
      tags: ["Issues"],
      description:
        "Queue work; continue the conversation unless fresh is true. One issue runs per agent.",
      request: {
        params: z.object({ agentId: z.string(), issueId: z.string() }),
        body: jsonBody(IssueRunRequestSchema),
      },
      responses: {
        200: json(IssueDetailSchema, "Issue detail"),
        400: error,
        404: error,
        409: error,
      },
    }),
    (c) =>
      respond(c, () =>
        runIssue(
          c.get("user").id,
          c.req.param("agentId"),
          c.req.param("issueId"),
          c.req.valid("json"),
        ),
      ),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/issues/{issueId}/notes",
      operationId: "addIssueNote",
      tags: ["Issues"],
      description: "Save a note without triggering execution or changing status.",
      request: {
        params: z.object({ agentId: z.string(), issueId: z.string() }),
        body: jsonBody(IssueNoteRequestSchema),
      },
      responses: {
        200: json(IssueDetailSchema, "Issue detail"),
        400: error,
        404: error,
        409: error,
      },
    }),
    (c) =>
      respond(c, () =>
        addIssueNote(
          c.get("user").id,
          c.req.param("agentId"),
          c.req.param("issueId"),
          c.req.valid("json").body,
        ),
      ),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/issues/{issueId}/updates",
      operationId: "sendIssueUpdate",
      tags: ["Issues"],
      description: "Steer the active Pi lane; persist visible update delivery status.",
      request: {
        params: z.object({ agentId: z.string(), issueId: z.string() }),
        body: jsonBody(IssueNoteRequestSchema),
      },
      responses: {
        200: json(IssueDetailSchema, "Issue detail"),
        400: error,
        404: error,
        409: error,
      },
    }),
    (c) =>
      respond(c, () =>
        sendIssueUpdate(
          c.get("user").id,
          c.req.param("agentId"),
          c.req.param("issueId"),
          c.req.valid("json").body,
        ),
      ),
  );
  route.openapi(
    createRoute({
      method: "delete",
      path: "/agents/{agentId}/issues/{issueId}/queue",
      operationId: "removeIssueFromQueue",
      tags: ["Issues"],
      description: "Return a queued issue to Backlog; retain instructions in the discussion.",
      request: { params: z.object({ agentId: z.string(), issueId: z.string() }) },
      responses: {
        200: json(IssueDetailSchema, "Issue detail"),
        400: error,
        404: error,
        409: error,
      },
    }),
    (c) =>
      respond(c, () =>
        removeIssueFromQueue(c.get("user").id, c.req.param("agentId"), c.req.param("issueId")),
      ),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/issues/{issueId}/queue/move",
      operationId: "moveQueuedIssue",
      tags: ["Issues"],
      description: "Move a job up or down among this user's queued issues.",
      request: {
        params: z.object({ agentId: z.string(), issueId: z.string() }),
        body: jsonBody(IssueQueueMoveRequestSchema),
      },
      responses: {
        200: json(IssueDetailSchema, "Issue detail"),
        400: error,
        404: error,
        409: error,
      },
    }),
    (c) =>
      respond(c, () =>
        moveQueuedIssue(
          c.get("user").id,
          c.req.param("agentId"),
          c.req.param("issueId"),
          c.req.valid("json").direction,
        ),
      ),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/issues/{issueId}/accept",
      operationId: "acceptIssue",
      tags: ["Issues"],
      description: "Accept a result in review and mark the issue done.",
      request: { params: z.object({ agentId: z.string(), issueId: z.string() }) },
      responses: {
        200: json(IssueDetailSchema, "Issue detail"),
        400: error,
        404: error,
        409: error,
      },
    }),
    (c) =>
      respond(c, () =>
        acceptIssue(c.get("user").id, c.req.param("agentId"), c.req.param("issueId")),
      ),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/issues/{issueId}/reopen",
      operationId: "reopenIssue",
      tags: ["Issues"],
      description: "Reopen a closed issue without starting work.",
      request: { params: z.object({ agentId: z.string(), issueId: z.string() }) },
      responses: {
        200: json(IssueDetailSchema, "Issue detail"),
        400: error,
        404: error,
        409: error,
      },
    }),
    (c) =>
      respond(c, () =>
        reopenIssue(c.get("user").id, c.req.param("agentId"), c.req.param("issueId")),
      ),
  );

  return route;
}

async function respond<T, S extends 200 | 201 = 200>(
  c: Context,
  read: () => T | Promise<T>,
  status: S = 200 as S,
) {
  try {
    return c.json(await read(), status);
  } catch (error) {
    if (error instanceof IssueError) return c.json({ error: error.message }, error.status);
    throw error;
  }
}
