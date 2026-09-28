import { Hono } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth.ts";
import { jsonValidator, queryValidator } from "../validation.ts";
import { readActivity, setActivityRead, unreadActivityCount } from "../services/activity.ts";

export function createActivityRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();
  route.get("/activity", queryValidator(z.object({
    filter: z.enum(["unread", "attention", "all"]).default("unread"),
    before: z.coerce.number().int().positive().optional(),
  })), (c) => {
    const { filter, before } = c.req.valid("query");
    return c.json(readActivity(c.get("user").id, filter, before));
  });
  route.get("/activity/unread-count", (c) => c.json({ unreadCount: unreadActivityCount(c.get("user").id) }));
  route.patch("/activity/read", jsonValidator(z.object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
    read: z.boolean(),
  }).strict()), (c) => {
    const { ids, read } = c.req.valid("json");
    setActivityRead(c.get("user").id, ids, read);
    return c.json({ ok: true });
  });
  return route;
}
