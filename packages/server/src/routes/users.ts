import type { User } from "@carmel-agent/shared";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { hashPassword, requireAdmin, type AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { serializeUser } from "../serializers.ts";
import { canUseModel } from "../services/agent-access.ts";
import { createUserRequestSchema, jsonValidator, userRequestSchema } from "../validation.ts";

export function createUserRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get("/users", requireAdmin, (c) => {
    return c.json(db.select().from(users).orderBy(asc(users.createdAt)).all().map(serializeUser));
  });

  route.post("/users", requireAdmin, jsonValidator(createUserRequestSchema), async (c) => {
    const body = c.req.valid("json");
    const username = body.username.trim();
    if (!username || !body.email.trim()) return c.json({ error: "Username and email are required." }, 400);
    if (body.password.length < 8) return c.json({ error: "Password must be at least 8 characters." }, 400);
    if (db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()) {
      return c.json({ error: "That username is already taken." }, 409);
    }

    const timestamp = now();
    const userId = id("user");
    db.insert(users)
      .values({
        id: userId,
        username,
        passwordHash: await hashPassword(body.password),
        name: body.name?.trim() || username,
        email: body.email.trim(),
        role: body.role ?? "user",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return c.json(serializeUser(db.select().from(users).where(eq(users.id, userId)).get()!), 201);
  });

  // Self profile update: name, email, and fast-task model only. Role is never
  // read here, so a user cannot escalate their own privileges.
  route.put("/users/:id", jsonValidator(userRequestSchema), async (c) => {
    const currentUser = c.get("user");
    if (c.req.param("id") !== currentUser.id) return c.json({ error: "You can only update your own profile." }, 403);
    const user = c.req.valid("json") as User;
    const fastTaskModelRefId = user.fastTaskModelRefId?.trim() || null;
    if (fastTaskModelRefId && !canUseModel(currentUser.id, fastTaskModelRefId)) {
      return c.json({ error: "Fast task model not found." }, 404);
    }
    const timestamp = now();
    db.update(users)
      .set({ name: user.name, email: user.email, fastTaskModelRefId, updatedAt: timestamp })
      .where(eq(users.id, currentUser.id))
      .run();
    return c.json(serializeUser(db.select().from(users).where(eq(users.id, currentUser.id)).get()!));
  });

  return route;
}
