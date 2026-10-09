import { createHash, randomUUID } from "node:crypto";
import type { AssistantMessageEvent, Context as PiContext } from "@earendil-works/pi-ai";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AuthVariables } from "../auth.ts";
import { errorMessage } from "../errors.ts";
import { providerRequestTimeoutMs } from "../runtime/run-limits.ts";
import { authenticateApiKey } from "../services/api-keys.ts";
import { readVisibleModelRefs, type ModelRefRecord } from "../services/agent-access.ts";
import { NO_PROVIDER_AUTH_MESSAGE, resolveModelContext } from "../services/model-context.ts";
import {
  chatCompletionRequestSchema,
  createChunkTranslator,
  OpenAICompatError,
  toChatCompletion,
  toOpenAIError,
  toPiContext,
  toPiStreamOptions,
} from "../services/openai-compat.ts";

type OpenAIContext = Context<{ Variables: AuthVariables }>;

/**
 * OpenAI-compatible API, mounted at `/v1` and authenticated by per-user API
 * key rather than by session cookie.
 *
 * A user reaches exactly the models they could pick in the app -- their own,
 * shared ones, and unbound ones -- with the same provider credentials. Requests
 * leave through pi-ai on the same model runtime a Carmel run uses, so what the
 * provider sees (User-Agent, attribution headers, request body) is pi, not the
 * calling client: nothing from the incoming request's headers is forwarded.
 */
export function createOpenAIRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.use("*", async (c, next) => {
    const header = c.req.header("authorization");
    const key = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const user = authenticateApiKey(key);
    if (!user) {
      return c.json(
        toOpenAIError("Invalid API key.", "invalid_request_error", "invalid_api_key"),
        401,
      );
    }
    c.set("user", user);
    await next();
  });

  route.get("/models", (c) => {
    const models = publicModels(c.get("user").id);
    return c.json({
      object: "list",
      data: models.map(({ publicId, modelRef }) => ({
        id: publicId,
        object: "model",
        created: Math.floor(modelRef.createdAt / 1000),
        owned_by: modelRef.provider,
      })),
    });
  });

  route.get("/models/:model{.+}", (c) => {
    const match = resolvePublicModel(c.get("user").id, c.req.param("model"));
    if (!match) return modelNotFound(c, c.req.param("model"));
    return c.json({
      id: match.publicId,
      object: "model",
      created: Math.floor(match.modelRef.createdAt / 1000),
      owned_by: match.modelRef.provider,
    });
  });

  route.post("/chat/completions", async (c) => {
    const parsed = chatCompletionRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return c.json(
        toOpenAIError(
          `${where}${issue?.message ?? "Invalid request body."}`,
          "invalid_request_error",
        ),
        400,
      );
    }
    const request = parsed.data;
    const userId = c.get("user").id;

    const match = resolvePublicModel(userId, request.model);
    if (!match) return modelNotFound(c, request.model);
    const resolved = await resolveModelContext(userId, match.modelRef.id);
    if (!resolved.ok) {
      return resolved.reason === "no_auth"
        ? c.json(
            toOpenAIError(
              NO_PROVIDER_AUTH_MESSAGE,
              "invalid_request_error",
              "provider_auth_missing",
            ),
            400,
          )
        : modelNotFound(c, request.model);
    }
    const { model, modelRuntime } = resolved.value;

    let context: PiContext;
    let options: ReturnType<typeof toPiStreamOptions>;
    try {
      context = toPiContext(request);
      options = toPiStreamOptions(request, model);
    } catch (error) {
      if (error instanceof OpenAICompatError) {
        return c.json(
          toOpenAIError(error.message, "invalid_request_error", error.code),
          error.status,
        );
      }
      throw error;
    }

    const abort = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abort.abort(), { once: true });
    let events: AsyncIterator<AssistantMessageEvent>;
    try {
      events = modelRuntime
        .streamSimple(model, context, {
          ...options,
          signal: abort.signal,
          sessionId: conversationId(c, userId, match.modelRef.id, context),
          timeoutMs: providerRequestTimeoutMs(),
          maxRetries: 2,
          maxRetryDelayMs: 60_000,
        })
        [Symbol.asyncIterator]();
    } catch (error) {
      // pi throws synchronously when the request cannot be authenticated.
      return upstreamError(c, errorMessage(error));
    }

    // Wait for the first event before committing to a status: a request pi
    // cannot even start (bad credentials, unknown model) should be an HTTP
    // error, not a 200 whose stream happens to contain one.
    const first = await events.next();
    if (first.done) return upstreamError(c, "The provider returned no response.");
    if (first.value.type === "error")
      return upstreamError(c, first.value.error.errorMessage ?? "Provider request failed.");

    const envelope = {
      id: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
      created: Math.floor(Date.now() / 1000),
      model: request.model,
    };

    if (!request.stream) {
      let event: AssistantMessageEvent = first.value;
      while (event.type !== "done" && event.type !== "error") {
        const next = await events.next();
        if (next.done) break;
        event = next.value;
      }
      if (event.type === "error")
        return upstreamError(c, event.error.errorMessage ?? "Provider request failed.");
      if (event.type !== "done")
        return upstreamError(c, "The provider stream ended without a result.");
      return c.json(toChatCompletion(envelope, event.message));
    }

    const translate = createChunkTranslator(
      envelope,
      request.stream_options?.include_usage === true,
    );
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => abort.abort());
      let result: IteratorResult<AssistantMessageEvent> = first;
      while (!result.done) {
        const event = result.value;
        if (event.type === "error") {
          // Aborted means the caller hung up; there is nobody to tell.
          if (event.reason !== "aborted") {
            await stream.writeSSE({
              data: JSON.stringify(
                toOpenAIError(event.error.errorMessage ?? "Provider request failed."),
              ),
            });
          }
          return;
        }
        for (const chunk of translate(event))
          await stream.writeSSE({ data: JSON.stringify(chunk) });
        if (event.type === "done") break;
        result = await events.next();
      }
      await stream.writeSSE({ data: "[DONE]" });
    });
  });

  return route;
}

type PublicModel = { publicId: string; modelRef: ModelRefRecord };

/**
 * Models under names a client can type: `provider/modelId`. Where two visible
 * entries would share that name (the same model behind two provider configs),
 * both fall back to their entry ID, which is always unique.
 */
function publicModels(userId: string): PublicModel[] {
  const modelRefs = readVisibleModelRefs(userId);
  const counts = new Map<string, number>();
  for (const modelRef of modelRefs) {
    const slug = modelSlug(modelRef);
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return modelRefs.map((modelRef) => {
    const slug = modelSlug(modelRef);
    return { publicId: counts.get(slug) === 1 ? slug : modelRef.id, modelRef };
  });
}

function resolvePublicModel(userId: string, requested: string) {
  const models = publicModels(userId);
  return (
    models.find((item) => item.publicId === requested) ??
    // Entry IDs always resolve, so a client configured before a name collision appeared keeps working.
    models.find((item) => item.modelRef.id === requested)
  );
}

function modelSlug(modelRef: ModelRefRecord) {
  return `${modelRef.provider}/${modelRef.modelId}`;
}

/**
 * The session ID pi sends upstream, which providers use for prompt-cache
 * routing. The pi CLI always has one; an OpenAI client has no session, so it is
 * derived from what stays fixed across a conversation's turns -- system prompt
 * and first user message -- and callers who know better can send
 * `x-session-id`. Hashed, so no prompt text leaves in a header.
 */
function conversationId(c: OpenAIContext, userId: string, modelRefId: string, context: PiContext) {
  const explicit = c.req.header("x-session-id")?.trim();
  const firstUser = context.messages.find((message) => message.role === "user");
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        userId,
        modelRefId,
        explicit ?? null,
        explicit ? null : (context.systemPrompt ?? ""),
        explicit ? null : (firstUser?.content ?? ""),
      ]),
    )
    .digest("hex");
  // UUID-shaped, as pi's own session IDs are.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function modelNotFound(c: OpenAIContext, model: string) {
  return c.json(
    toOpenAIError(
      `The model '${model}' does not exist or you do not have access to it.`,
      "invalid_request_error",
      "model_not_found",
    ),
    404,
  );
}

function upstreamError(c: OpenAIContext, message: string) {
  return c.json(toOpenAIError(message, "api_error", "upstream_error"), 502);
}
