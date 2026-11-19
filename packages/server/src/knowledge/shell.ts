import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { agents, knowledgeConfigs } from "../db/schema.ts";
import { knowledgeModelPlan } from "./models.ts";

/**
 * What every runner needs for shell qmd, whichever agent drives it: the shared
 * model weights and their default. Shell qmd keeps its own collections/index.
 */
export async function knowledgeShellResources() {
  const plan = await knowledgeModelPlan();
  return {
    env: { QMD_EMBED_MODEL: plan.model?.containerPath ?? plan.embeddingModel },
    mounts: [
      // qmd 2.8.3 derives its CLI model cache from HOME/XDG_CACHE_HOME.
      // Do not override XDG_CACHE_HOME: that would also move existing indexes.
      { source: plan.modelCacheDir, target: "/home/agent/.cache/qmd/models", readOnly: true },
      ...(plan.model
        ? [{ source: plan.model.hostPath, target: plan.model.containerPath, readOnly: true }]
        : []),
    ],
    modelRevision: plan.model?.revision,
  };
}

export type KnowledgeShellResources = Awaited<ReturnType<typeof knowledgeShellResources>>;

/** The agent's own acceleration choice, applied per command since runners are shared. */
export function knowledgeShellEnv(agent: typeof agents.$inferSelect) {
  const settings = agent.permissions?.read
    ? db.select().from(knowledgeConfigs).where(eq(knowledgeConfigs.agentId, agent.id)).get()
        ?.settings
    : undefined;
  const backend = settings?.acceleration === "cpu" ? "false" : (settings?.acceleration ?? "auto");
  return { QMD_LLAMA_GPU: backend, NODE_LLAMA_CPP_GPU: backend };
}
