import type { AgentThinkingLevel } from "@carmel-agent/shared";
import type { BranchEntry, SessionLog, SessionState } from "../contracts/session-log.ts";
import type { SessionMessage } from "../contracts/messages.ts";

type Entry = BranchEntry & { readonly seq: number };

/**
 * In-memory `SessionLog`, held to the same contract suite as the real adapter.
 *
 * Its value is not that it is fast -- it is that every test above the port can
 * stop building a SQLite session to assert on branch arithmetic, so those tests
 * survive the upgrade untouched.
 */
export class FakeSessionLog implements SessionLog {
  #entries: Entry[] = [];
  #leafId: string | null = null;
  #state: SessionState = { model: null, thinkingLevel: "off", activeToolNames: null };
  #nextId = 1;
  closeCount = 0;

  async readBranch(): Promise<readonly BranchEntry[]> {
    const branch: BranchEntry[] = [];
    let cursor = this.#leafId;
    while (cursor !== null) {
      const entry = this.#entries.find((candidate) => candidate.id === cursor);
      if (!entry) break;
      branch.unshift(entry);
      cursor = entry.parentId;
    }
    return branch;
  }

  async moveTo(entryId: string | null) {
    if (entryId !== null && !this.#entries.some((entry) => entry.id === entryId)) {
      throw new Error(`Unknown entry: ${entryId}`);
    }
    this.#leafId = entryId;
  }

  async appendMessage(message: SessionMessage) {
    return this.#append({ type: "message", message });
  }

  async readState() {
    return this.#state;
  }

  async appendModelChange(provider: string, modelId: string) {
    await this.#append({ type: "other" });
    this.#state = { ...this.#state, model: { provider, modelId } };
  }

  async appendThinkingLevelChange(level: AgentThinkingLevel) {
    await this.#append({ type: "other" });
    this.#state = { ...this.#state, thinkingLevel: level };
  }

  async appendActiveToolsChange(names: readonly string[]) {
    await this.#append({ type: "other" });
    this.#state = { ...this.#state, activeToolNames: [...names] };
  }

  async close() {
    this.closeCount += 1;
  }

  async #append(body: { type: "message"; message: SessionMessage } | { type: "other" }) {
    const id = `entry-${this.#nextId++}`;
    this.#entries.push({ ...body, id, parentId: this.#leafId, seq: this.#entries.length } as Entry);
    this.#leafId = id;
    return id;
  }
}
