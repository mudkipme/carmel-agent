import { i18n } from "@lingui/core";
import { useSyncExternalStore } from "react";
import { messages as en } from "@/locales/en/messages.po";
import { messages as zhHans } from "@/locales/zh-Hans/messages.po";
import { messages as zhHant } from "@/locales/zh-Hant/messages.po";
import { isLanguagePreference, resolveLocale, type LanguagePreference } from "./locale";

const storageKey = "carmel-agent-language";
let languagePreference = readLanguagePreference();

i18n.load({ en, "zh-Hans": zhHans, "zh-Hant": zhHant });
activateLanguage();

function readLanguagePreference(): LanguagePreference {
  try {
    const stored = localStorage.getItem(storageKey);
    return isLanguagePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function activateLanguage() {
  const locale =
    languagePreference === "system" ? resolveLocale(navigator.languages) : languagePreference;
  document.documentElement.lang = locale;
  i18n.activate(locale);
}

export function setLanguagePreference(preference: LanguagePreference) {
  languagePreference = preference;
  try {
    localStorage.setItem(storageKey, preference);
  } catch {}
  activateLanguage();
}

function subscribe(listener: () => void) {
  return i18n.on("change", listener);
}

export function useLanguagePreference() {
  return useSyncExternalStore(subscribe, () => languagePreference);
}

window.addEventListener("languagechange", () => {
  if (languagePreference === "system") activateLanguage();
});

export { i18n };
