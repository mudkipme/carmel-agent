import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLocale } from "./locale.ts";

test("language detection respects browser order and Chinese scripts before regions", () => {
  assert.equal(resolveLocale(["fr-FR", "zh-CN", "en"]), "zh-Hans");
  assert.equal(resolveLocale(["en-GB", "zh-TW"]), "en");
  assert.equal(resolveLocale(["zh-SG"]), "zh-Hans");
  assert.equal(resolveLocale(["zh-Hans-TW"]), "zh-Hans");
  assert.equal(resolveLocale(["zh-Hant-CN"]), "zh-Hant");
  for (const language of ["zh-TW", "zh-HK", "zh-MO"]) {
    assert.equal(resolveLocale([language]), "zh-Hant");
  }
  assert.equal(resolveLocale(["ja-JP"]), "en");
  assert.equal(resolveLocale([]), "en");
});
