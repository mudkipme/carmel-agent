import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, error, json, jsonBody, success } from "../openapi/routes.ts";
import { CreateUserRequestSchema, UserSchema } from "../openapi/schemas.ts";
import { asc, eq, inArray } from "drizzle-orm";
import { hashPassword, requireAdmin, type AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import {
  agentHomes,
  agentTaskRuns,
  agentTasks,
  agents,
  environments,
  apiKeys,
  authSessions,
  issues,
  modelRefs,
  providerConfigs,
  providerKeys,
  sessions,
  userIdentities,
  users,
} from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { serializeUser } from "../serializers.ts";
import { readUsableModelRef } from "../services/agent-access.ts";
import { readActiveRunLeaseForUser } from "../services/active-run-lease.ts";
import { deletePiSessions } from "../services/pi-session-storage.ts";
import {
  adminPasswordResetRequestSchema,
  updateUserRoleRequestSchema,
  userRequestSchema,
} from "@carmel-agent/shared";
import { activeRunConflictResponse } from "./active-run-conflict.ts";

export function createUserRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();

  route.openapi(
    createRoute({
      method: "get",
      path: "/users",
      operationId: "listUsers",
      tags: ["Users"],
      middleware: [requireAdmin] as const,
      responses: { 200: json(z.array(UserSchema), "Users") },
    }),
    (c) => {
      return c.json(
        db.select().from(users).orderBy(asc(users.createdAt)).all().map(serializeUser),
        200,
      );
    },
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/users",
      operationId: "createUser",
      tags: ["Users"],
      middleware: [requireAdmin] as const,
      request: { body: jsonBody(CreateUserRequestSchema) },
      responses: { 400: error, 201: json(UserSchema, "User"), 409: error },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const username = body.username.trim();
      if (!username || !body.email.trim())
        return c.json({ error: "Username and email are required." }, 400);
      if (body.password.length < 8)
        return c.json({ error: "Password must be at least 8 characters." }, 400);
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
    },
  );

  route.openapi(
    createRoute({
      method: "patch",
      path: "/users/{id}",
      operationId: "updateUserRole",
      tags: ["Users"],
      middleware: [requireAdmin] as const,
      request: {
        params: z.object({ id: z.string() }),
        body: jsonBody(updateUserRoleRequestSchema),
      },
      responses: { 400: error, 404: error, 200: json(UserSchema, "User") },
    }),
    (c) => {
      const targetId = c.req.param("id");
      if (targetId === c.get("user").id)
        return c.json({ error: "You cannot change your own role." }, 400);
      const target = db.select().from(users).where(eq(users.id, targetId)).get();
      if (!target) return c.json({ error: "User not found." }, 404);
      db.update(users)
        .set({ role: c.req.valid("json").role, updatedAt: now() })
        .where(eq(users.id, targetId))
        .run();
      return c.json(
        serializeUser(db.select().from(users).where(eq(users.id, targetId)).get()!),
        200,
      );
    },
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/users/{id}/password",
      operationId: "resetUserPassword",
      tags: ["Users"],
      middleware: [requireAdmin] as const,
      request: {
        params: z.object({ id: z.string() }),
        body: jsonBody(adminPasswordResetRequestSchema),
      },
      responses: { 400: error, 404: error, 200: success },
    }),
    async (c) => {
      const targetId = c.req.param("id");
      const target = db.select({ id: users.id }).from(users).where(eq(users.id, targetId)).get();
      if (!target) return c.json({ error: "User not found." }, 404);
      const { password } = c.req.valid("json");
      if (password.length < 8)
        return c.json({ error: "Password must be at least 8 characters." }, 400);
      db.update(users)
        .set({ passwordHash: await hashPassword(password), updatedAt: now() })
        .where(eq(users.id, targetId))
        .run();
      // Drop the target's sessions so the old password cannot keep one alive.
      db.delete(authSessions).where(eq(authSessions.userId, targetId)).run();
      return c.json({ ok: true }, 200);
    },
  );

  route.openapi(
    createRoute({
      method: "delete",
      path: "/users/{id}",
      operationId: "deleteUser",
      tags: ["Users"],
      middleware: [requireAdmin] as const,
      request: { params: z.object({ id: z.string() }) },
      responses: { 400: error, 404: error, 200: success, 409: error },
    }),
    async (c) => {
      const adminId = c.get("user").id;
      const targetId = c.req.param("id");
      if (targetId === adminId)
        return c.json({ error: "You cannot delete your own account." }, 400);
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
        tx.update(agents)
          .set({ ownerUserId: adminId, updatedAt: timestamp })
          .where(eq(agents.ownerUserId, targetId))
          .run();
        tx.update(environments)
          .set({ ownerUserId: adminId, updatedAt: timestamp })
          .where(eq(environments.ownerUserId, targetId))
          .run();
        tx.update(modelRefs)
          .set({ ownerUserId: adminId, updatedAt: timestamp })
          .where(eq(modelRefs.ownerUserId, targetId))
          .run();
        tx.update(providerConfigs)
          .set({ userId: adminId, updatedAt: timestamp })
          .where(eq(providerConfigs.userId, targetId))
          .run();
        // Tasks and issues may belong to the target on agents owned by someone
        // else, and provider_keys predates the model catalog. Delete them (and
        // each task's run log) before the user row, or the FKs abort the whole
        // transaction after the transcript files are already gone.
        const taskIds = tx
          .select({ id: agentTasks.id })
          .from(agentTasks)
          .where(eq(agentTasks.userId, targetId))
          .all()
          .map((task) => task.id);
        if (taskIds.length > 0)
          tx.delete(agentTaskRuns).where(inArray(agentTaskRuns.taskId, taskIds)).run();
        tx.delete(agentTasks).where(eq(agentTasks.userId, targetId)).run();
        tx.delete(issues).where(eq(issues.userId, targetId)).run();
        tx.delete(providerKeys).where(eq(providerKeys.userId, targetId)).run();
        tx.delete(agentHomes).where(eq(agentHomes.userId, targetId)).run();
        tx.delete(sessions).where(eq(sessions.userId, targetId)).run();
        tx.delete(authSessions).where(eq(authSessions.userId, targetId)).run();
        tx.delete(apiKeys).where(eq(apiKeys.userId, targetId)).run();
        tx.delete(userIdentities).where(eq(userIdentities.userId, targetId)).run();
        tx.delete(users).where(eq(users.id, targetId)).run();
      });
      return c.json({ ok: true }, 200);
    },
  );

  // Self profile update: name and fast-task model only. Email/password go through
  // POST /api/auth/account (which requires the current password); role is never
  // read here, so a user cannot escalate their own privileges.
  route.openapi(
    createRoute({
      method: "put",
      path: "/users/{id}",
      operationId: "updateUserProfile",
      tags: ["Users"],
      request: { params: z.object({ id: z.string() }), body: jsonBody(userRequestSchema) },
      responses: { 403: error, 404: error, 200: json(UserSchema, "User") },
    }),
    async (c) => {
      const currentUser = c.get("user");
      if (c.req.param("id") !== currentUser.id)
        return c.json({ error: "You can only update your own profile." }, 403);
      const user = c.req.valid("json");
      const fastTaskModelRefId = user.fastTaskModelRefId?.trim() || null;
      if (fastTaskModelRefId && !readUsableModelRef(currentUser.id, fastTaskModelRefId)) {
        return c.json({ error: "Fast task model not found." }, 404);
      }
      const timestamp = now();
      db.update(users)
        .set({ name: user.name, fastTaskModelRefId, updatedAt: timestamp })
        .where(eq(users.id, currentUser.id))
        .run();
      return c.json(
        serializeUser(db.select().from(users).where(eq(users.id, currentUser.id)).get()!),
        200,
      );
    },
  );

  return route;
}
