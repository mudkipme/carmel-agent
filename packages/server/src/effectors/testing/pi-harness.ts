import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  type AgentHarnessOptions,
  type AgentLane,
  type Context,
  type Entry,
  type ExecutionToolContext,
  type HarnessEvent,
  type Session,
} from "../pi-durable/index.ts";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  closePiSession,
  openPiSession,
  readPiSessionBranch,
} from "../../services/pi-session-storage.ts";
import { createPiSessionLog, PI_MAIN_BRANCH } from "../pi-durable/session-log.ts";
import { observeHarnessEvents } from "../pi-durable/agent-driver.ts";
import type { SessionLog } from "../contracts/session-log.ts";

/**
 * Open a Pi Durable harness and its selected conversation for integration tests.
 */

/** Tests are not cancellable, so they run on the background context like the run path. */
export const TEST_CONTEXT: Context = BACKGROUND_CONTEXT;

export type TestHarness = {
  session: Session;
  harness: AgentHarness<ExecutionToolContext>;
  lane: AgentLane;
  log: SessionLog;
  context: Context;
  /** Reads the conversation branch oldest-first, as `session.getBranch()` used to. */
  branch(): Promise<Entry[]>;
  observe(listener: (event: HarnessEvent) => void): () => void;
  close(): Promise<void>;
};

export async function openTestHarness(
  sessionId: string,
  options: Omit<AgentHarnessOptions<ExecutionToolContext>, "session">,
): Promise<TestHarness> {
  const session = await openPiSession(sessionId);
  return attachTestHarness(session, options);
}

/** For tests that opened the session themselves and still need it afterwards. */
export async function attachTestHarness(
  session: Session,
  options: Omit<AgentHarnessOptions<ExecutionToolContext>, "session">,
): Promise<TestHarness> {
  const { harness } = await AgentHarness.create<ExecutionToolContext>(
    {
      // Disable automatic retry for deterministic faux-provider call counts.
      // The production run path sets its own policy explicitly.
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      ...options,
      session,
    },
    TEST_CONTEXT,
  );
  const lane = await harness.lane(PI_MAIN_BRANCH, TEST_CONTEXT);
  const log = createPiSessionLog({ session, lane, context: TEST_CONTEXT });
  return {
    session,
    harness,
    lane,
    log,
    context: TEST_CONTEXT,
    branch: () => readPiSessionBranch(session),
    observe: (listener) => observeHarnessEvents(harness, listener),
    /**
     * Closes the harness first, then releases the session lease.
     *
     * `session.close()` seals the mutation line and waits for it to drain, so
     * closing a session whose harness is still open hangs. `harness.close()`
     * tears down hooks, events and idle callbacks and closes the session itself;
     * the lease release afterwards is idempotent and drops the holder count.
     */
    async close() {
      await harness.close(TEST_CONTEXT);
      await closePiSession(session);
    },
  };
}

/**
 * A models/model pair for tests that need a harness but never let it talk.
 *
 * `AgentHarness.create` requires both, and a lane cannot be acquired without a
 * harness -- so a test that only wants to read or rewind a branch still has to
 * supply a provider it will never call.
 */
export function fauxHarnessModels() {
  const faux = fauxProvider({ provider: `faux-harness-${crypto.randomUUID()}` });
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel(), faux };
}
