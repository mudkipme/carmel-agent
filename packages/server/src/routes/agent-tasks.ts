import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, json, jsonBody, success } from "../openapi/routes.ts";
import {
  AgentTaskCreateRequestSchema,
  AgentTaskPatchRequestSchema,
  AgentTaskRunSchema,
  AgentTaskSchema,
} from "../openapi/schemas.ts";
import type { AuthVariables } from "../auth.ts";
import {
  AgentTaskError,
  createAgentTask,
  deleteAgentTask,
  readAgentTask,
  readAgentTasks,
  readTaskRuns,
  updateAgentTask,
} from "../services/agent-tasks.ts";
import { runTaskNow } from "../runtime/task-scheduler.ts";

/**
 * Tasks are addressed under their agent, because that is where they live: a
 * task cannot exist without one and does not outlive it.
 */
export function createAgentTaskRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof AgentTaskError) return c.json({ error: error.message }, error.status);
    throw error;
  });

  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/tasks",
      operationId: "listAgentTasks",
      tags: ["Tasks"],
      request: { params: z.object({ agentId: z.string() }) },
      responses: { 200: json(z.array(AgentTaskSchema), "Tasks") },
    }),
    (c) => c.json(readAgentTasks(c.get("user"), c.req.param("agentId")), 200),
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/tasks",
      operationId: "createAgentTask",
      tags: ["Tasks"],
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(AgentTaskCreateRequestSchema),
      },
      responses: { 201: json(AgentTaskSchema, "Task") },
    }),
    (c) => c.json(createAgentTask(c.get("user"), c.req.param("agentId"), c.req.valid("json")), 201),
  );

  route.openapi(
    createRoute({
      method: "patch",
      path: "/agents/{agentId}/tasks/{taskId}",
      operationId: "updateAgentTask",
      tags: ["Tasks"],
      request: {
        params: z.object({ agentId: z.string(), taskId: z.string() }),
        body: jsonBody(AgentTaskPatchRequestSchema),
      },
      responses: { 200: json(AgentTaskSchema, "Task") },
    }),
    (c) =>
      c.json(
        updateAgentTask(
          c.get("user"),
          c.req.param("agentId"),
          c.req.param("taskId"),
          c.req.valid("json"),
        ),
        200,
      ),
  );

  route.openapi(
    createRoute({
      method: "delete",
      path: "/agents/{agentId}/tasks/{taskId}",
      operationId: "deleteAgentTask",
      tags: ["Tasks"],
      request: { params: z.object({ agentId: z.string(), taskId: z.string() }) },
      responses: { 200: success },
    }),
    async (c) => {
      await deleteAgentTask(c.get("user"), c.req.param("agentId"), c.req.param("taskId"));
      return c.json({ ok: true }, 200);
    },
  );

  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/tasks/{taskId}/runs",
      operationId: "listAgentTaskRuns",
      tags: ["Tasks"],
      request: { params: z.object({ agentId: z.string(), taskId: z.string() }) },
      responses: { 200: json(z.array(AgentTaskRunSchema), "Runs") },
    }),
    (c) => c.json(readTaskRuns(c.get("user"), c.req.param("agentId"), c.req.param("taskId")), 200),
  );

  /**
   * Fire now, so a task can be tried without waiting for its schedule. Answers
   * once the run has started, with its session, so the caller can open it and
   * watch; the run log records how it ends.
   */
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/tasks/{taskId}/run",
      operationId: "runAgentTask",
      tags: ["Tasks"],
      request: { params: z.object({ agentId: z.string(), taskId: z.string() }) },
      responses: {
        200: json(
          z.object({
            outcome: z.string(),
            detail: z.string().optional(),
            sessionId: z.string().optional(),
          }),
          "Outcome",
        ),
      },
    }),
    async (c) => {
      const task = readAgentTask(c.get("user"), c.req.param("agentId"), c.req.param("taskId"));
      return c.json(await runTaskNow(task), 200);
    },
  );

  return route;
}
