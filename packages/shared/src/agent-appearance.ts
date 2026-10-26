import { z } from "zod";

export const agentIconSchema = z.enum([
  "bot",
  "sparkles",
  "orbit",
  "compass",
  "sprout",
  "sun",
  "moon",
  "rocket",
  "book",
  "code",
  "palette",
  "heart",
]);
export const agentColorSchema = z.enum(["blue", "green", "orange", "purple", "cyan", "pink"]);
export type AgentIcon = z.infer<typeof agentIconSchema>;
export type AgentColor = z.infer<typeof agentColorSchema>;
