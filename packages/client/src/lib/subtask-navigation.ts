import type { Location } from "react-router-dom";

export function subtaskLinkTarget(
  href: string,
  location: Pick<Location, "pathname" | "search" | "hash">,
) {
  const match = href.match(/^\/agents\/[^/]+\/sessions\/([^/]+)\/helpers\/(\d+)(?:[?#]|$)/);
  if (!match) return undefined;
  const params = new URLSearchParams(location.search);
  params.set("panel", "subtasks");
  params.set("subtaskSession", decodeURIComponent(match[1]!));
  params.set("subtask", match[2]!);
  params.delete("subtaskBefore");
  return { pathname: location.pathname, search: `?${params}`, hash: location.hash };
}
