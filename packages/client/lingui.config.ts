import { defineConfig } from "@lingui/cli";

export default defineConfig({
  locales: ["en", "zh-Hans", "zh-Hant"],
  sourceLocale: "en",
  fallbackLocales: { default: "en" },
  catalogs: [{ path: "<rootDir>/src/locales/{locale}/messages", include: ["<rootDir>/src"] }],
});
