export const locales = ["en", "zh-Hans", "zh-Hant"] as const;
export type Locale = (typeof locales)[number];
export type LanguagePreference = Locale | "system";

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || locales.includes(value as Locale);
}

export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const tag = language.toLowerCase().replaceAll("_", "-");
    if (tag === "en" || tag.startsWith("en-")) return "en";
    if (tag === "zh" || tag.startsWith("zh-")) {
      const subtags = tag.split("-");
      if (subtags.includes("hans")) return "zh-Hans";
      if (subtags.includes("hant") || subtags.some((part) => ["tw", "hk", "mo"].includes(part)))
        return "zh-Hant";
      return "zh-Hans";
    }
  }
  return "en";
}
