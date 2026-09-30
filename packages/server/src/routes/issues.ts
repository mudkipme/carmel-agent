import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import {
  issueCreateSchema,
  issuePatchSchema,
  issueRunSchema,
  issueNoteSchema,
  issueQueueMoveSchema,
} from "@carmel-agent/shared";
import { jsonValidator } from "../validation.ts";
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
} from "../services/issues.ts";

export function createIssueRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get("/agents/:agentId/issues", (c) =>
    respond(c, () => readIssues(c.get("user").id, c.req.param("agentId"))),
  );

  route.post("/agents/:agentId/issues", jsonValidator(issueCreateSchema), (c) =>
    respond(
      c,
      () =>
        createIssue(
          c.get("user").id,
          c.req.param("agentId"),
          c.req.valid("json"),
        ),
      201,
    ),
  );

  route.get("/agents/:agentId/issues/:issueId", (c) =>
    respond(c, () =>
      readIssueView(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("issueId"),
      ),
    ),
  );

  route.patch(
    "/agents/:agentId/issues/:issueId",
    jsonValidator(issuePatchSchema),
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

  route.delete("/agents/:agentId/issues/:issueId", (c) =>
    respond(c, async () => {
      await deleteIssue(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("issueId"),
      );
      return { ok: true };
    }),
  );

  route.post("/agents/:agentId/issues/:issueId/interrupt", (c) =>
    respond(c, () =>
      interruptIssue(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("issueId"),
      ),
    ),
  );

  route.post("/agents/:agentId/issues/:issueId/cancel", (c) =>
    respond(c, () =>
      cancelIssue(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("issueId"),
      ),
    ),
  );

  route.post(
    "/agents/:agentId/issues/:issueId/runs",
    jsonValidator(issueRunSchema),
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
  route.post(
    "/agents/:agentId/issues/:issueId/notes",
    jsonValidator(issueNoteSchema),
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
  route.post(
    "/agents/:agentId/issues/:issueId/updates",
    jsonValidator(issueNoteSchema),
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
  route.delete("/agents/:agentId/issues/:issueId/queue", (c) =>
    respond(c, () =>
      removeIssueFromQueue(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("issueId"),
      ),
    ),
  );
  route.post(
    "/agents/:agentId/issues/:issueId/queue/move",
    jsonValidator(issueQueueMoveSchema),
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
  route.post("/agents/:agentId/issues/:issueId/accept", (c) =>
    respond(c, () =>
      acceptIssue(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("issueId"),
      ),
    ),
  );
  route.post("/agents/:agentId/issues/:issueId/reopen", (c) =>
    respond(c, () =>
      reopenIssue(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("issueId"),
      ),
    ),
  );

  return route;
}

async function respond<T>(
  c: {
    json: (body: unknown, status?: 200 | 201 | 400 | 404 | 409) => Response;
  },
  read: () => T | Promise<T>,
  status: 200 | 201 = 200,
) {
  try {
    return c.json((await read()) as object, status);
  } catch (error) {
    if (error instanceof IssueError)
      return c.json({ error: error.message }, error.status);
    throw error;
  }
}
