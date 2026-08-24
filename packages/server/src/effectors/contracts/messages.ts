/**
 * The one deliberate leak in `contracts/`.
 *
 * Everything else in this directory is Carmel-owned, so an upstream reshape
 * cannot reach it. Message content is the exception: it is the payload the
 * agent produces, it is what we persist, and it is what the client renders, so
 * re-modelling it would mean maintaining a parallel copy of a provider wire
 * format for no isolation benefit -- Pi's `AgentMessage` tracks the providers,
 * not Pi's own design taste, and it has been stable across the churn that broke
 * everything around it.
 *
 * Keeping the alias here means the exception is one import to audit rather than
 * a habit spread across the layer.
 */
export type { AgentMessage as SessionMessage } from "@earendil-works/pi-agent-core";
