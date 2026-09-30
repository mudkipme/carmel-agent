/** Workspace-relative path as URL segments: names carry spaces, #, and ?. */
function encodeFilePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function agentFilesPath(agentId: string, path = "") {
  const filesPath = `/agents/${agentId}/files`;
  return path ? `${filesPath}/${encodeFilePath(path)}` : filesPath;
}

/** The Changes view, optionally opened on one file's diff in one area. */
export function agentChangesPath(agentId: string, change?: { path: string; area: string }) {
  const changesPath = `/agents/${agentId}/changes`;
  return change ? `${changesPath}/${encodeFilePath(change.path)}?${new URLSearchParams({ area: change.area })}` : changesPath;
}

/**
 * The workspace file a markdown link points at, or undefined for anything else.
 *
 * Agents link files the way a README does — `[post](post/love-live.md)` —
 * relative to their working directory, which is the file manager's root. URLs
 * with a scheme, protocol-relative and root-absolute hrefs, and in-page anchors
 * stay ordinary links, as does a path climbing out of the workspace.
 */
export function workspaceFileFromHref(href: string | undefined) {
  if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || /^[/\\#?]/.test(href)) return undefined;

  let path = href.replace(/[?#].*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }

  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!segments.pop()) return undefined;
      continue;
    }
    segments.push(segment);
  }
  return segments.length ? segments.join("/") : undefined;
}
