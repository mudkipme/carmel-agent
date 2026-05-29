export const DESKTOP_SIDEBAR_QUERY = "(min-width: 1024px)";
export const SIDEBAR_WIDTH_STORAGE_KEY = "carmel-sidebar-width";
export const DEFAULT_SIDEBAR_WIDTH = 298;
export const MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 520;

export type SidebarMode = "sessions" | "files";

export function getDefaultSidebarOpen() {
  return typeof window === "undefined" ? true : window.matchMedia(DESKTOP_SIDEBAR_QUERY).matches;
}

export function getDefaultSidebarWidth() {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH;
  const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  return storedWidth ? clampSidebarWidth(Number(storedWidth)) : DEFAULT_SIDEBAR_WIDTH;
}

export function clampSidebarWidth(width: number) {
  return Number.isFinite(width)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
    : DEFAULT_SIDEBAR_WIDTH;
}

export function sortSessions<T extends { pinnedAt?: number; updatedAt: number }>(a: T, b: T) {
  if (a.pinnedAt && b.pinnedAt) return b.pinnedAt - a.pinnedAt;
  if (a.pinnedAt) return -1;
  if (b.pinnedAt) return 1;
  return b.updatedAt - a.updatedAt;
}

export function resetSidebarWidth(setSidebarWidth: (width: number) => void) {
  setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(DEFAULT_SIDEBAR_WIDTH));
}
