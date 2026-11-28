import { z } from "zod";
import {
  defineSignal,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolPark,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { obj, oneOf } from "@earendil-works/pi-schema";
import { questionInputSchema, secretRequestInputSchema } from "@carmel-agent/shared";
import {
  cancelCallUserRequest,
  consumeCallUserRequest,
  createUserRequest,
  findCallUserRequest,
} from "../services/user-requests.ts";
import {
  findAvailableSecret,
  promoteSessionSecret,
  readSessionSecrets,
  readEnvironmentSecretEnv,
} from "../services/environment-secrets.ts";
import { createSecretRedactor } from "./sandbox/redaction.ts";
import { errorMessage } from "../errors.ts";

/**
 * Wakes a request tool parked on the user. The response itself stays in Carmel's request record, so a credential
 * never enters Pi's task storage; the value only says how the request ended.
 */
export const UserRequestResponse = defineSignal({
  name: "carmel.user-request",
  version: 1,
  schema: obj({ status: oneOf(["answered", "cancelled", "expired"]) }),
});
export const USER_REQUEST_SIGNAL_KEY = "response";

type RequestContext = { sessionId: string; userId: string; bash: boolean };

function requestCall(context: RequestContext, api: ToolExecutionApi) {
  return {
    sessionId: context.sessionId,
    conversationId: String(api.conversationId),
    callId: String(api.taskId),
  };
}

/** Holds no process until the user responds or the request expires; the call then runs again with `api.wake` set. */
function park(expiresAt: number): ToolPark {
  return {
    kind: "sleep",
    signals: [UserRequestResponse.key(USER_REQUEST_SIGNAL_KEY)],
    until: expiresAt,
  };
}

function respond(context: RequestContext, api: ToolExecutionApi): ToolExecutionResult {
  const response = consumeCallUserRequest(requestCall(context, api));
  return {
    output: [{ type: "text", text: response.text }],
    details: { userRequestId: response.id, userRequestReceipt: response.receipt },
  };
}

export function createUserRequestTools(context: RequestContext): ToolRegistration[] {
  const cancel = async (_args: unknown, api: ToolExecutionApi) =>
    cancelCallUserRequest(requestCall(context, api));
  const question: ToolRegistration = {
    name: "ask_user_question",
    description:
      "Ask the user to select options or provide a text answer. The call waits until the user answers, declines, or the request expires, and returns the response. Call directly, outside codemode. Never ask for credentials here; use request_secret.",
    callers: ["model"],
    executionMode: "sequential",
    replay: "safe",
    parameters: z.toJSONSchema(questionInputSchema, {
      unrepresentable: "any",
      io: "input",
    }),
    async execute(args, api, ctx) {
      ctx.abortSignal?.throwIfAborted();
      if (api.wake) return respond(context, api);
      const request = createUserRequest(
        requestCall(context, api),
        "question",
        questionInputSchema.parse(args),
      );
      return park(request.expiresAt);
    },
    cancel,
  };
  if (!context.bash) return [question];
  return [
    question,
    {
      name: "request_secret",
      description:
        "Request a credential through a private form, never in chat. It is session-scoped by default and available to bash as the named environment variable. Returns metadata at once if already configured; otherwise waits until the user supplies or declines it. Call directly, outside codemode.",
      callers: ["model"],
      executionMode: "sequential",
      replay: "safe",
      parameters: z.toJSONSchema(secretRequestInputSchema, {
        unrepresentable: "any",
        io: "input",
      }),
      async execute(args, api, ctx) {
        ctx.abortSignal?.throwIfAborted();
        if (api.wake) return respond(context, api);
        const input = secretRequestInputSchema.parse(args);
        const call = requestCall(context, api);
        // A rerun before the park was stored finds its request rather than a credential stored meanwhile.
        const saved = findCallUserRequest(call);
        if (saved) return park(saved.expiresAt);
        const credential = !input.replaceExisting
          ? findAvailableSecret(context.sessionId, input.name)
          : undefined;
        if (credential)
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  ...credential,
                  usage: `Use $${input.name} in bash. Never print, encode, or save its value.`,
                }),
              },
            ],
            details: credential,
          };
        return park(createUserRequest(call, "secret", input).expiresAt);
      },
      cancel,
    },
    {
      name: "promote_secret",
      description:
        "Move a session credential to this agent's reusable credentials without reading its value. Use when reuse across future sessions fits the user's intent. Owner-only for shared agents; never overwrites an existing agent credential. secretRef is the id returned by request_secret or the credential-available receipt.",
      callers: ["model"],
      executionMode: "sequential",
      replay: "safe",
      parameters: {
        type: "object",
        properties: { secretRef: { type: "string", minLength: 1 } },
        required: ["secretRef"],
        additionalProperties: false,
      },
      async execute(args, _api, ctx) {
        ctx.abortSignal?.throwIfAborted();
        const credential = promoteSessionSecret(
          context.userId,
          context.sessionId,
          String((args as { secretRef: string }).secretRef),
        );
        return {
          output: [{ type: "text", text: JSON.stringify(credential) }],
          details: credential,
        };
      },
    },
  ];
}

/** Redacts the session's credentials from everything a tool reports. */
export function redactSessionSecrets(
  tool: ToolRegistration,
  sessionId: string,
  environmentId: string,
): ToolRegistration {
  return {
    ...tool,
    async execute(args, api, context) {
      const secrets = readEnvironmentSecretEnv(environmentId, sessionId);
      if (!secrets.length) return tool.execute(args, api, context);
      // The sandbox already scrubs bash streams before spilling or emitting them.
      // Preserve native retention: bash reads retainedOutput() before returning
      // its structured result, so another buffered redactor would omit its tail.
      const scrubbedByEnvironment = tool.name === "bash";
      const redact = (text: string) => {
        const redactor = createSecretRedactor(secrets);
        return redactor.push(text) + redactor.flush();
      };
      const redactValue = (value: unknown): unknown => {
        if (typeof value === "string") return redact(value);
        if (Array.isArray(value)) return value.map(redactValue);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, value]) => [redact(key), redactValue(value)]),
          );
        return value;
      };
      const stream = createSecretRedactor(secrets);
      const decoder = new TextDecoder();
      try {
        const result = await tool.execute(
          args,
          {
            ...api,
            outputWindow: scrubbedByEnvironment ? api.outputWindow : undefined,
            output(chunk, skipped) {
              if (scrubbedByEnvironment) return api.output(chunk, skipped);
              const safe = stream.push(
                typeof chunk === "string"
                  ? decoder.decode() + chunk
                  : decoder.decode(chunk, { stream: true }),
              );
              if (safe) api.output(safe);
            },
            details(value, ctx) {
              return api.details(redactValue(value) as never, ctx);
            },
            diagnostic(value) {
              return api.diagnostic(redactValue(value) as never);
            },
          },
          context,
        );
        // Wrappers return their base's park unchanged; a copy would count as a park of their own.
        if (result.kind) return result;
        return redactValue(result) as typeof result;
      } catch (error) {
        throw new Error(redact(errorMessage(error, "Tool failed.")));
      } finally {
        const tail = stream.push(decoder.decode()) + stream.flush();
        if (tail) api.output(tail);
      }
    },
  };
}

export function userRequestInstructions(userId: string, sessionId: string, bash: boolean) {
  const available = bash ? readSessionSecrets(userId, sessionId) : [];
  return [
    "For choices or clarification, use ask_user_question. Call request tools directly, outside codemode; the call waits for the user's response and returns it. Decline/expiry does not authorize repeating a request.",
    ...(bash
      ? [
          "For API keys/tokens, use request_secret, never chat or ordinary question fields. Secrets are stored separately and injected into bash; use environment variable names, never literal values. Do not print, encode, persist, commit, or send credentials except to the intended authentication service. Never use shell tracing with credentials.",
          "Credentials default to this session. For user-intended reuse across future sessions, use promote_secret with its secret reference; already-authorized reuse needs no extra confirmation. Promoted credentials on a shared agent are usable by its other runners; only its owner may promote. Never silently replace credentials.",
          `Available credential metadata: ${JSON.stringify(available)}.`,
        ]
      : []),
  ].join("\n");
}
