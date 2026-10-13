import { parseSlashCommand, type PromptInput } from "@carmel-agent/shared";
import {
  formatSkillInvocation,
  formatPromptTemplateInvocation,
  parseCommandArgs,
  type Skill,
  type PromptTemplate,
} from "./pi-durable/resources.ts";

export type PromptDispatch = {
  resources: { skills?: readonly Skill[]; promptTemplates?: readonly PromptTemplate[] };
  prompt(text: string, images?: PromptInput["images"]): Promise<void>;
};

/** Carmel's slash-command precedence, with the same native input path for text and attachments. */
export async function dispatchPrompt(
  { resources, prompt }: PromptDispatch,
  text: string,
  images?: PromptInput["images"],
) {
  const command = parseSlashCommand(text);
  const skill =
    command?.skillName && resources.skills?.find((skill) => skill.name === command.skillName);
  const template =
    command && resources.promptTemplates?.find((template) => template.name === command.name);
  return prompt(
    skill
      ? formatSkillInvocation(skill, command!.args.trim())
      : template
        ? formatPromptTemplateInvocation(template, parseCommandArgs(command!.args))
        : text,
    images,
  );
}
