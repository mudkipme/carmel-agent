import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  clearAuthSession,
  createAuthSession,
  hashPassword,
  verifyPassword,
  type AuthVariables,
} from "../auth.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";
import { jsonValidator, loginRequestSchema, passwordRequestSchema } from "../validation.ts";

export function createAuthRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.post("/login", jsonValidator(loginRequestSchema), async (c) => {
    const body = c.req.valid("json");
    const username = body.username?.trim();
    if (!username || !body.password) return c.json({ error: "Username and password are required." }, 400);

    const user = db.select().from(users).where(eq(users.username, username)).get();
    if (!user?.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
      return c.json({ error: "Invalid username or password." }, 401);
    }

    await createAuthSession(c, user.id);
    return c.json(readBootstrapPayload(user.id));
  });

  route.post("/logout", (c) => {
    clearAuthSession(c);
    return c.json({ ok: true });
  });

  route.post("/password", jsonValidator(passwordRequestSchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    if (!body.currentPassword || !body.newPassword) {
      return c.json({ error: "Current and new password are required." }, 400);
    }
    if (body.newPassword.length < 8) return c.json({ error: "New password must be at least 8 characters." }, 400);
    if (!user.passwordHash || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
      return c.json({ error: "Current password is incorrect." }, 400);
    }
    db.update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), updatedAt: now() })
      .where(eq(users.id, user.id))
      .run();
    return c.json({ ok: true });
  });

  return route;
}
