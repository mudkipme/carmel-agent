import type { AgentRunEventEnvelope } from "./index.ts";

export const stateTopics = [
  "workspace",
  "sessions",
  "subtasks",
  "homes",
  "tasks",
  "issues",
  "knowledge",
  "integrations",
  "browser",
] as const;

export type StateTopic = (typeof stateTopics)[number];

export type UpdateClientMessage =
  | { type: "watch_run"; id: string; runId: string; after: number }
  | { type: "unwatch_run"; id: string };

export type UpdateServerMessage =
  | { type: "ready"; epoch: string; revision: number }
  | { type: "state_changed"; revision: number; topics: StateTopic[] }
  | { type: "run_open"; id: string; status: 200 | 400 | 404 | 409 }
  | { type: "run_event"; id: string; envelope: AgentRunEventEnvelope }
  | { type: "run_close"; id: string };
