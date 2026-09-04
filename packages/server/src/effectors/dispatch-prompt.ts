import { parseSlashCommand, type PromptInput } from "@carmel-agent/shared";
import type { PromptDispatcher } from "./contracts/agent-driver.ts";

/**
 * Resolve composer text against the agent's live resources and send it.
 *
 * This used to be `runHarnessPrompt`, and it used to import four things from Pi
 * -- two invocation formatters, an argument parser, and the harness type -- for
 * what is entirely Carmel policy: which slash commands exist, and which one wins
 * when a name is ambiguous. Those formatters were only ever there to work around
 * a driver limitation (named invocations take text, so an attachment has to be
 * inlined), so they moved behind `invokeSkill`/`invokeTemplate` where the
 * limitation lives. What is left is the rule itself, and it now reads as one.
 */
export async function dispatchPrompt(
  driver: PromptDispatcher,
  text: string,
  images?: PromptInput["images"],
): Promise<void> {
  const command = parseSlashCommand(text);
  if (!command) return driver.prompt(text, images);

  const resources = await driver.listResources();

  if (command.skillName && resources.skills.some((skill) => skill.name === command.skillName)) {
    return driver.invokeSkill(command.skillName, command.args.trim() || undefined, images);
  }

  // A `skill:`-namespaced token that matches no loaded skill still falls through
  // to a prompt template of that exact name, and then to plain text.
  if (resources.promptTemplates.some((template) => template.name === command.name)) {
    return driver.invokeTemplate(command.name, command.args, images);
  }

  return driver.prompt(text, images);
}
