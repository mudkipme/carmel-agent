import { homeEvents } from "../db/schema.ts";
import { readHome } from "./agent-homes.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import QRCode from "qrcode";
import type { ImDelivery, ImIntegration, ImPlatform, ImSetup } from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import {
  imBindings,
  imCredentials,
  imInbox,
  imIntegrations,
  imOutbox,
  imSetups,
} from "../db/im-schema.ts";
import { id, now } from "../db/seed.ts";
import { protectSecret, revealSecret } from "../security.ts";
import { readVisibleAgent } from "./agent-access.ts";
import {
  validateImCredential,
  type BotIdentity,
  type ImCredential,
  type ImIncoming,
} from "../im/platform.ts";

export type IntegrationRecord = typeof imIntegrations.$inferSelect;
export type SetupRecord = typeof imSetups.$inferSelect;
export type SetupState = {
  credential?: ImCredential;
  pairToken?: string;
  deviceCode?: string;
  region?: "feishu" | "lark";
  verificationUrl?: string;
  qrDataUrl?: string;
};
export class ImError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
export function assertImAccess(userId: string, agentId: string) {
  if (
    !db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get() ||
    !readVisibleAgent(userId, agentId)
  )
    throw new ImError("Agent not found.", 404);
}
export function encryptIm(value: unknown) {
  if (!process.env.CARMEL_SECRET_KEY)
    throw new ImError("Set CARMEL_SECRET_KEY before connecting a messaging integration.");
  return protectSecret(JSON.stringify(value))!;
}
export function setupState(row: SetupRecord): SetupState {
  return JSON.parse(revealSecret(row.state)!);
}
export function integrationCredential(integrationId: string): ImCredential {
  const row = db
    .select()
    .from(imCredentials)
    .where(eq(imCredentials.integrationId, integrationId))
    .get();
  if (!row) throw new ImError("Messaging credentials are unavailable.");
  return JSON.parse(revealSecret(row.value)!);
}
export function ownedIntegration(userId: string, agentId: string, integrationId: string) {
  assertImAccess(userId, agentId);
  const row = db.select().from(imIntegrations).where(eq(imIntegrations.id, integrationId)).get();
  if (!row || row.userId !== userId || row.agentId !== agentId)
    throw new ImError("Integration not found.", 404);
  return row;
}
export function ownedSetup(userId: string, agentId: string, setupId: string) {
  assertImAccess(userId, agentId);
  const row = db.select().from(imSetups).where(eq(imSetups.id, setupId)).get();
  if (!row || row.userId !== userId || row.agentId !== agentId)
    throw new ImError("Setup not found.", 404);
  if (row.expiresAt <= now() && ["authorizing", "pairing"].includes(row.status)) {
    finishSetup(row.id, "expired");
    return { ...row, status: "expired" as const };
  }
  return row;
}
export function listImIntegrations(userId: string, agentId: string): ImIntegration[] {
  assertImAccess(userId, agentId);
  return db
    .select()
    .from(imIntegrations)
    .where(and(eq(imIntegrations.agentId, agentId), eq(imIntegrations.userId, userId)))
    .all()
    .map((row) => {
      const binding = db
        .select()
        .from(imBindings)
        .where(eq(imBindings.integrationId, row.id))
        .get();
      return {
        id: row.id,
        agentId: row.agentId,
        platform: row.platform,
        botId: row.botId,
        botName: row.botName,
        enabled: row.enabled,
        proactive: row.proactive,
        notificationDefault: row.notificationDefault,
        status: row.enabled ? row.status : "disabled",
        error: row.error ?? undefined,
        senderId: binding?.senderId ?? "",
        sessionId: readHome(userId, agentId)?.sessionId ?? binding?.sessionId ?? undefined,
        updatedAt: row.updatedAt,
      };
    });
}
export function listImSetups(userId: string, agentId: string): ImSetup[] {
  assertImAccess(userId, agentId);
  const rows = db
    .select()
    .from(imSetups)
    .where(and(eq(imSetups.userId, userId), eq(imSetups.agentId, agentId)))
    .orderBy(desc(imSetups.createdAt))
    .all();
  const seen = new Set<ImPlatform>();
  return rows
    .filter((row) => {
      if (seen.has(row.platform)) return false;
      seen.add(row.platform);
      return row.status !== "completed" && row.status !== "cancelled";
    })
    .map((row) => serializeImSetup(ownedSetup(userId, agentId, row.id)));
}
export function listImDeliveries(
  userId: string,
  agentId: string,
  sessionId?: string,
): ImDelivery[] {
  assertImAccess(userId, agentId);
  const integrations = db
    .select({ id: imIntegrations.id, platform: imIntegrations.platform })
    .from(imIntegrations)
    .where(and(eq(imIntegrations.agentId, agentId), eq(imIntegrations.userId, userId)))
    .all();
  if (!integrations.length) return [];
  const rows = db
    .select()
    .from(imOutbox)
    .where(
      and(
        inArray(
          imOutbox.integrationId,
          integrations.map((row) => row.id),
        ),
        sessionId ? eq(imOutbox.sessionId, sessionId) : undefined,
      ),
    )
    .orderBy(desc(imOutbox.createdAt))
    .limit(50)
    .all();
  return rows.map((row) => ({
    id: row.id,
    platform: integrations.find((item) => item.id === row.integrationId)!.platform,
    status: row.status,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
  }));
}
export function updateImIntegration(
  userId: string,
  agentId: string,
  integrationId: string,
  patch: {
    enabled?: boolean;
    proactive?: boolean;
    notificationDefault?: boolean;
  },
) {
  const current = ownedIntegration(userId, agentId, integrationId);
  db.transaction((tx) => {
    if (patch.notificationDefault)
      tx.update(imIntegrations)
        .set({ notificationDefault: false })
        .where(and(eq(imIntegrations.agentId, agentId), eq(imIntegrations.userId, userId)))
        .run();
    tx.update(imIntegrations)
      .set({
        ...patch,
        updatedAt: Math.max(now(), current.updatedAt + 1),
        ...(patch.enabled ? { status: "connecting" as const, error: null } : {}),
      })
      .where(eq(imIntegrations.id, integrationId))
      .run();
    if (patch.enabled === false) {
      tx.update(homeEvents)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(homeEvents.integrationId, integrationId),
            inArray(homeEvents.status, ["preparing", "queued"]),
          ),
        )
        .run();
      tx.update(imOutbox)
        .set({ status: "cancelled", error: "Integration disabled." })
        .where(and(eq(imOutbox.integrationId, integrationId), eq(imOutbox.status, "pending")))
        .run();
      tx.update(imInbox)
        .set({ status: "interrupted" })
        .where(and(eq(imInbox.integrationId, integrationId), eq(imInbox.status, "queued")))
        .run();
    } else if (patch.proactive === false)
      tx.update(imOutbox)
        .set({ status: "cancelled", error: "Proactive messages disabled." })
        .where(
          and(
            eq(imOutbox.integrationId, integrationId),
            eq(imOutbox.proactive, true),
            eq(imOutbox.status, "pending"),
          ),
        )
        .run();
  });
}
export function deleteImIntegration(userId: string, agentId: string, integrationId: string) {
  const current = ownedIntegration(userId, agentId, integrationId);
  cancelSetups(userId, agentId, current.platform);
  db.update(homeEvents)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(homeEvents.integrationId, integrationId),
        inArray(homeEvents.status, ["preparing", "queued"]),
      ),
    )
    .run();
  db.delete(imIntegrations).where(eq(imIntegrations.id, integrationId)).run();
}
function cancelSetups(userId: string, agentId: string, platform: ImPlatform) {
  db.update(imSetups)
    .set({ status: "cancelled", state: "{}" })
    .where(
      and(
        eq(imSetups.userId, userId),
        eq(imSetups.agentId, agentId),
        eq(imSetups.platform, platform),
        inArray(imSetups.status, ["authorizing", "pairing"]),
      ),
    )
    .run();
}
export function finishSetup(setupId: string, status: ImSetup["status"], error?: string) {
  db.update(imSetups)
    .set({ status, state: "{}", error: error ?? null })
    .where(eq(imSetups.id, setupId))
    .run();
}
function assertBotAvailable(userId: string, agentId: string, platform: ImPlatform, botId: string) {
  const existing = db
    .select()
    .from(imIntegrations)
    .where(and(eq(imIntegrations.platform, platform), eq(imIntegrations.botId, botId)))
    .get();
  if (existing && (existing.userId !== userId || existing.agentId !== agentId))
    throw new ImError(
      "This bot is already assigned to another integration. Use a dedicated bot.",
      409,
    );
  const staging = db
    .select()
    .from(imSetups)
    .where(
      and(
        eq(imSetups.platform, platform),
        eq(imSetups.botId, botId),
        eq(imSetups.status, "pairing"),
      ),
    )
    .all();
  if (
    staging.some(
      (row) => row.expiresAt > now() && (row.userId !== userId || row.agentId !== agentId),
    )
  )
    throw new ImError("This bot already has a pending setup. Use a dedicated bot.", 409);
  return existing;
}
export async function beginImConnect(
  userId: string,
  agentId: string,
  platform: ImPlatform,
  credential: ImCredential,
): Promise<ImSetup> {
  assertImAccess(userId, agentId);
  encryptIm({});
  const identity = await validateImCredential(platform, credential);
  assertImAccess(userId, agentId);
  const existing = assertBotAvailable(userId, agentId, platform, identity.id);
  const state: SetupState = { credential, pairToken: randomBytes(24).toString("base64url") };
  const row = createSetup(userId, agentId, platform, "pairing", state, identity);
  // Credential rotation on the same bot retains its already verified person.
  if (existing) {
    const binding = db
      .select()
      .from(imBindings)
      .where(eq(imBindings.integrationId, existing.id))
      .get();
    if (binding)
      completeImPair(row.id, {
        senderId: binding.senderId,
        chatId: binding.chatId,
        text: `/pair ${state.pairToken}`,
        eventId: "rotation",
        imageKeys: [],
      });
  }
  return serializeImSetup(db.select().from(imSetups).where(eq(imSetups.id, row.id)).get()!);
}
function createSetup(
  userId: string,
  agentId: string,
  platform: ImPlatform,
  status: ImSetup["status"],
  state: SetupState,
  identity?: BotIdentity,
  expiresAt = now() + 600_000,
  interval = 5000,
) {
  assertImAccess(userId, agentId);
  const row: SetupRecord = {
    id: id("im_setup"),
    userId,
    agentId,
    platform,
    status,
    state: encryptIm(state),
    createdAt: now(),
    botId: identity?.id ?? null,
    botName: identity?.name ?? null,
    offset: 0,
    expiresAt,
    interval,
    nextPollAt: now() + interval,
    error: null,
  };
  db.transaction(() => {
    cancelSetups(userId, agentId, platform);
    db.insert(imSetups).values(row).run();
  });
  return row;
}
const accountBase = (region: "feishu" | "lark") =>
  region === "lark" ? "https://accounts.larksuite.com" : "https://accounts.feishu.cn";
async function registration(
  region: "feishu" | "lark",
  action: string,
  params: Record<string, string> = {},
) {
  let response: Response;
  try {
    response = await fetch(`${accountBase(region)}/oauth/v1/app/registration`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ImError("Cannot reach Feishu/Lark registration. Retry or connect an existing app.");
  }
  const raw = await response.text();
  if (raw.length > 1024 * 1024) throw new ImError("Invalid registration response.");
  let result: Record<string, any>;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new ImError("Invalid registration response.");
  }
  // Device registration uses HTTP 400 for normal OAuth polling states, including
  // authorization_pending before the person has scanned or approved the QR code.
  const pollingState =
    action === "poll" &&
    response.status === 400 &&
    ["authorization_pending", "slow_down", "access_denied", "expired_token"].includes(
      result?.error,
    );
  if (!response.ok && !pollingState)
    throw new ImError(`Feishu/Lark registration returned HTTP ${response.status}.`);
  return result;
}
export async function beginImQr(userId: string, agentId: string, platform: "feishu" | "lark") {
  assertImAccess(userId, agentId);
  encryptIm({});
  // Start at Feishu and follow only the known tenant-brand switch.
  const init = await registration("feishu", "init");
  if (
    init.error ||
    (init.supported_auth_methods?.length && !init.supported_auth_methods.includes("client_secret"))
  )
    throw new ImError("QR app registration is unavailable. Connect an existing app instead.");
  const begin = await registration("feishu", "begin", {
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  if (begin.error || !begin.device_code || !begin.verification_uri_complete)
    throw new ImError("Cannot start QR registration. Connect an existing app instead.");
  const url = new URL(begin.verification_uri_complete);
  if (
    url.protocol !== "https:" ||
    !["feishu.cn", "larksuite.com"].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  )
    throw new ImError("Registration returned an unsupported verification URL.");
  assertImAccess(userId, agentId);
  const row = createSetup(
    userId,
    agentId,
    platform,
    "authorizing",
    {
      deviceCode: begin.device_code,
      region: "feishu",
      verificationUrl: url.href,
      qrDataUrl: await QRCode.toDataURL(url.href, { width: 256, margin: 2 }),
    },
    undefined,
    now() + Math.min(600, Math.max(1, Number(begin.expire_in) || 600)) * 1000,
    Math.max(5000, Number(begin.interval) * 1000 || 5000),
  );
  return serializeImSetup(row);
}
export async function pollImQr(row: SetupRecord) {
  const state = setupState(row);
  if (!state.deviceCode) return;
  const poll = await registration(state.region ?? "feishu", "poll", {
    device_code: state.deviceCode,
  });
  let current = db.select().from(imSetups).where(eq(imSetups.id, row.id)).get();
  if (!current || current.status !== "authorizing" || current.expiresAt <= now()) return;
  assertImAccess(row.userId, row.agentId);
  if (String(poll.user_info?.tenant_brand).toLowerCase() === "lark" && state.region !== "lark") {
    db.update(imSetups)
      .set({ state: encryptIm({ ...state, region: "lark" }), nextPollAt: now() + row.interval })
      .where(eq(imSetups.id, row.id))
      .run();
    return;
  }
  if (poll.client_id && poll.client_secret) {
    const platform = state.region === "lark" ? "lark" : "feishu";
    const credential = { appId: String(poll.client_id), appSecret: String(poll.client_secret) };
    let identity: BotIdentity;
    let connectionError: string | null = null;
    try {
      identity = await validateImCredential(platform, credential);
    } catch {
      // App creation already succeeded. Keep its credentials while the user fixes publishing/permissions.
      identity = { id: credential.appId, name: credential.appId };
      connectionError =
        "Bot created. Check bot capability, app publishing, permissions, and long-connection event subscriptions, then send the pairing command. Carmel will retry the connection.";
    }
    current = db.select().from(imSetups).where(eq(imSetups.id, row.id)).get();
    if (!current || current.status !== "authorizing" || current.expiresAt <= now()) return;
    assertImAccess(row.userId, row.agentId);
    assertBotAvailable(row.userId, row.agentId, platform, identity.id);
    db.update(imSetups)
      .set({
        platform,
        botId: identity.id,
        botName: identity.name,
        status: "pairing",
        error: connectionError,
        expiresAt: now() + 600_000,
        state: encryptIm({ credential, pairToken: randomBytes(24).toString("base64url") }),
      })
      .where(eq(imSetups.id, row.id))
      .run();
    return;
  }
  if (["access_denied", "expired_token"].includes(poll.error)) {
    finishSetup(row.id, poll.error === "access_denied" ? "denied" : "expired");
    return;
  }
  if (poll.error && !["authorization_pending", "slow_down"].includes(poll.error)) {
    finishSetup(
      row.id,
      "error",
      "Feishu/Lark registration failed. Retry or connect an existing app.",
    );
    return;
  }
  const interval = row.interval + (poll.error === "slow_down" ? 5000 : 0);
  db.update(imSetups)
    .set({ interval, nextPollAt: now() + interval })
    .where(eq(imSetups.id, row.id))
    .run();
}
export function serializeImSetup(row: SetupRecord): ImSetup {
  const state = ["authorizing", "pairing"].includes(row.status) ? setupState(row) : {};
  const pairToken = state.pairToken;
  return {
    id: row.id,
    platform: row.platform,
    status: row.status,
    expiresAt: row.expiresAt,
    verificationUrl: state.verificationUrl,
    qrDataUrl: state.qrDataUrl,
    pairCommand: pairToken ? `/pair ${pairToken}` : undefined,
    botName: row.botName ?? undefined,
    error: row.error ?? undefined,
    botUrl:
      row.status === "pairing"
        ? row.platform === "telegram"
          ? `https://t.me/${encodeURIComponent(row.botName!)}?start=${pairToken}`
          : `https://applink.${row.platform === "lark" ? "larksuite.com" : "feishu.cn"}/client/bot/open?appId=${encodeURIComponent(row.botId!)}`
        : undefined,
  };
}
export function completeImPair(setupId: string, event: ImIncoming): string | undefined {
  const row = db.select().from(imSetups).where(eq(imSetups.id, setupId)).get();
  if (!row || row.status !== "pairing" || row.expiresAt <= now()) return;
  assertImAccess(row.userId, row.agentId);
  const state = setupState(row);
  const supplied = /^\/(?:pair|start)(?:@\w+)?\s+([A-Za-z0-9_-]+)$/.exec(event.text.trim())?.[1];
  if (
    !supplied ||
    !state.pairToken ||
    !timingSafeEqual(
      createHash("sha256").update(supplied).digest(),
      createHash("sha256").update(state.pairToken).digest(),
    )
  )
    return;
  assertBotAvailable(row.userId, row.agentId, row.platform, row.botId!);
  const current = db
    .select()
    .from(imIntegrations)
    .where(
      and(
        eq(imIntegrations.agentId, row.agentId),
        eq(imIntegrations.userId, row.userId),
        eq(imIntegrations.platform, row.platform),
      ),
    )
    .get();
  const sameBot = current?.botId === row.botId;
  const integrationId = sameBot ? current!.id : id("im");
  db.transaction((tx) => {
    if (current && !sameBot)
      tx.delete(imIntegrations).where(eq(imIntegrations.id, current.id)).run();
    if (sameBot)
      tx.update(imIntegrations)
        .set({
          enabled: true,
          status: "connecting",
          error: null,
          botName: row.botName!,
          updatedAt: Math.max(now(), current!.updatedAt + 1),
        })
        .where(eq(imIntegrations.id, integrationId))
        .run();
    else
      tx.insert(imIntegrations)
        .values({
          id: integrationId,
          agentId: row.agentId,
          userId: row.userId,
          platform: row.platform,
          botId: row.botId!,
          botName: row.botName!,
          status: "connecting",
          updatedAt: now(),
        })
        .run();
    tx.insert(imCredentials)
      .values({ integrationId, value: encryptIm(state.credential) })
      .onConflictDoUpdate({
        target: imCredentials.integrationId,
        set: { value: encryptIm(state.credential) },
      })
      .run();
    tx.insert(imBindings)
      .values({ integrationId, senderId: event.senderId, chatId: event.chatId })
      .onConflictDoUpdate({
        target: imBindings.integrationId,
        set: { senderId: event.senderId, chatId: event.chatId },
      })
      .run();
    tx.update(imIntegrations)
      .set({
        offset: Math.max(
          sameBot ? current!.offset : 0,
          row.offset,
          row.platform === "telegram" && Number.isSafeInteger(Number(event.eventId))
            ? Number(event.eventId) + 1
            : 0,
        ),
      })
      .where(eq(imIntegrations.id, integrationId))
      .run();
    tx.update(imSetups)
      .set({ status: "completed", state: "{}" })
      .where(eq(imSetups.id, row.id))
      .run();
  });
  enqueueImMessage(
    integrationId,
    "Connected to Carmel Agent. Send a message to start, or /help for commands.",
    `pair:${row.id}`,
    false,
  );
  return integrationId;
}
export function resolveNotificationIntegration(
  userId: string,
  agentId: string,
  platform?: ImPlatform,
) {
  assertImAccess(userId, agentId);
  const candidates = db
    .select()
    .from(imIntegrations)
    .where(
      and(
        eq(imIntegrations.userId, userId),
        eq(imIntegrations.agentId, agentId),
        eq(imIntegrations.enabled, true),
        eq(imIntegrations.proactive, true),
        platform ? eq(imIntegrations.platform, platform) : undefined,
      ),
    )
    .all()
    .filter((row) =>
      db.select().from(imBindings).where(eq(imBindings.integrationId, row.id)).get(),
    );
  const selected =
    platform || candidates.length === 1
      ? candidates[0]
      : candidates.find((row) => row.notificationDefault);
  if (!selected)
    throw new ImError(
      candidates.length
        ? "Choose a messaging platform or set a notification default in Integrations."
        : "No enabled, paired integration allows proactive messages for this agent and user.",
    );
  return selected;
}
export function enqueueImMessage(
  integrationId: string,
  text: string,
  dedupKey: string,
  proactive: boolean,
  sessionId?: string,
): ImDelivery {
  if (!text.trim() || text.length > 100_000)
    throw new ImError("A message must contain between 1 and 100,000 characters.");
  const row = db.select().from(imIntegrations).where(eq(imIntegrations.id, integrationId)).get();
  if (!row) throw new ImError("Integration not found.", 404);
  assertImAccess(row.userId, row.agentId);
  if (!row.enabled || (proactive && !row.proactive))
    throw new ImError("Messaging is disabled for this integration.");
  const deliveryId = id("im_delivery");
  const storedKey = dedupKey.startsWith("tool:") ? dedupKey : `${integrationId}:${dedupKey}`;
  db.insert(imOutbox)
    .values({
      id: deliveryId,
      integrationId,
      dedupKey: storedKey,
      text,
      proactive,
      sessionId,
      status: "pending",
      createdAt: now(),
      nextAttemptAt: now(),
    })
    .onConflictDoNothing()
    .run();
  const delivery = db.select().from(imOutbox).where(eq(imOutbox.dedupKey, storedKey)).get()!;
  const actual =
    delivery.integrationId === row.id
      ? row
      : db
          .select()
          .from(imIntegrations)
          .where(eq(imIntegrations.id, delivery.integrationId))
          .get()!;
  return {
    id: delivery.id,
    platform: actual.platform,
    status: delivery.status,
    error: delivery.error ?? undefined,
    createdAt: delivery.createdAt,
  };
}
export function failImAccess(row: IntegrationRecord) {
  db.transaction((tx) => {
    tx.update(imIntegrations)
      .set({
        enabled: false,
        status: "error",
        error: "The agent is no longer available to this user.",
      })
      .where(eq(imIntegrations.id, row.id))
      .run();
    tx.update(imOutbox)
      .set({ status: "cancelled", error: "Access revoked." })
      .where(and(eq(imOutbox.integrationId, row.id), eq(imOutbox.status, "pending")))
      .run();
    tx.update(imInbox)
      .set({ status: "interrupted" })
      .where(and(eq(imInbox.integrationId, row.id), eq(imInbox.status, "queued")))
      .run();
  });
}
