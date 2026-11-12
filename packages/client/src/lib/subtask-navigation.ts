import type { Location } from "react-router-dom";

export function subtaskLinkTarget(
  href: string,
  location: Pick<Location, "pathname" | "search" | "hash">,
) {
  const match = href.match(/^\/agents\/[^/]+\/sessions\/([^/]+)\/helpers\/(\d+)(?:[?#]|$)/);
  if (!match) return undefined;
  const params = new URLSearchParams(location.search);
  params.set("panel", "subtasks");
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]!);
  } catch {
    // A malformed percent escape in a link must not crash the transcript.
    return undefined;
  }
  params.set("subtaskSession", sessionId);
  params.set("subtask", match[2]!);
  params.delete("subtaskBefore");
  return { pathname: location.pathname, search: `?${params}`, hash: location.hash };
}
