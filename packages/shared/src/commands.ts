// The slash-command grammar, defined once. The agent command endpoint formats
// palette entries with it and the run path parses composer text back with it,
// so the two ends cannot drift apart.

/** Namespace that distinguishes a skill command from a prompt-template command. */
export const SKILL_COMMAND_PREFIX = "skill:";

export type AgentSlashCommandSource = "prompt" | "skill";

export type AgentSlashCommand = {
  name: string;
  description?: string;
  source: AgentSlashCommandSource;
  commandText: string;
  sourcePath?: string;
  argumentHint?: string;
};

export type AgentCommandPayload = {
  commands: AgentSlashCommand[];
};

/** The command token for a skill, e.g. `pdf` -> `skill:pdf`. */
export function skillCommandName(skillName: string) {
  return `${SKILL_COMMAND_PREFIX}${skillName}`;
}

/** The text a palette entry inserts into the composer, ready for arguments. */
export function slashCommandText(commandName: string) {
  return `/${commandName} `;
}

export type ParsedSlashCommand = {
  /** The command token exactly as typed, e.g. `review` or `skill:pdf`. */
  name: string;
  /** The bare skill name when `name` uses the skill namespace. */
  skillName?: string;
  /** Everything after the command token, untrimmed. */
  args: string;
};

const SLASH_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

/**
 * Parse composer text into the command it invokes. Returns undefined for
 * ordinary messages. Resolving the parsed name against the agent's actual
 * skills and templates is the caller's job: only the run path holds the
 * authoritative resource list.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
  const match = text.match(SLASH_COMMAND_PATTERN);
  if (!match) return undefined;
  const name = match[1]!;
  return {
    name,
    skillName: name.startsWith(SKILL_COMMAND_PREFIX)
      ? name.slice(SKILL_COMMAND_PREFIX.length)
      : undefined,
    args: match[2] ?? "",
  };
}
