import { createHash } from "node:crypto";
import type { HomeMemoryForgettingRule } from "@carmel-agent/shared";

type Fact = { content: string; scope: string; slot?: string };
const normalize = (text: string) =>
  text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
const hash = (text: string) => createHash("sha256").update(normalize(text)).digest("hex");
const emptyScopeHash = hash("");
const ignored = new Set(
  "a an and are as at be been by for from has have i in is it me my of on or that the their them they this to user users was we were with you your prefer prefers like likes".split(
    " ",
  ),
);
const cjkChar = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\uff70\uff9e\uff9f]/u;
const hanChar = /\p{Script=Han}/u;
const cjkRuns =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\uff70\uff9e\uff9f]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\uff70\uff9e\uff9f]+/gu;
const cjkFiller =
  /[ーｰ]{2,}|我们|你们|他们|她们|它们|这个|那个|一下|一个|可以|时候|现在|知道|告诉|记得|还是|就是|不是|没有|已经|因为|所以|但是|如果|然后|还有|请问|帮我|怎样|这样|那样|哪里|哪个|应该|一些|什么|怎么|哪些|如何|[的了是吗呢吧啊呀哦嗯么]/gu;

export function extractForgettingTerms(text: string): string[] {
  const norm = normalize(text);
  const words: string[] = [];
  const bigrams: string[] = [];
  for (const run of norm.match(cjkRuns) ?? []) {
    if (!cjkChar.test(run)) {
      for (const word of run.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []) {
        if (ignored.has(word)) continue;
        const stemmed =
          word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
        if (!words.includes(stemmed)) words.push(stemmed);
      }
      continue;
    }
    const segments = run
      .replace(cjkFiller, " ")
      .split(" ")
      .map((segment) => [...segment]);
    for (const chars of segments) {
      for (let i = 0; i + 1 < chars.length; i++) {
        const pair = chars[i]! + chars[i + 1]!;
        if (!bigrams.includes(pair)) bigrams.push(pair);
      }
    }
    if (segments.every((chars) => chars.length < 2)) {
      for (const chars of segments) {
        if (chars.length === 1 && hanChar.test(chars[0]!) && !bigrams.includes(chars[0]!))
          bigrams.push(chars[0]!);
      }
    }
  }
  return [...words, ...bigrams];
}

export function homeMemoryForgettingRule(fact: Fact): HomeMemoryForgettingRule {
  const terms = extractForgettingTerms(fact.content);
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
  if (!rule.terms.length || !fact.terms.length) return false;
  const terms = new Set(rule.terms);
  const overlap = fact.terms.filter((term) => terms.has(term)).length;
  const sameOrWildcardScope =
    rule.scopeHash === fact.scopeHash || rule.scopeHash === emptyScopeHash;
  const minimum = Math.min(rule.terms.length, sameOrWildcardScope ? 2 : 3);
  return (
    overlap >= minimum && overlap >= Math.ceil(Math.min(rule.terms.length, fact.terms.length) * 0.8)
  );
}
