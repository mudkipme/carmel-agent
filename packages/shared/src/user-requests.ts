import { z } from "zod";
import { agentSecretNameError } from "./schemas.ts";

export const questionInputSchema = z
  .object({
    question: z.string().trim().min(1).max(2000),
    options: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            label: z.string().min(1).max(300),
            description: z.string().max(1000).optional(),
          })
          .strict(),
      )
      .max(7)
      .default([]),
    multiple: z.boolean().default(false),
    allowFreeText: z.boolean().default(true),
  })
  .strict()
  .refine(
    (input) => new Set(input.options.map((option) => option.id)).size === input.options.length,
    "Option IDs must be unique.",
  )
  .refine(
    (input) => input.options.length > 0 || input.allowFreeText,
    "Provide options or allow a text answer.",
  );

export const secretRequestInputSchema = z
  .object({
    name: z
      .string()
      .refine((name) => !agentSecretNameError(name), "Use a permitted environment variable name."),
    reason: z.string().trim().min(1).max(2000),
    replaceExisting: z
      .boolean()
      .default(false)
      .describe(
        "Request a different credential for this session even when an agent default exists.",
      ),
  })
  .strict();

export const questionAnswerSchema = z
  .object({
    selected: z.array(z.string().min(1).max(100)).max(7).default([]),
    text: z.string().trim().max(12000).default(""),
  })
  .strict();

// A separate payload and endpoint: this type must never be a conversation input.
export const secretAnswerSchema = z
  .object({
    value: z
      .string()
      .min(1)
      .max(65536)
      .refine((value) => !value.includes("\0"), "Invalid secret value."),
  })
  .strict();
export type QuestionInput = z.infer<typeof questionInputSchema>;
export type SecretRequestInput = z.infer<typeof secretRequestInputSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export type SessionSecret = {
  id: string;
  name: string;
  scope: "session" | "agent";
  updatedAt: number;
};
export type UserRequest = {
  id: string;
  sessionId: string;
  kind: "question" | "secret";
  question?: QuestionInput;
  secret?: SecretRequestInput;
  status: "pending" | "answered" | "cancelled" | "expired";
  answer?: QuestionAnswer;
  credential?: SessionSecret;
  delivery: "pending" | "submitted" | null;
  createdAt: number;
  expiresAt: number;
};
