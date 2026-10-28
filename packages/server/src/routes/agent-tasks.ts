import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { agentTaskCreateSchema, agentTaskPatchSchema } from "@carmel-agent/shared";
import { jsonValidator } from "../validation.ts";
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
  const route = new Hono<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof AgentTaskError) return c.json({ error: error.message }, error.status);
    throw error;
  });

  route.get("/agents/:agentId/tasks", (c) =>
    c.json(readAgentTasks(c.get("user"), c.req.param("agentId"))),
  );

  route.post("/agents/:agentId/tasks", jsonValidator(agentTaskCreateSchema), (c) =>
    c.json(createAgentTask(c.get("user"), c.req.param("agentId"), c.req.valid("json")), 201),
  );

  route.patch("/agents/:agentId/tasks/:taskId", jsonValidator(agentTaskPatchSchema), (c) =>
    c.json(
      updateAgentTask(
        c.get("user"),
        c.req.param("agentId"),
        c.req.param("taskId"),
        c.req.valid("json"),
      ),
    ),
  );

  route.delete("/agents/:agentId/tasks/:taskId", async (c) => {
    await deleteAgentTask(c.get("user"), c.req.param("agentId"), c.req.param("taskId"));
    return c.json({ ok: true });
  });

  route.get("/agents/:agentId/tasks/:taskId/runs", (c) =>
    c.json(readTaskRuns(c.get("user"), c.req.param("agentId"), c.req.param("taskId"))),
  );

  /**
   * Fire now, so a task can be tried without waiting for its schedule. Answers
   * once the run has started, with its session, so the caller can open it and
   * watch; the run log records how it ends.
   */
  route.post("/agents/:agentId/tasks/:taskId/run", async (c) => {
    const task = readAgentTask(c.get("user"), c.req.param("agentId"), c.req.param("taskId"));
    return c.json(await runTaskNow(task));
  });

  return route;
}
