import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { hashPassword, requireAdmin, type AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { agents, authSessions, modelRefs, providerConfigs, sessions, users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { serializeUser } from "../serializers.ts";
import { canUseModel } from "../services/agent-access.ts";
import { readActiveRunLeaseForUser } from "../services/active-run-lease.ts";
import { deletePiSessions } from "../services/pi-session-storage.ts";
import {
  adminPasswordResetRequestSchema,
  createUserRequestSchema,
  jsonValidator,
  updateUserRoleRequestSchema,
  userRequestSchema,
} from "../validation.ts";
import { activeRunConflictResponse } from "./active-run-conflict.ts";

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

  route.patch("/users/:id", requireAdmin, jsonValidator(updateUserRoleRequestSchema), (c) => {
    const targetId = c.req.param("id");
    if (targetId === c.get("user").id) return c.json({ error: "You cannot change your own role." }, 400);
    const target = db.select().from(users).where(eq(users.id, targetId)).get();
    if (!target) return c.json({ error: "User not found." }, 404);
    db.update(users)
      .set({ role: c.req.valid("json").role, updatedAt: now() })
      .where(eq(users.id, targetId))
      .run();
    return c.json(serializeUser(db.select().from(users).where(eq(users.id, targetId)).get()!));
  });

  route.post("/users/:id/password", requireAdmin, jsonValidator(adminPasswordResetRequestSchema), async (c) => {
    const targetId = c.req.param("id");
    const target = db.select({ id: users.id }).from(users).where(eq(users.id, targetId)).get();
    if (!target) return c.json({ error: "User not found." }, 404);
    const { password } = c.req.valid("json");
    if (password.length < 8) return c.json({ error: "Password must be at least 8 characters." }, 400);
    db.update(users)
      .set({ passwordHash: await hashPassword(password), updatedAt: now() })
      .where(eq(users.id, targetId))
      .run();
    // Drop the target's sessions so the old password cannot keep one alive.
    db.delete(authSessions).where(eq(authSessions.userId, targetId)).run();
    return c.json({ ok: true });
  });

  route.delete("/users/:id", requireAdmin, async (c) => {
    const adminId = c.get("user").id;
    const targetId = c.req.param("id");
    if (targetId === adminId) return c.json({ error: "You cannot delete your own account." }, 400);
    const target = db.select().from(users).where(eq(users.id, targetId)).get();
    if (!target) return c.json({ error: "User not found." }, 404);
    const activeRun = readActiveRunLeaseForUser(targetId);
    if (activeRun) return activeRunConflictResponse(c, activeRun);

    const deletedSessions = db.select().from(sessions).where(eq(sessions.userId, targetId)).all();
    await deletePiSessions(deletedSessions);

    const timestamp = now();
    // Transfer the user's owned resources to the acting admin (so shared agents/
    // models others depend on keep working), then remove the user's own sessions
    // and the account. Provider configs are global, so they just change creator.
    db.transaction((tx) => {
      tx.update(agents).set({ ownerUserId: adminId, updatedAt: timestamp }).where(eq(agents.ownerUserId, targetId)).run();
      tx.update(modelRefs).set({ ownerUserId: adminId, updatedAt: timestamp }).where(eq(modelRefs.ownerUserId, targetId)).run();
      tx.update(providerConfigs).set({ userId: adminId, updatedAt: timestamp }).where(eq(providerConfigs.userId, targetId)).run();
      tx.delete(sessions).where(eq(sessions.userId, targetId)).run();
      tx.delete(authSessions).where(eq(authSessions.userId, targetId)).run();
      tx.delete(users).where(eq(users.id, targetId)).run();
    });
    return c.json({ ok: true });
  });

  // Self profile update: name and fast-task model only. Email/password go through
  // POST /api/auth/account (which requires the current password); role is never
  // read here, so a user cannot escalate their own privileges.
  route.put("/users/:id", jsonValidator(userRequestSchema), async (c) => {
    const currentUser = c.get("user");
    if (c.req.param("id") !== currentUser.id) return c.json({ error: "You can only update your own profile." }, 403);
    const user = c.req.valid("json");
    const fastTaskModelRefId = user.fastTaskModelRefId?.trim() || null;
    if (fastTaskModelRefId && !canUseModel(currentUser.id, fastTaskModelRefId)) {
      return c.json({ error: "Fast task model not found." }, 404);
    }
    const timestamp = now();
    db.update(users)
      .set({ name: user.name, fastTaskModelRefId, updatedAt: timestamp })
      .where(eq(users.id, currentUser.id))
      .run();
    return c.json(serializeUser(db.select().from(users).where(eq(users.id, currentUser.id)).get()!));
  });

  return route;
}
