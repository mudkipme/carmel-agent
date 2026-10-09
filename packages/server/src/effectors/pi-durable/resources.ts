import { parse } from "yaml";
import { basename, dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
export type Skill = { name: string; description: string; content: string; filePath: string; disableModelInvocation?: boolean; source?: "builtin" };
export type PromptTemplate = { name: string; content: string; description?: string };
export type SkillDiagnostic = { type: "warning"; message: string; path: string };
export type PromptTemplateDiagnostic = SkillDiagnostic;
function frontmatter(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return { meta: match ? parse(match[1]!) as Record<string, unknown> ?? {} : {}, content: (match ? text.slice(match[0].length) : text).trim() };
}
// Guarded reads are needed: the coding-agent resource loaders use host fs directly.
export async function loadSkills(env: ExecutionEnv, directory: string, context: Context) {
  const skills: Skill[] = [], diagnostics: SkillDiagnostic[] = [];
  const seen = new Set<string>();
  async function walk(path: string) {
    try {
      const canonical = getOrThrow(await env.canonicalPath(path, context));
      if (seen.has(canonical)) return;
      seen.add(canonical);
      const entries = getOrThrow(await env.listDir(path, context));
      if (entries.some((entry) => entry.name === "SKILL.md")) {
        const filePath = join(path, "SKILL.md");
        const { meta, content } = frontmatter(getOrThrow(await env.readTextFile(filePath, context)));
        if (typeof meta.description !== "string" || !meta.description.trim()) throw new Error("Skill description is required.");
        skills.push({ name: typeof meta.name === "string" ? meta.name : basename(path), description: meta.description, content, filePath, ...(meta["disable-model-invocation"] === true ? { disableModelInvocation: true } : {}) });
        return;
      }
      for (const entry of entries) if (entry.kind === "directory" || entry.kind === "symlink") await walk(join(path, entry.name));
    } catch (error) {
      if ((error as { code?: string }).code !== "not_found") diagnostics.push({ type: "warning", path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  await walk(directory);
  return { skills, diagnostics };
}
export async function loadPromptTemplates(env: ExecutionEnv, directory: string, context: Context) {
  const promptTemplates: PromptTemplate[] = [], diagnostics: PromptTemplateDiagnostic[] = [];
  try {
    for (const entry of getOrThrow(await env.listDir(directory, context))) {
      if (!entry.name.endsWith(".md")) continue;
      const path = join(directory, entry.name);
      try {
        const { meta, content } = frontmatter(getOrThrow(await env.readTextFile(path, context)));
        promptTemplates.push({ name: basename(entry.name, ".md"), content, ...(typeof meta.description === "string" ? { description: meta.description } : {}) });
      } catch (error) { diagnostics.push({ type: "warning", path, message: error instanceof Error ? error.message : String(error) }); }
    }
  } catch (error) { if ((error as { code?: string }).code !== "not_found") diagnostics.push({ type: "warning", path: directory, message: error instanceof Error ? error.message : String(error) }); }
  return { promptTemplates, diagnostics };
}
function escape(text: string) { return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
export function formatSkillsForSystemPrompt(skills: Skill[]) {
  return formatSkillsForPrompt(skills.map(skill => ({ ...skill, baseDir: dirname(skill.filePath), disableModelInvocation: skill.disableModelInvocation ?? false, sourceInfo: { path: skill.filePath, source: "local", scope: "project", origin: "top-level" } })));
}
export function formatSkillInvocation(skill: Skill, instructions = "") {
  const location = skill.source === "builtin" ? ' source="builtin"' : ` location="${escape(skill.filePath)}"`;
  const base = skill.source === "builtin" ? "" : `Base directory: ${dirname(skill.filePath)}\n`;
  return `<skill name="${escape(skill.name)}"${location}>\n${base}${skill.content}\n</skill>${instructions ? `\n\n${instructions}` : ""}`;
}
export function parseCommandArgs(text: string): string[] {
  const args: string[] = [];
  let current = "", quote: string | undefined;
  for (const char of text) {
    if (quote) { if (char === quote) quote = undefined; else current += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (current) { args.push(current); current = ""; } }
    else current += char;
  }
  if (current) args.push(current);
  return args;
}
export function formatPromptTemplateInvocation(template: PromptTemplate, args: string[]) {
  // Pi's prompt-template helpers are not public exports in 1.1.0. Keep their substitution semantics here.
  return template.content.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, target: string | undefined, fallback: string, start: string | undefined, length: string | undefined, simple: string) => {
      if (target) return (target === "@" || target === "ARGUMENTS" ? args.join(" ") : args[Number(target) - 1]) || fallback;
      if (start) { const index = Math.max(0, Number(start) - 1); return args.slice(index, length ? index + Number(length) : undefined).join(" "); }
      return simple === "ARGUMENTS" || simple === "@" ? args.join(" ") : args[Number(simple) - 1] ?? "";
    });
}
