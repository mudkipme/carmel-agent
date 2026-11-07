import { createHash } from "node:crypto";
import type { HomeMemoryForgettingRule } from "@carmel-agent/shared";

type Fact = { content: string; scope: string; slot?: string };
const normalize = (text: string) =>
  text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
const hash = (text: string) => createHash("sha256").update(normalize(text)).digest("hex");
const ignored = new Set(
  "a an and are as at be been by for from has have i in is it me my of on or that the their them they this to user users was we were with you your prefer prefers like likes".split(
    " ",
  ),
);

export function homeMemoryForgettingRule(fact: Fact): HomeMemoryForgettingRule {
  const terms = [
    ...new Set(
      (normalize(fact.content).match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])
        .filter((word) => !ignored.has(word))
        .map((word) =>
          word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word,
        ),
    ),
  ];
  return {
    contentHash: hash(fact.content),
    slotHash: fact.slot ? hash(fact.slot) : null,
    scopeHash: hash(fact.scope),
    terms: terms.map(hash),
  };
}

export function matchesForgottenMemory(
  rule: HomeMemoryForgettingRule,
  fact: HomeMemoryForgettingRule,
) {
  if (rule.contentHash === fact.contentHash || (rule.slotHash && rule.slotHash === fact.slotHash))
    return true;
  const terms = new Set(rule.terms);
  const overlap = fact.terms.filter((term) => terms.has(term)).length;
  const minimum = rule.scopeHash === fact.scopeHash ? 2 : 3;
  return (
    overlap >= minimum && overlap >= Math.ceil(Math.min(rule.terms.length, fact.terms.length) * 0.8)
  );
}
