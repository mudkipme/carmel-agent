const queryStopWords = new Set(
  "a an and are as at be been but by can could did do does for from had has have help how i if in into is it its me my of on or our please say should show some tell that the their them then there these they this those to us use user was we were what when where which who why will with would you your about remember memory know status".split(
    " ",
  ),
);

const cjkChar = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\uff70\uff9e\uff9f]/u;
const hanChar = /\p{Script=Han}/u;
const cjkRuns =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\uff70\uff9e\uff9f]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\uff70\uff9e\uff9f]+/gu;
const cjkFiller =
  /[ーｰ]{2,}|我们|你们|他们|她们|它们|这个|那个|一下|一个|可以|时候|现在|知道|告诉|记得|还是|就是|不是|没有|已经|因为|所以|但是|如果|然后|还有|请问|帮我|怎样|这样|那样|哪里|哪个|应该|一些|什么|怎么|哪些|如何|[的了是吗呢吧啊呀哦嗯么]/gu;

export const hasCjk = (text: string) => cjkChar.test(text);

export function queryEffectiveLength(query: string) {
  const trimmed = query.trim();
  return trimmed.length + [...trimmed].filter(hasCjk).length;
}

export function sameSearchWord(term: string, word: string) {
  if (term === word) return true;
  if (hasCjk(term)) return word.includes(term) || term.includes(word);
  if (term.length < 4 || word.length < 4) return false;
  const stem =
    term.length > 4 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term;
  const wordStem =
    word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
  if (stem === wordStem) return true;
  return (
    stem.length >= 4 &&
    (word.startsWith(stem) || (stem.startsWith(word) && stem.length - word.length <= 3))
  );
}

export function extractSearchTerms(query: string) {
  const lower = query.normalize("NFKC").toLowerCase();
  const words: string[] = [];
  const bigrams: string[] = [];
  for (const run of lower.match(cjkRuns) ?? []) {
    if (!cjkChar.test(run)) {
      for (const word of run.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []) {
        if (!queryStopWords.has(word) && !words.includes(word)) words.push(word);
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
  return [...words.slice(0, 12), ...bigrams.slice(0, 16)];
}
