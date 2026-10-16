export type WorkspaceView = "files" | "changes" | "terminal" | "browser";
export type WorkspaceMode = "split" | "full";

export const WORKSPACE_MODE_KEY = "carmel-workspace-mode";
export const WORKSPACE_RATIO_KEY = "carmel-workspace-ratio";
export const DEFAULT_WORKSPACE_RATIO = 0.55;
export const MIN_PANE_WIDTH = 360;
export const MIN_SPLIT_WIDTH = MIN_PANE_WIDTH * 2 + 1;

export function isWorkspaceView(view: string): view is WorkspaceView {
  return view === "files" || view === "changes" || view === "terminal" || view === "browser";
}

export function workspaceWidth(available: number, ratio: number) {
  const preferred = Number.isFinite(ratio) ? ratio : DEFAULT_WORKSPACE_RATIO;
  return Math.round(
    Math.max(MIN_PANE_WIDTH, Math.min(available - MIN_PANE_WIDTH - 1, available * preferred)),
  );
}

export function readWorkspacePreference(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeWorkspacePreference(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The current layout still works when browser storage is unavailable.
  }
}

/** Keep a conversation attached to a workspace URL, including nested file/diff links. */
export function workspaceChatPath(path: string, sessionId?: string) {
  const [pathname, search = ""] = path.split("?");
  const params = new URLSearchParams(search);
  params.set("chat", sessionId ?? "new");
  return `${pathname}?${params}`;
}
