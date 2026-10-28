import { z } from "zod";
import { LiveDoc, type ToolRegistration, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { questionInputSchema, secretRequestInputSchema } from "@carmel-agent/shared";
import {
  createUserRequest,
  blockingUserRequest,
  findCallUserRequest,
} from "../services/user-requests.ts";
import {
  findAvailableSecret,
  promoteSessionSecret,
  readSessionSecrets,
  readAgentSecretEnv,
} from "../services/agent-secrets.ts";
import { createSecretRedactor } from "./sandbox/redaction.ts";

const requestingTools = new Set(["ask_user_question", "request_secret"]);
const aloneError = {
  output: [
    {
      type: "text" as const,
      text: "Request user input as the only tool call in the turn. Other tools in this round were not executed. Retry this request alone.",
    },
  ],
  isError: true,
};
async function isAlone(api: ToolExecutionApi, context: Context) {
  return ((await api.snapshot(LiveDoc, api.conversationId, context))?.tools?.length ?? 0) === 1;
}

export function createUserRequestTools(context: {
  sessionId: string;
  userId: string;
  bash: boolean;
}): ToolRegistration[] {
  const question: ToolRegistration = {
    name: "ask_user_question",
    description:
      "Ask the user to select options or provide a text answer. Persists a request and ends this run until the user responds. Call directly, outside codemode, as the only tool in your turn. Never ask for credentials here; use request_secret.",
    callers: ["model"],
    executionMode: "sequential",
    replay: "safe",
    parameters: z.toJSONSchema(questionInputSchema, {
      unrepresentable: "any",
      io: "input",
    }) as never,
    async execute(args, api, ctx) {
      ctx.abortSignal?.throwIfAborted();
      if (!(await isAlone(api, ctx))) return aloneError;
      const request = createUserRequest(
        {
          sessionId: context.sessionId,
          conversationId: String(api.conversationId),
          callId: String(api.taskId),
        },
        "question",
        questionInputSchema.parse(args),
      );
      return {
        output: [{ type: "text", text: `Waiting for the user's answer. Request: ${request.id}.` }],
        details: { userRequestId: request.id },
        control: { terminate: true },
      };
    },
  };
  if (!context.bash) return [question];
  return [
    question,
    {
      name: "request_secret",
      description:
        "Request a credential through a private form, never in chat. It is session-scoped by default and available to bash as the named environment variable. Returns metadata only if already configured; otherwise ends this run until supplied. Call directly, outside codemode, alone in the turn.",
      callers: ["model"],
      executionMode: "sequential",
      replay: "safe",
      parameters: z.toJSONSchema(secretRequestInputSchema, {
        unrepresentable: "any",
        io: "input",
      }) as never,
      async execute(args, api, ctx) {
        ctx.abortSignal?.throwIfAborted();
        const input = secretRequestInputSchema.parse(args);
        if (!(await isAlone(api, ctx))) return aloneError;
        const call = {
          sessionId: context.sessionId,
          conversationId: String(api.conversationId),
          callId: String(api.taskId),
        };
        const saved = findCallUserRequest(call);
        if (saved)
          return {
            output: [{ type: "text", text: `Waiting for credential request ${saved.id}.` }],
            details: { userRequestId: saved.id },
            control: { terminate: true },
          };
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
        const request = createUserRequest(
          {
            sessionId: context.sessionId,
            conversationId: String(api.conversationId),
            callId: String(api.taskId),
          },
          "secret",
          input,
        );
        return {
          output: [
            { type: "text", text: `Waiting for the credential form. Request: ${request.id}.` },
          ],
          details: { userRequestId: request.id },
          control: { terminate: true },
        };
      },
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

/** A malformed multi-tool turn must not run other commands alongside a human request. */
export function guardUserRequests(
  tool: ToolRegistration,
  sessionId: string,
  agentId: string,
): ToolRegistration {
  return {
    ...tool,
    async execute(args, api, context) {
      const pending = blockingUserRequest(sessionId);
      const round = (await api.snapshot(LiveDoc, api.conversationId, context))?.tools ?? [];
      const asks = round.some((slot) => requestingTools.has(slot.name));
      if (
        (pending && pending.callId !== String(api.taskId)) ||
        (asks && !requestingTools.has(tool.name))
      ) {
        return {
          output: [
            {
              type: "text",
              text: "This tool was not executed because this turn requests user input. Reconsider it after the user responds.",
            },
          ],
          control: { terminate: true },
        };
      }
      const secrets = readAgentSecretEnv(agentId, sessionId);
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
        return redactValue(result) as typeof result;
      } catch (error) {
        throw new Error(redact(error instanceof Error ? error.message : "Tool failed."));
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
    "For choices or clarification, use ask_user_question. Call request tools directly, outside codemode, as the turn's only tool; they pause the run for a human response. Decline/expiry does not authorize repeating a request.",
    ...(bash
      ? [
          "For API keys/tokens, use request_secret, never chat or ordinary question fields. Secrets are stored separately and injected into bash; use environment variable names, never literal values. Do not print, encode, persist, commit, or send credentials except to the intended authentication service. Never use shell tracing with credentials.",
          "Credentials default to this session. For user-intended reuse across future sessions, use promote_secret with its secret reference; already-authorized reuse needs no extra confirmation. Promoted credentials on a shared agent are usable by its other runners; only its owner may promote. Never silently replace credentials.",
          `Available credential metadata: ${JSON.stringify(available)}.`,
        ]
      : []),
  ].join("\n");
}
