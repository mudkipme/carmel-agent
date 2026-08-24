import type { SessionMessage } from "./contracts/messages.ts";

/**
 * Whether a branch is a context a provider will accept.
 *
 * Anthropic and OpenAI both reject a request whose history contains a tool call
 * with no result, or a result with no call. Pi keeps its own branches valid --
 * the agent loop synthesizes an aborted tool result for anything still pending
 * when a run is cancelled -- so the only way Carmel reaches an invalid branch is
 * by moving the leaf itself, which truncate and fork both do by entry id.
 *
 * Pure, and deliberately over `{ entryId, message }` rather than `BranchEntry`:
 * the routes already hold the branch in that shape, so checking a cut point
 * costs no extra read.
 */

export type BranchMessage = { readonly entryId: string; readonly message: SessionMessage };

export type ToolCallRef = {
  readonly entryId: string;
  readonly toolCallId: string;
  readonly toolName: string;
};

export type BranchDefect =
  /** An assistant tool call that nothing answers. Produced by cutting a branch short. */
  | ({ readonly kind: "unanswered_tool_call" } & ToolCallRef)
  /** A tool result whose call is not in the branch. Only reachable by rewriting history. */
  | ({ readonly kind: "orphan_tool_result" } & ToolCallRef);

export function inspectBranchIntegrity(entries: readonly BranchMessage[]): BranchDefect[] {
  const defects: BranchDefect[] = [];
  const open = new Map<string, ToolCallRef>();

  for (const entry of entries) {
    for (const call of toolCallsIn(entry)) open.set(call.toolCallId, call);

    const result = toolResultIn(entry);
    if (!result) continue;
    if (open.delete(result.toolCallId)) continue;
    defects.push({ kind: "orphan_tool_result", ...result });
  }

  for (const call of open.values()) defects.push({ kind: "unanswered_tool_call", ...call });
  return defects;
}

export type CutPointCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly unanswered: readonly ToolCallRef[];
      /**
       * The nearest entry after the requested one that closes every open call,
       * or null when the branch never closes them. Offered rather than applied:
       * silently extending the cut would mean `truncate(entryId)` keeps messages
       * the caller asked to drop.
       */
      readonly safeEntryId: string | null;
    };

/** Would ending the branch at `entryId` leave a tool call unanswered? */
export function checkCutPoint(entries: readonly BranchMessage[], entryId: string): CutPointCheck {
  const cutIndex = entries.findIndex((entry) => entry.entryId === entryId);
  if (cutIndex < 0) return { ok: true };

  const unanswered = unansweredAt(entries, cutIndex);
  if (unanswered.length === 0) return { ok: true };

  let safeEntryId: string | null = null;
  for (let index = cutIndex + 1; index < entries.length; index++) {
    if (unansweredAt(entries, index).length === 0) {
      safeEntryId = entries[index]!.entryId;
      break;
    }
  }
  return { ok: false, unanswered, safeEntryId };
}

function unansweredAt(entries: readonly BranchMessage[], cutIndex: number) {
  return inspectBranchIntegrity(entries.slice(0, cutIndex + 1)).flatMap((defect) =>
    defect.kind === "unanswered_tool_call" ? [{ entryId: defect.entryId, toolCallId: defect.toolCallId, toolName: defect.toolName }] : [],
  );
}

export function describeCutPointRejection(check: Extract<CutPointCheck, { ok: false }>) {
  const names = [...new Set(check.unanswered.map((call) => call.toolName))].join(", ");
  const plural = check.unanswered.length === 1 ? "call" : "calls";
  const remedy = check.safeEntryId
    ? " Cut at the entry that returns them instead."
    : " No later entry in this branch returns them.";
  return `Cutting here would leave ${check.unanswered.length} unanswered tool ${plural} (${names}), which providers reject.${remedy}`;
}

function toolCallsIn({ entryId, message }: BranchMessage): ToolCallRef[] {
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "assistant" || !Array.isArray(record.content)) return [];
  return record.content.flatMap((part) => {
    const candidate = part as { type?: unknown; id?: unknown; name?: unknown };
    if (candidate.type !== "toolCall" || typeof candidate.id !== "string") return [];
    return [{ entryId, toolCallId: candidate.id, toolName: typeof candidate.name === "string" ? candidate.name : "unknown" }];
  });
}

function toolResultIn({ entryId, message }: BranchMessage): ToolCallRef | undefined {
  const record = message as { role?: unknown; toolCallId?: unknown; toolName?: unknown };
  if (record.role !== "toolResult" || typeof record.toolCallId !== "string") return undefined;
  return {
    entryId,
    toolCallId: record.toolCallId,
    toolName: typeof record.toolName === "string" ? record.toolName : "unknown",
  };
}
