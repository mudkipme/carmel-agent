import { parse } from "yaml";
import { basename, dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../../errors.ts";
export type Skill = {
  name: string;
  description: string;
  content: string;
  filePath: string;
  disableModelInvocation?: boolean;
  source?: "builtin";
};
export type PromptTemplate = { name: string; content: string; description?: string };
export type SkillDiagnostic = { type: "warning"; message: string; path: string };
export type PromptTemplateDiagnostic = SkillDiagnostic;
function frontmatter(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return {
    meta: match ? ((parse(match[1]!) as Record<string, unknown>) ?? {}) : {},
    content: (match ? text.slice(match[0].length) : text).trim(),
  };
}
// Guarded reads are needed: the coding-agent resource loaders use host fs directly.
export async function loadSkills(env: ExecutionEnv, directory: string, context: Context) {
  const skills: Skill[] = [],
    diagnostics: SkillDiagnostic[] = [];
  const seen = new Set<string>();
  async function walk(path: string) {
    try {
      const canonical = getOrThrow(await env.canonicalPath(path, context));
      if (seen.has(canonical)) return;
      seen.add(canonical);
      const entries = getOrThrow(await env.listDir(path, context));
      if (entries.some((entry) => entry.name === "SKILL.md")) {
        const filePath = join(path, "SKILL.md");
        const { meta, content } = frontmatter(
          getOrThrow(await env.readTextFile(filePath, context)),
        );
        if (typeof meta.description !== "string" || !meta.description.trim())
          throw new Error("Skill description is required.");
        skills.push({
          name: typeof meta.name === "string" ? meta.name : basename(path),
          description: meta.description,
          content,
          filePath,
          ...(meta["disable-model-invocation"] === true ? { disableModelInvocation: true } : {}),
        });
        return;
      }
      for (const entry of entries)
        if (entry.kind === "directory" || entry.kind === "symlink")
          await walk(join(path, entry.name));
    } catch (error) {
      if ((error as { code?: string }).code !== "not_found")
        diagnostics.push({
          type: "warning",
          path,
          message: errorMessage(error, String(error)),
        });
    }
  }
  await walk(directory);
  return { skills, diagnostics };
}
export async function loadPromptTemplates(env: ExecutionEnv, directory: string, context: Context) {
  const promptTemplates: PromptTemplate[] = [],
    diagnostics: PromptTemplateDiagnostic[] = [];
  try {
    for (const entry of getOrThrow(await env.listDir(directory, context))) {
      if (!entry.name.endsWith(".md")) continue;
      const path = join(directory, entry.name);
      try {
        const { meta, content } = frontmatter(getOrThrow(await env.readTextFile(path, context)));
        promptTemplates.push({
          name: basename(entry.name, ".md"),
          content,
          ...(typeof meta.description === "string" ? { description: meta.description } : {}),
        });
      } catch (error) {
        diagnostics.push({
          type: "warning",
          path,
          message: errorMessage(error, String(error)),
        });
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "not_found")
      diagnostics.push({
        type: "warning",
        path: directory,
        message: errorMessage(error, String(error)),
      });
  }
  return { promptTemplates, diagnostics };
}
function escape(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
export function formatSkillsForSystemPrompt(skills: Skill[]) {
  return formatSkillsForPrompt(
    skills.map((skill) => ({
      ...skill,
      baseDir: dirname(skill.filePath),
      disableModelInvocation: skill.disableModelInvocation ?? false,
      sourceInfo: { path: skill.filePath, source: "local", scope: "project", origin: "top-level" },
    })),
  );
}
export function formatSkillInvocation(skill: Skill, instructions = "") {
  const location =
    skill.source === "builtin" ? ' source="builtin"' : ` location="${escape(skill.filePath)}"`;
  const base = skill.source === "builtin" ? "" : `Base directory: ${dirname(skill.filePath)}\n`;
  return `<skill name="${escape(skill.name)}"${location}>\n${base}${skill.content}\n</skill>${instructions ? `\n\n${instructions}` : ""}`;
}
export function parseCommandArgs(text: string): string[] {
  // Pi's prompt helpers are still not package exports. This matches parseCommandArgs in
  // pi-coding-agent 1.6.0: quoted empty strings ("" or '') are arguments, quotes open only at
  // the start of an argument (so "doesn't" stays one word), \" escapes the open quote, and an
  // unclosed quote is read as literal text.
  const args: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: string | undefined;
  let quoteStart = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === "\\" && text[i + 1] === quote) {
        current += quote;
        i++;
      } else if (char === quote) quote = undefined;
      else current += char;
    } else if ((char === '"' || char === "'") && !hasToken) {
      quote = char;
      quoteStart = i;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += char;
      hasToken = true;
    }
    if (quote && i === text.length - 1) {
      quote = undefined;
      current = text[quoteStart]!;
      i = quoteStart;
    }
  }
  if (hasToken) args.push(current);
  return args;
}
export function formatPromptTemplateInvocation(template: PromptTemplate, args: string[]) {
  // Same substitution as pi-coding-agent's unexported substituteArgs.
  return template.content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (
      _match,
      target: string | undefined,
      fallback: string,
      start: string | undefined,
      length: string | undefined,
      simple: string,
    ) => {
      if (target)
        return (
          (target === "@" || target === "ARGUMENTS" ? args.join(" ") : args[Number(target) - 1]) ||
          fallback
        );
      if (start) {
        const index = Math.max(0, Number(start) - 1);
        return args.slice(index, length ? index + Number(length) : undefined).join(" ");
      }
      return simple === "ARGUMENTS" || simple === "@"
        ? args.join(" ")
        : (args[Number(simple) - 1] ?? "");
    },
  );
}
