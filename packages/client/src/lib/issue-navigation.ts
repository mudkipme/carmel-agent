export const issueFilters = ["queue", "attention", "backlog", "done"] as const;
export type IssueFilter = (typeof issueFilters)[number];

export function readIssueFilter(params: URLSearchParams): IssueFilter {
  const filter = params.get("filter");
  return issueFilters.find((value) => value === filter) ?? "queue";
}

/** Carry list context into detail/create URLs so their back links restore it. */
export function issueListSearch(params: URLSearchParams) {
  const query = new URLSearchParams();
  const filter = readIssueFilter(params);
  if (filter !== "queue") query.set("filter", filter);
  if (params.get("q")) query.set("q", params.get("q")!);
  return query.size ? `?${query}` : "";
}
