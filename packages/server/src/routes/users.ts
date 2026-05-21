import type { User } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { serializeUser } from "../serializers.ts";
import { canUseModel } from "../services/agent-access.ts";
import { jsonValidator, userRequestSchema } from "../validation.ts";

export function createUserRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.put("/users/:id", jsonValidator(userRequestSchema), async (c) => {
    const currentUser = c.get("user");
    if (c.req.param("id") !== currentUser.id) return c.json({ error: "You can only update your own profile." }, 403);
    const user = c.req.valid("json") as User;
    const fastTaskModelRefId = user.fastTaskModelRefId?.trim() || null;
    if (fastTaskModelRefId && !canUseModel(currentUser.id, fastTaskModelRefId)) {
      return c.json({ error: "Fast task model not found." }, 404);
    }
    const timestamp = now();
    db.insert(users)
      .values({
        id: currentUser.id,
        username: currentUser.username,
        passwordHash: currentUser.passwordHash,
        name: user.name,
        email: user.email,
        fastTaskModelRefId,
        createdAt: currentUser.createdAt,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: { name: user.name, email: user.email, fastTaskModelRefId, updatedAt: timestamp },
      })
      .run();
    return c.json(serializeUser(db.select().from(users).where(eq(users.id, currentUser.id)).get()!));
  });

  return route;
}
