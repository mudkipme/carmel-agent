import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { ensureHome, HomeError, readHome, resetHome } from "../services/agent-homes.ts";
import { readSessionSnapshot } from "../services/session-snapshot.ts";

export function createHomeRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof HomeError) return c.json({ error: error.message }, error.status);
    throw error;
  });
  route.get("/agents/:agentId/home", async (c) => {
    const home = readHome(c.get("user").id, c.req.param("agentId"));
    return c.json({ home: home ?? null });
  });
  route.post("/agents/:agentId/home", async (c) => {
    const home = ensureHome(c.get("user").id, c.req.param("agentId"));
    return c.json({ home, session: await readSessionSnapshot(c.get("user").id, home.sessionId) });
  });
  route.post("/agents/:agentId/home/reset", async (c) => {
    await resetHome(c.get("user").id, c.req.param("agentId"));
    return c.json({ ok: true });
  });
  return route;
}
