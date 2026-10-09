import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserControlState } from "@carmel-agent/shared";
import { dataDir } from "../paths.ts";
import { holdAgentContainer, releaseAgentContainer } from "./sandbox/container-manager.ts";

type SavedState = { paused: boolean; reason?: string; revision: number };

/** Server authority for handoffs. Input leases are per connection, never client supplied. */
export class BrowserControl {
  private paused: boolean;
  private reason?: string;
  private revision: number;
  private controller?: { id: string; name: string };
  private active = 0;
  private listeners = new Set<() => void>();

  constructor(
    saved?: SavedState,
    private readonly save: (state: SavedState) => void = () => {},
  ) {
    this.paused = saved?.paused ?? false;
    this.reason = saved?.reason;
    this.revision = saved?.revision ?? 0;
  }

  get state(): BrowserControlState {
    return {
      phase: !this.paused
        ? "agent"
        : this.active
          ? "pausing"
          : this.controller
            ? "human"
            : "waiting",
      reason: this.reason,
      controllerName: this.controller?.name,
      revision: this.revision,
    };
  }

  get isPaused() {
    return this.paused;
  }
  get isDraining() {
    return this.paused && this.active > 0;
  }
  owns(id: string) {
    return this.controller?.id === id;
  }
  canInput(id: string) {
    return this.owns(id) && this.state.phase === "human";
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  take(id: string, name: string) {
    if (this.controller && !this.owns(id))
      throw new Error(`${this.controller.name} already has browser control.`);
    this.pause(this.reason ?? "A person is helping in the browser.");
    this.controller = { id, name };
    this.notify();
  }

  resume(id: string) {
    if (!this.owns(id)) throw new Error("Take control before resuming the agent.");
    if (this.active) throw new Error("Wait for the current tool call to finish.");
    this.save({ paused: false, revision: this.revision + 1 });
    this.paused = false;
    this.reason = undefined;
    this.controller = undefined;
    this.revision++;
    this.notify();
  }

  detach(id: string) {
    if (!this.owns(id)) return;
    this.controller = undefined;
    // A disconnected controller never releases the automation gate.
    this.notify();
  }

  async requestHelp(reason: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.pause(reason);
    await this.wait(signal);
  }

  /** Acquire synchronously after the wait, closing the take-control admission race. */
  async enter(signal?: AbortSignal): Promise<{ release: () => void; interrupted: boolean }> {
    const revision = this.revision;
    while (this.paused) await this.wait(signal);
    signal?.throwIfAborted();
    this.active++;
    let released = false;
    return {
      interrupted: revision !== this.revision,
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        this.notify();
      },
    };
  }

  async wait(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.paused) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        off();
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(signal?.reason ?? new Error("Browser wait cancelled."));
      const off = this.subscribe(() => {
        if (!this.paused) finish();
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private pause(reason: string) {
    const revision = this.revision + 1;
    this.save({ paused: true, reason, revision });
    this.paused = true;
    this.reason = reason;
    this.revision = revision;
    this.notify();
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }
}

// Kept outside the agent's mounted directories. No input, pixels, URLs, or cookies are saved here.
const directory = join(dataDir, "browser-control");
const controls = new Map<string, BrowserControl>();
const statePath = (agentId: string) => join(directory, `${encodeURIComponent(agentId)}.json`);
export function browserControl(agentId: string) {
  let control = controls.get(agentId);
  if (!control) {
    let saved: SavedState | undefined;
    try {
      saved = JSON.parse(readFileSync(statePath(agentId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    control = new BrowserControl(saved, (state) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = statePath(agentId);
      writeFileSync(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    });
    controls.set(agentId, control);
    let held = false;
    const updateHold = () => {
      if (control!.isPaused === held) return;
      held = control!.isPaused;
      if (held) holdAgentContainer(agentId);
      else releaseAgentContainer(agentId);
    };
    control.subscribe(updateHold);
    updateHold();
  }
  return control;
}

export function deleteBrowserControl(agentId: string) {
  if (controls.get(agentId)?.isPaused) releaseAgentContainer(agentId);
  controls.delete(agentId);
  rmSync(statePath(agentId), { force: true });
}
