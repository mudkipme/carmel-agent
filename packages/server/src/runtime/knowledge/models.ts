import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { dataDir } from "../../paths.ts";

// Pin the default alongside the qmd adapter, rather than inheriting agent settings.
export const DEFAULT_EMBEDDING_MODEL =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

export function knowledgeEmbeddingModel() {
  return process.env.CARMEL_KNOWLEDGE_EMBED_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

export async function knowledgeModelPlan() {
  const embeddingModel = knowledgeEmbeddingModel();
  const modelCacheDir = resolve(dataDir, "knowledge-models");
  await mkdir(modelCacheDir, { recursive: true });
  if (embeddingModel.startsWith("hf:")) return { embeddingModel, modelCacheDir };
  if (!isAbsolute(embeddingModel) || !embeddingModel.endsWith(".gguf")) {
    throw new Error(
      "CARMEL_KNOWLEDGE_EMBED_MODEL must be an hf: URI or an absolute GGUF file path.",
    );
  }
  // This path is configured by the operator, independent of agent workspace permissions.
  const hostPath = await realpath(embeddingModel).catch(() => {
    throw new Error(
      "The GGUF file configured by CARMEL_KNOWLEDGE_EMBED_MODEL is unavailable to the server.",
    );
  });
  const info = await stat(hostPath);
  if (!info.isFile()) throw new Error("CARMEL_KNOWLEDGE_EMBED_MODEL must identify a GGUF file.");
  return {
    embeddingModel,
    modelCacheDir,
    model: {
      hostPath,
      // qmd detects Qwen3 query/document formatting by filename.
      containerPath: `/models/local/${basename(embeddingModel)}`,
      revision: `${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
    },
  };
}
