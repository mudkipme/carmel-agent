import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { AgentDoc, type ConversationId, type EntryDraft, type EntryId } from "@earendil-works/pi-durable";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ActiveConversation, messageDraft, type PiSession } from "./pi-session-storage.ts";
const ctx = BACKGROUND_CONTEXT;
type LegacyRow = { id: string; parent_id: string | null; type: string; custom_type: string | null; timestamp: number; payload: string };
/** Read-only, resumable import. The 0.99 database remains an untouched archive. */
export async function migrateLegacyPiSession(session: PiSession, legacyPath: string) {
  if (!existsSync(legacyPath)) { await complete(session, session.conversation.id); return; }
  const legacy = new Database(legacyPath, { readonly: true, fileMustExist: true });
  try {
    if (!legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scalar_values'").get()) throw new Error("Unsupported legacy Pi SQLite schema; refusing to replace session history.");
    const rows = legacy.prepare("SELECT id,parent_id,type,custom_type,timestamp,payload FROM entries WHERE session_id=? ORDER BY seq").all(session.metadata.id) as LegacyRow[];
    const scalar = (namespace: string) => {
      const row = legacy.prepare("SELECT value FROM scalar_values WHERE session_id=? AND namespace=? AND key='main'").get(session.metadata.id, namespace) as { value: string } | undefined;
      return row ? JSON.parse(row.value) : undefined;
    };
    const mainTip = scalar("pi.branch.tip") as string | null | undefined;
    if (rows.length && mainTip === undefined) throw new Error("Legacy session has history but no main branch tip; migration stopped.");
    let lastEntry: import("@earendil-works/pi-durable").EntryRecord | undefined;
    for (const row of rows) {
      const imported = await session.native.snapshot(ActiveConversation, ctx);
      if (imported?.legacyIds[row.id]) continue;
      const parentId = row.parent_id ? imported?.legacyIds[row.parent_id] : undefined;
      const parent = parentId ? await session.native.commit(tx => tx.entry(parentId as EntryId), ctx) : undefined;
      if (row.parent_id && !parent) throw new Error(`Missing legacy parent ${row.parent_id}; migration stopped.`);
      const payload = JSON.parse(row.payload) as Record<string, JsonValue>;
      const draft: EntryDraft = row.type === "message" ? messageDraft(payload.message as unknown as AgentMessage) : {
        kind: row.type === "compaction" ? "pi.compaction" : `carmel.legacy.${row.type}`,
        ...(row.type === "compaction" ? {
          head: "self" as const,
          model: [{ role: "user" as const, content: `Conversation summary:\n${payload.summary}`, timestamp: row.timestamp }, ...((payload.retainedTail ?? []) as unknown as import("@earendil-works/pi-ai").Message[])],
        } : row.type === "branch_summary" ? { model: [{ role: "user" as const, content: `Branch summary:\n${payload.summary}`, timestamp: row.timestamp }] } : {}),
      };
      await session.native.commit(async tx => {
        const next = parent && lastEntry?.id === parent.id ? { id: parent.conversationId } : parent ? await tx.forkConversation(parent.conversationId, parent.id, { ownership: { kind: "ownerless" } }) : await tx.createConversation({ ownership: { kind: "ownerless" } });
        const entry = await tx.appendEntry(next.id, { ...draft, data: { ...draft.data as object, carmelEntryId: row.id, timestamp: row.timestamp, legacy: { type: row.type, customType: row.custom_type, payload } } });
        (await tx.doc(ActiveConversation)).legacyIds[row.id] = entry.id;
        lastEntry = entry;
      }, ctx);
    }
    const imported = await session.native.snapshot(ActiveConversation, ctx);
    const tipId = mainTip ? imported?.legacyIds[mainTip] : undefined;
    if (mainTip && !tipId) throw new Error(`Missing legacy branch tip ${mainTip}; migration stopped.`);
    const tip = tipId ? await session.native.commit(tx => tx.entry(tipId as EntryId), ctx) : undefined;
    const conversation = tip ? await (await session.native.conversation(tip.conversationId, ctx))!.fork(tip.id, { ownership: { kind: "ownerless" } }, ctx) : session.conversation;
    const config = scalar("pi.lane.config") as { model?: { provider: string; modelId: string }; thinkingLevel?: import("@earendil-works/pi-ai").ModelThinkingLevel; activeToolNames?: string[] } | undefined;
    if (config) await conversation.configure({ model: config.model ? { ...config.model, provider: config.model.provider === "azure-openai-responses" ? "azure" : config.model.provider } : undefined, thinkingLevel: config.thinkingLevel }, ctx);
    if (config?.activeToolNames) await session.native.commit(async tx => { (await tx.doc(AgentDoc, conversation.id)).tools = config.activeToolNames; }, ctx);
    await complete(session, conversation.id);
  } finally { legacy.close(); }
}
async function complete(session: PiSession, id: ConversationId) {
  await session.native.commit(async tx => { const active = await tx.doc(ActiveConversation); active.id = id; active.migrated = true; }, ctx);
}
