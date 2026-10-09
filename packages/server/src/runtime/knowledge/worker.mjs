// Executed ONLY inside Dockerfile.runner via the container runtime's exec API.
// No part of this module is imported into the Carmel app server.
import { createInterface } from "node:readline";
import { readFile, mkdir } from "node:fs/promises";
const packageRoot = "/usr/local/lib/node_modules/@tobilu/qmd";
const { version } = JSON.parse(
  await readFile(`${packageRoot}/package.json`, "utf8"),
);
if (version !== "2.8.3")
  throw new Error(
    `Expected qmd 2.8.3, found ${version}. Update the runner image.`,
  );
console.log = (...args) => console.error(...args);
const { createStore } = await import(`file://${packageRoot}/dist/index.js`);
const { setDefaultLlamaCpp } = await import(
  `file://${packageRoot}/dist/llm.js`
);
const { resolveModelFile } = await import(
  `file://${packageRoot}/node_modules/node-llama-cpp/dist/index.js`
);
let store;
let acceleration = "auto";
let device;

async function deviceInfo() {
  device = await store.internal.llm.getDeviceInfo({ allowBuild: false });
  if (
    ["vulkan", "cuda"].includes(acceleration) &&
    (!device.gpuOffloading || device.gpu !== acceleration)
  ) {
    throw new Error(
      `Requested ${acceleration} acceleration is unavailable. Existing vectors were retained.`,
    );
  }
  return {
    backend: device.gpuOffloading ? String(device.gpu) : "cpu",
    devices: device.gpuDevices,
  };
}
async function status() {
  const result = await store.getStatus();
  return {
    documents: result.totalDocuments,
    needsEmbedding: result.needsEmbedding,
    backend: device
      ? device.gpuOffloading
        ? String(device.gpu)
        : "cpu"
      : null,
    devices: device?.gpuDevices ?? [],
  };
}
async function prepareEmbedding() {
  await deviceInfo();
  const model = await store.internal.llm.ensureEmbedModel();
  if (!model.gpuLayers) {
    device = { ...device, gpuOffloading: false, gpuDevices: [] };
    if (["vulkan", "cuda"].includes(acceleration))
      throw new Error(
        "The embedding model did not offload any layers to the requested GPU.",
      );
  }
}
async function handle(request) {
  if (request.op === "init") {
    if (store) throw new Error("Already initialized");
    acceleration = request.acceleration;
    await mkdir("/state/index", { recursive: true });
    store = await createStore({
      dbPath: `/state/index/${request.generation}.sqlite`,
      config: request.config,
    });
    // qmd 2.8.3 token-based chunking uses the process singleton even for SDK stores.
    // Reuse the configured model so chunking cannot load a second/default model.
    setDefaultLlamaCpp(store.internal.llm);
    store.internal.llm.modelCacheDir = "/models/cache";
    if (!request.allowDownloads) {
      const llm = store.internal.llm;
      const resolveModel = llm.resolveModel.bind(llm);
      llm.resolveModel = async (uri) => {
        let path;
        try {
          path = await resolveModelFile(uri, {
            directory: llm.modelCacheDir,
            download: false,
            cli: false,
          });
        } catch {
          throw new Error(
            "Model is not cached. Build embeddings or prepare deep search with network access, or configure a local GGUF file.",
          );
        }
        return resolveModel(path);
      };
    }
    return { version, ...(await status()) };
  }
  if (!store) throw new Error("Worker is not initialized");
  if (request.op === "status") return status();
  if (request.op === "prepare") {
    const llm = store.internal.llm;
    // resolveModel enforces offline mode and validates GGUF files.
    for (const uri of [llm.generateModelUri, llm.rerankModelUri])
      await llm.resolveModel(uri);
    return status();
  }
  if (request.op === "update") {
    await store.update();
    return status();
  }
  if (request.op === "embed") {
    await prepareEmbedding();
    const result = await store.embed({
      force: false,
      maxDocsPerBatch: 16,
      maxBatchBytes: 32 * 1024 * 1024,
    });
    if (result.errors)
      throw new Error(
        `Embedding failed for ${result.errors} chunks. Existing successful vectors were retained; retry Build embeddings.`,
      );
    return status();
  }
  if (request.op === "search") {
    const { query, mode, collections, limit } = request;
    let results;
    if (mode === "fast")
      results = await store.searchLex(query, {
        collection: collections,
        limit,
      });
    else {
      await prepareEmbedding();
      if (mode === "semantic")
        results = await store.searchVector(query, {
          collection: collections,
          limit,
        });
      else
        results = await store.search({
          query,
          collections,
          limit,
          candidateLimit: 20,
        });
    }
    const hits = [];
    for (const hit of results) {
      const file = hit.filepath ?? hit.file;
      const doc = await store.get(file);
      if ("error" in doc) continue;
      const prefix = `qmd://${doc.collectionName}/`;
      if (!doc.filepath.startsWith(prefix)) continue;
      hits.push({
        sourceId: doc.collectionName,
        path: doc.filepath.slice(prefix.length),
        hash: doc.hash,
        score: hit.score,
      });
    }
    return { hits, ...(await status()) };
  }
  throw new Error("Unknown worker operation");
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let id;
  try {
    if (Buffer.byteLength(line) > 256 * 1024)
      throw new Error("Request too large");
    const request = JSON.parse(line);
    id = request.id;
    const result = await handle(request);
    process.stdout.write(`${JSON.stringify({ id, result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ id, error: String(error?.message ?? error).slice(0, 2000) })}\n`,
    );
  }
}
await store?.close();
