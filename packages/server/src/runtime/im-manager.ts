import { ensureHome, readHome, resetHome } from "../services/agent-homes.ts";
import {
  admitHomeInput,
  dispatchHome,
  queuedHomeInputs,
  stopHome,
} from "../services/home-events.ts";
import { homeEvents, issues } from "../db/schema.ts";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { applyStreamingEvent, type AgentRunEventEnvelope } from "@carmel-agent/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { imBindings, imInbox, imIntegrations, imOutbox, imSetups } from "../db/im-schema.ts";
import { id, now } from "../db/seed.ts";
import {
  createImTransport,
  ImProviderError,
  splitImText,
  type ImIncoming,
  type ImTransport,
} from "../im/platform.ts";
import {
  assertImAccess,
  completeImPair,
  enqueueImMessage,
  failImAccess,
  finishSetup,
  integrationCredential,
  pollImQr,
  setupState,
  type IntegrationRecord,
} from "../services/im-integrations.ts";
import { readVisibleAgent } from "../services/agent-access.ts";
import { resolveRunModel } from "../services/model-context.ts";
import { hasPendingPiSessionWork } from "../services/pi-session-storage.ts";
import { startDetachedAgentRun } from "./agent-runtime.ts";
import {
  abortAgentRun,
  createRunStream,
  getActiveAgentRunForSession,
  whenRunFinished,
  type ActiveAgentRun,
} from "./run-stream.ts";

type Connection = { version: string; transport: ImTransport };
export function imSessionLink(agentId: string, sessionId?: string) {
  const path = sessionId
    ? `/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`
    : `/agents/${encodeURIComponent(agentId)}/home`;
  try {
    const base = new URL(process.env.CARMEL_PUBLIC_URL ?? "");
    if (["http:", "https:"].includes(base.protocol)) return new URL(path, base).href;
  } catch {
    /* A relative path still identifies the session without a public URL. */
  }
  return path;
}
function activeIntegration(integrationId: string) {
  const row = db.select().from(imIntegrations).where(eq(imIntegrations.id, integrationId)).get();
  if (!row?.enabled) return;
  try {
    assertImAccess(row.userId, row.agentId);
    return row;
  } catch {
    failImAccess(row);
    return;
  }
}
/** Synchronous durable admission: transport acknowledgements never wait for an agent turn. */
export async function receiveImMessage(integrationId: string, event: ImIncoming) {
  const integration = activeIntegration(integrationId);
  const binding = db
    .select()
    .from(imBindings)
    .where(eq(imBindings.integrationId, integrationId))
    .get();
  if (
    !integration ||
    !binding ||
    binding.senderId !== event.senderId ||
    binding.chatId !== event.chatId
  )
    return;
  const command = /^\/(\w+)(?:@\w+)?(?:\s|$)/.exec(event.text.trim())?.[1]?.toLowerCase();
  const inboxId = id("im_input");
  const home = readHome(integration.userId, integration.agentId);
  const queued = home ? queuedHomeInputs(home.sessionId) : 0;
  const control = ["help", "status", "web", "new", "stop", "start", "pair"].includes(command ?? "");
  const tooLarge = event.text.length > 100_000 || event.imageKeys.length > 5;
  let admissionError: string | undefined;
  const inserted = db.transaction(() => {
    const inserted = db
      .insert(imInbox)
      .values({
        id: inboxId,
        integrationId,
        eventId: event.eventId,
        prompt: { text: tooLarge ? "" : event.text },
        imageKeys: tooLarge ? [] : event.imageKeys,
        messageId: event.messageId,
        status: control || tooLarge ? "done" : "queued",
        createdAt: now(),
      })
      .onConflictDoNothing()
      .run();
    if (!inserted.changes || control || tooLarge) return inserted;
    try {
      const admitted = admitHomeInput(integration.userId, integration.agentId, {
        sourceKey: `im:${integrationId}:${event.eventId}`,
        prompt: { text: event.text },
        origin: "im",
        integrationId,
        preparing: event.imageKeys.length > 0,
      });
      db.update(imInbox)
        .set({ homeEventId: admitted.id, sessionId: admitted.sessionId })
        .where(eq(imInbox.id, inboxId))
        .run();
    } catch (error) {
      admissionError = error instanceof Error ? error.message : "Cannot queue this message.";
      db.update(imInbox).set({ status: "done" }).where(eq(imInbox.id, inboxId)).run();
    }
    return inserted;
  });
  if (!inserted.changes) return;
  const reply = (text: string) =>
    enqueueImMessage(integrationId, text, `input:${event.eventId}:ack`, false);
  if (tooLarge) {
    reply("Please send at most 100,000 characters and five images per message.");
    return;
  }
  if (admissionError) {
    reply(admissionError);
    return;
  }
  const sessionId = home?.sessionId ?? binding.sessionId;
  const active = sessionId ? getActiveAgentRunForSession(integration.userId, sessionId) : undefined;
  switch (command) {
    case "help":
    case "start":
    case "pair":
      reply(
        "Talk here or in Carmel: both use Home.\n/new — new context, retain history and jobs\n/stop — stop Home and clear pending messages across channels\n/status — connection and Home queue\n/web — open Home\n/help — commands",
      );
      return;
    case "stop":
      if (home) await stopHome(integration.userId, integration.agentId);
      else {
        if (active) abortAgentRun(integration.userId, active.runId);
        db.update(imInbox)
          .set({ status: "interrupted" })
          .where(and(eq(imInbox.integrationId, integrationId), eq(imInbox.status, "queued")))
          .run();
      }
      reply(
        "Home stopped. Pending Home messages across channels cleared; background jobs continue.",
      );
      return;
    case "new":
      if (active || queued)
        reply(
          "Finish or stop the current Home reply and pending messages before starting a new context.",
        );
      else {
        try {
          if (home) await resetHome(integration.userId, integration.agentId);
          reply(
            "Fresh Home context. Earlier history, saved memory, and background jobs are retained.",
          );
        } catch (error) {
          reply(error instanceof Error ? error.message : "Cannot reset Home.");
        }
      }
      return;
    case "status": {
      const work = db
        .select({ status: issues.status })
        .from(issues)
        .where(and(eq(issues.userId, integration.userId), eq(issues.agentId, integration.agentId)))
        .all();
      reply(
        `${integration.botName}: ${integration.status}. Home ${active ? "replying" : "idle"}. ${queued} pending message(s). ${work.filter((issue) => issue.status === "in_progress").length} issue(s) running, ${work.filter((issue) => ["in_review", "needs_input", "blocked"].includes(issue.status)).length} need attention.`,
      );
      return;
    }
    case "web":
      reply(imSessionLink(integration.agentId));
      return;
  }
  if (queued || active)
    reply("Message queued in Home. /stop clears pending Home messages across channels.");
}
export function recoverImWork() {
  db.transaction(() => {
    // A send interrupted between the provider accepting it and our commit is ambiguous.
    db.update(imOutbox)
      .set({
        status: "uncertain",
        error: "Server restarted during delivery. Check the chat before resending.",
      })
      .where(eq(imOutbox.status, "sending"))
      .run();
    for (const input of db
      .select()
      .from(imInbox)
      .where(and(eq(imInbox.status, "running"), isNull(imInbox.homeEventId)))
      .all()) {
      db.update(imInbox).set({ status: "interrupted" }).where(eq(imInbox.id, input.id)).run();
      if (activeIntegration(input.integrationId))
        enqueueImMessage(
          input.integrationId,
          "The server restarted during your last turn. Check its history in Carmel before sending it again.",
          `interrupted:${input.id}`,
          false,
          input.sessionId ?? undefined,
        );
    }
  });
}
export class ImManager {
  private connections = new Map<string, Connection>();
  private working = new Set<string>();
  private jobs = new Set<Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopped = false;
  constructor(private transportFactory = createImTransport) {}
  start() {
    if (this.timer) return;
    this.stopped = false;
    recoverImWork();
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    void this.tick();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const connection of this.connections.values()) connection.transport.stop();
    this.connections.clear();
  }
  async drain() {
    await Promise.allSettled(this.jobs);
  }
  private launch(key: string, job: () => Promise<unknown>) {
    if (this.working.has(key) || this.stopped) return;
    this.working.add(key);
    const pending = job()
      .catch(() => {
        /* Each boundary records its sanitized error. */
      })
      .finally(() => {
        this.working.delete(key);
        this.jobs.delete(pending);
      });
    this.jobs.add(pending);
  }
  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const desired = new Set<string>();
      for (const setup of db
        .select()
        .from(imSetups)
        .where(inArray(imSetups.status, ["authorizing", "pairing"]))
        .all()) {
        if (setup.expiresAt <= now()) {
          finishSetup(setup.id, "expired");
          continue;
        }
        try {
          assertImAccess(setup.userId, setup.agentId);
        } catch {
          finishSetup(setup.id, "cancelled");
          continue;
        }
        if (setup.status === "authorizing") {
          if (setup.nextPollAt <= now())
            this.launch(`qr:${setup.id}`, async () => {
              try {
                await pollImQr(setup);
              } catch {
                finishSetup(
                  setup.id,
                  "error",
                  "Registration failed. Retry or connect an existing app.",
                );
              }
            });
          continue;
        }
        const key = `setup:${setup.id}`;
        desired.add(key);
        if (!this.connections.has(key)) {
          let state;
          try {
            state = setupState(setup);
          } catch {
            finishSetup(
              setup.id,
              "error",
              "Cannot decrypt setup credentials. Check CARMEL_SECRET_KEY and start setup again.",
            );
            continue;
          }
          if (!state.credential) continue;
          this.connect(key, setup.id, {
            platform: setup.platform,
            credential: state.credential,
            offset: setup.offset,
            receive: async (event) => {
              if (completeImPair(setup.id, event)) {
                this.connections.get(key)?.transport.stop();
                this.connections.delete(key);
              }
            },
            checkpoint: (offset) =>
              db.update(imSetups).set({ offset }).where(eq(imSetups.id, setup.id)).run(),
            health: (error) =>
              db
                .update(imSetups)
                .set({ error: error ?? null })
                .where(and(eq(imSetups.id, setup.id), eq(imSetups.status, "pairing")))
                .run(),
          });
        }
      }
      for (const row of db
        .select()
        .from(imIntegrations)
        .where(eq(imIntegrations.enabled, true))
        .all()) {
        if (!activeIntegration(row.id)) continue;
        const key = `integration:${row.id}`;
        desired.add(key);
        const version = String(row.updatedAt);
        if (this.connections.get(key)?.version !== version) {
          this.connections.get(key)?.transport.stop();
          this.connections.delete(key);
          try {
            this.connect(key, version, {
              platform: row.platform,
              credential: integrationCredential(row.id),
              offset: row.offset,
              receive: (event) => receiveImMessage(row.id, event),
              checkpoint: (offset) =>
                db
                  .update(imIntegrations)
                  .set({ offset })
                  .where(eq(imIntegrations.id, row.id))
                  .run(),
              health: (error) => {
                if (this.connections.get(key)?.version !== version) return;
                db.update(imIntegrations)
                  .set({ status: error ? "error" : "connected", error: error ?? null })
                  .where(eq(imIntegrations.id, row.id))
                  .run();
              },
            });
          } catch {
            db.update(imIntegrations)
              .set({
                status: "error",
                error: "Cannot decrypt messaging credentials. Check CARMEL_SECRET_KEY.",
              })
              .where(eq(imIntegrations.id, row.id))
              .run();
          }
        }
        if (this.connections.has(key)) {
          this.launch(`inbox:${row.id}`, () => this.runNext(row));
          this.launch(`outbox:${row.id}`, () => this.flushOutbox(row.id));
        }
      }
      for (const [key, connection] of this.connections)
        if (!desired.has(key)) {
          connection.transport.stop();
          this.connections.delete(key);
        }
    } finally {
      this.ticking = false;
    }
  }
  private connect(key: string, version: string, options: Parameters<typeof createImTransport>[0]) {
    const transport = this.transportFactory(options);
    this.connections.set(key, { version, transport });
    void transport
      .start()
      .catch(() =>
        options.health(
          "Cannot connect to the messaging service. Check credentials, permissions, and event subscriptions.",
        ),
      );
  }
  async flushOutbox(integrationId: string) {
    for (const delivery of db
      .select()
      .from(imOutbox)
      .where(and(eq(imOutbox.integrationId, integrationId), eq(imOutbox.status, "pending")))
      .orderBy(asc(imOutbox.createdAt), asc(sql`rowid`))
      .limit(10)
      .all()) {
      if (delivery.nextAttemptAt > now()) return;
      const integration = activeIntegration(integrationId);
      const binding = db
        .select()
        .from(imBindings)
        .where(eq(imBindings.integrationId, integrationId))
        .get();
      if (!integration || !binding || (delivery.proactive && !integration.proactive)) {
        db.update(imOutbox)
          .set({ status: "cancelled", error: "Messaging is no longer available." })
          .where(eq(imOutbox.id, delivery.id))
          .run();
        continue;
      }
      const transport = this.connections.get(`integration:${integrationId}`)?.transport;
      if (!transport || this.stopped) return;
      const chunks = splitImText(delivery.text);
      const providerIds = [...delivery.providerIds];
      for (let index = delivery.nextChunk; index < chunks.length; index++) {
        const current = activeIntegration(integrationId);
        if (!current || (delivery.proactive && !current.proactive) || this.stopped) return;
        db.update(imOutbox).set({ status: "sending" }).where(eq(imOutbox.id, delivery.id)).run();
        try {
          const providerId = await transport.send(
            binding.chatId,
            chunks[index],
            `${delivery.id}:${index}`,
            providerIds[index],
          );
          providerIds[index] = providerId;
          const stillEnabled = activeIntegration(integrationId);
          const canContinue = stillEnabled && (!delivery.proactive || stillEnabled.proactive);
          db.update(imOutbox)
            .set({
              status: index + 1 === chunks.length ? "sent" : canContinue ? "pending" : "cancelled",
              providerIds,
              nextChunk: index + 1,
              error: null,
            })
            .where(eq(imOutbox.id, delivery.id))
            .run();
        } catch (error) {
          const attempts = delivery.attempts + 1;
          const retry =
            error instanceof ImProviderError && error.retryAfterMs !== undefined && attempts < 8;
          db.update(imOutbox)
            .set({
              attempts,
              status:
                error instanceof ImProviderError && error.uncertain
                  ? "uncertain"
                  : retry
                    ? "pending"
                    : "failed",
              error:
                error instanceof ImProviderError ? error.message : "Cannot deliver the message.",
              nextAttemptAt:
                now() +
                (retry
                  ? Math.max(error.retryAfterMs!, Math.min(300_000, 1000 * 2 ** attempts))
                  : 0),
            })
            .where(eq(imOutbox.id, delivery.id))
            .run();
          // Preserve ordering when a provider asks us to wait.
          return;
        }
      }
    }
  }
  private async runNext(snapshot: IntegrationRecord) {
    const input = db
      .select()
      .from(imInbox)
      .where(and(eq(imInbox.integrationId, snapshot.id), eq(imInbox.status, "queued")))
      .orderBy(asc(imInbox.createdAt), asc(sql`rowid`))
      .get();
    if (!input) return;
    if (!input.legacy) {
      const event = input.homeEventId
        ? db.select().from(homeEvents).where(eq(homeEvents.id, input.homeEventId)).get()
        : undefined;
      if (!event) return;
      if (event.status === "preparing") {
        try {
          const transport = this.connections.get(`integration:${snapshot.id}`)?.transport;
          if (!transport) return;
          const images = [];
          for (const key of input.imageKeys)
            images.push(await transport.image(key, input.messageId ?? undefined));
          if (!activeIntegration(snapshot.id) || this.stopped) return;
          db.update(homeEvents)
            .set({ prompt: { ...input.prompt, images }, status: "queued" })
            .where(and(eq(homeEvents.id, event.id), eq(homeEvents.status, "preparing")))
            .run();
        } catch {
          db.update(homeEvents)
            .set({
              status: "failed",
              error: "Cannot download this image. Send it again.",
              finishedAt: now(),
            })
            .where(eq(homeEvents.id, event.id))
            .run();
          db.update(imInbox).set({ status: "done" }).where(eq(imInbox.id, input.id)).run();
          enqueueImMessage(
            snapshot.id,
            "Cannot download this image. Send it again.",
            `image-error:${input.id}`,
            false,
            event.sessionId,
          );
          return;
        }
      }
      await dispatchHome(event.sessionId);
      return;
    }
    const binding = db
      .select()
      .from(imBindings)
      .where(eq(imBindings.integrationId, snapshot.id))
      .get();
    let session = input.sessionId
      ? db.select().from(sessions).where(eq(sessions.id, input.sessionId)).get()
      : undefined;
    if (session && getActiveAgentRunForSession(snapshot.userId, session.id)) return;
    if (session && (await hasPendingPiSessionWork(session.id))) {
      // Restarted Durable work requires the person's decision to resume or stop.
      db.update(imInbox).set({ status: "interrupted" }).where(eq(imInbox.id, input.id)).run();
      enqueueImMessage(
        snapshot.id,
        "This conversation has interrupted work. Resume or stop it in Carmel, or use /new for a fresh conversation.",
        `pending:${input.id}`,
        false,
      );
      return;
    }
    try {
      const transport = this.connections.get(`integration:${snapshot.id}`)?.transport;
      if (!transport || !binding) return;
      const images = [];
      for (const imageKey of input.imageKeys)
        images.push(await transport.image(imageKey, input.messageId ?? undefined));
      const integration = activeIntegration(snapshot.id);
      if (
        !integration ||
        this.stopped ||
        db.select().from(imInbox).where(eq(imInbox.id, input.id)).get()?.status !== "queued"
      )
        return;
      const agent = readVisibleAgent(integration.userId, integration.agentId)!;
      if (
        session &&
        (session.userId !== integration.userId ||
          session.agentId !== agent.id ||
          session.issueId ||
          session.taskId ||
          session.archivedAt)
      )
        session = undefined;
      const model = await resolveRunModel(
        integration.userId,
        session?.modelRefId ?? agent.defaultModelRefId,
        session?.thinkingLevel ?? agent.defaultThinkingLevel,
      );
      if (!model.ok)
        throw new Error("The agent's model is unavailable. Configure a usable model in Carmel.");
      const current = activeIntegration(snapshot.id);
      const currentBinding = db
        .select()
        .from(imBindings)
        .where(eq(imBindings.integrationId, snapshot.id))
        .get();
      if (
        !current ||
        this.stopped ||
        current.updatedAt !== integration.updatedAt ||
        currentBinding?.sessionId !== binding.sessionId ||
        db.select().from(imInbox).where(eq(imInbox.id, input.id)).get()?.status !== "queued"
      )
        return;
      if (session) {
        const latest = db.select().from(sessions).where(eq(sessions.id, session.id)).get();
        if (
          !latest ||
          latest.revision !== session.revision ||
          getActiveAgentRunForSession(current.userId, latest.id)
        )
          return;
        session = latest;
      }
      if (!session)
        session = db
          .select()
          .from(sessions)
          .where(eq(sessions.id, ensureHome(current.userId, agent.id).sessionId))
          .get()!;
      db.update(imInbox)
        .set({ status: "running", sessionId: session.id })
        .where(eq(imInbox.id, input.id))
        .run();
      const run = startDetachedAgentRun({
        agent,
        session,
        ...model.value,
        promptInput: { ...input.prompt, images: images.length ? images : undefined },
      });
      db.update(imInbox).set({ runId: run.runId }).where(eq(imInbox.id, input.id)).run();
      const observed = await this.observeRun(current, binding.chatId, run, transport);
      const result = await whenRunFinished(run);
      db.transaction(() => {
        db.update(imInbox).set({ status: "done" }).where(eq(imInbox.id, input.id)).run();
        if (!activeIntegration(current.id)) return;
        const text =
          result.outcome === "succeeded"
            ? observed.text ||
              "The agent finished without a text response. Open Carmel to see its work."
            : `The run ${result.outcome === "cancelled" ? "was stopped" : result.outcome === "interrupted" ? "was interrupted" : "failed"}. Open Carmel for details.`;
        const delivery = enqueueImMessage(
          current.id,
          text,
          `result:${input.id}`,
          false,
          session!.id,
        );
        if (observed.previewId)
          db.update(imOutbox)
            .set({ providerIds: [observed.previewId] })
            .where(eq(imOutbox.id, delivery.id))
            .run();
      });
    } catch (error) {
      db.update(imInbox).set({ status: "done" }).where(eq(imInbox.id, input.id)).run();
      if (activeIntegration(snapshot.id))
        enqueueImMessage(
          snapshot.id,
          error instanceof Error &&
            /^(The agent's model|Cannot download|The image)/.test(error.message)
            ? error.message
            : "Cannot process this message. Check the conversation and model settings in Carmel.",
          `error:${input.id}`,
          false,
        );
    }
  }
  private async observeRun(
    integration: IntegrationRecord,
    chatId: string,
    run: ActiveAgentRun,
    transport: ImTransport,
  ) {
    const reader = createRunStream(run).body!.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let message: AgentMessage | undefined;
    let text = "";
    let previewId: string | undefined;
    let previewDisabled = false;
    let lastPreview = now();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        pending += decoder.decode(part.value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const { event } = JSON.parse(pending.slice(0, newline)) as AgentRunEventEnvelope;
          pending = pending.slice(newline + 1);
          if (event.type === "message_start" || event.type === "message_update")
            message = applyStreamingEvent(message, event);
          else if (event.type === "message_end") message = event.message;
          if (message?.role !== "assistant") continue;
          const currentText = message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");
          if (currentText) text = currentText;
          if (
            !previewDisabled &&
            currentText &&
            now() - lastPreview > 2000 &&
            activeIntegration(integration.id) &&
            !this.stopped
          ) {
            lastPreview = now();
            try {
              previewId = await transport.send(
                chatId,
                splitImText(currentText)[0],
                `preview:${run.runId}`,
                previewId,
              );
            } catch {
              previewDisabled = true;
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { text, previewId };
  }
}
const manager = new ImManager();
export const startImManager = () => manager.start();
export const stopImManager = () => manager.stop();
export const drainImManager = () => manager.drain();
