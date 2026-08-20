import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";

const storageKey = "carmel-agent-theme";
const listeners = new Set<() => void>();

let currentThemePreference = readStoredThemePreference();
let mediaQuery: MediaQueryList | undefined;

export function applyThemePreference() {
  if (typeof document === "undefined") return;
  ensureSystemThemeListener();
  const resolvedTheme = resolveThemePreference(currentThemePreference);
  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themePreference = currentThemePreference;
  document.documentElement.style.colorScheme = resolvedTheme;
  syncThemeColorMeta();
}

// The browser/PWA chrome has to follow the theme the user actually picked, which
// is not necessarily the one the OS reports. Reading the token back keeps this
// honest if the palette is ever retuned.
function syncThemeColorMeta() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const background = getComputedStyle(document.documentElement).getPropertyValue("--bg1").trim();
  if (background) meta.content = background;
}

export function setThemePreference(themePreference: ThemePreference) {
  currentThemePreference = themePreference;
  writeStoredThemePreference(themePreference);
  applyThemePreference();
  emitThemeChange();
}

export function useThemePreference() {
  return useSyncExternalStore(subscribeThemePreference, getThemePreference, getThemePreference);
}

function getThemePreference() {
  return currentThemePreference;
}

function subscribeThemePreference(listener: () => void) {
  listeners.add(listener);
  ensureSystemThemeListener();
  return () => listeners.delete(listener);
}

function ensureSystemThemeListener() {
  if (mediaQuery || typeof window === "undefined" || !window.matchMedia) return;
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", () => {
    if (currentThemePreference !== "system") return;
    applyThemePreference();
    emitThemeChange();
  });
}

function resolveThemePreference(themePreference: ThemePreference) {
  if (themePreference !== "system") return themePreference;
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function emitThemeChange() {
  for (const listener of listeners) listener();
}

function readStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(storageKey);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function writeStoredThemePreference(themePreference: ThemePreference) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, themePreference);
  } catch {
    // Ignore storage failures; the current document still updates.
  }
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}
