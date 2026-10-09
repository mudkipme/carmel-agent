import { ArrowLeftIcon, ExternalLinkIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  AgentConfig,
  GitChange,
  GitChangeArea,
  GitDiffSide,
  GitFileDiff,
  GitStatus,
} from "@carmel-agent/shared";
import { DiffViewer, type DiffLayout } from "@/components/harness/changes/DiffViewer";
import { inferLanguage, isDarkTheme } from "@/components/harness/files/editor-extensions";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { agentChangesPath, agentFilesPath } from "@/lib/file-links";
import { useThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

type ChangesViewProps = {
  agent: AgentConfig;
  /** The file whose diff is open, from the route; repository-relative. */
  changePath?: string;
  area?: GitChangeArea;
};

const GROUPS: ReadonlyArray<{ area: GitChangeArea; label: string }> = [
  { area: "conflicted", label: "Conflicts" },
  { area: "staged", label: "Staged" },
  { area: "unstaged", label: "Changes" },
  { area: "untracked", label: "Untracked" },
];

const LAYOUT_STORAGE_KEY = "carmel-diff-layout";
const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * The agent's uncommitted work, read-only: what git status says changed, and
 * the diff of whichever file is picked. Both halves ride in the URL, so a
 * reload -- or a link -- comes back to the same diff.
 */
export function ChangesView({ agent, changePath, area }: ChangesViewProps) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<GitStatus>();
  const [statusError, setStatusError] = useState("");
  const [loading, setLoading] = useState(true);
  // Bumped on refresh so the open diff reloads along with the list.
  const [revision, setRevision] = useState(0);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.getAgentGitStatus(agent.id));
      setStatusError("");
    } catch (error) {
      setStatusError(errorMessage(error, "Unable to read git status"));
    } finally {
      setLoading(false);
      setRevision((current) => current + 1);
    }
  }, [agent.id]);

  useEffect(() => {
    void loadStatus();
    // The agent keeps working while this is open elsewhere; coming back to the
    // tab is when a stale list would mislead.
    const onFocus = () => void loadStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadStatus]);

  const changes = status?.repository ? status.changes : [];
  const selected =
    changePath && area
      ? changes.find((change) => change.path === changePath && change.area === area)
      : undefined;
  const open = (change: GitChange) => navigate(agentChangesPath(agent.id, change));

  return (
    <div className="flex h-full min-h-0 bg-background">
      <div
        className={cn(
          "flex min-h-0 w-full flex-col border-r lg:w-80 lg:shrink-0",
          changePath && "hidden lg:flex",
        )}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13px] font-medium">{branchLabel(status)}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {summaryLabel(status, loading)}
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Refresh"
            disabled={loading}
            onClick={() => void loadStatus()}
          >
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {statusError ? (
            <p className="px-3 py-3 text-xs break-words text-destructive">{statusError}</p>
          ) : status && !status.repository ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              This agent's working directory is not a git repository.
            </p>
          ) : status && changes.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">No uncommitted changes.</p>
          ) : (
            GROUPS.map(({ area: groupArea, label }) => {
              const group = changes.filter((change) => change.area === groupArea);
              if (group.length === 0) return null;
              return (
                <section key={groupArea} aria-label={label}>
                  <h3 className="nav-label px-3 pt-3 pb-1">
                    {label} <span className="tabular-nums">{group.length}</span>
                  </h3>
                  {group.map((change) => (
                    <ChangeRow
                      key={`${change.area}:${change.path}`}
                      change={change}
                      active={change === selected}
                      onOpen={() => open(change)}
                    />
                  ))}
                </section>
              );
            })
          )}
          {status?.repository && status.truncated ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              The list was cut off; there are more changes than it shows. An untracked dependency
              folder usually belongs in .gitignore.
            </p>
          ) : null}
        </div>
      </div>
      <div
        className={cn("min-h-0 min-w-0 flex-1 flex-col", changePath ? "flex" : "hidden lg:flex")}
      >
        {selected ? (
          <DiffPanel
            key={`${selected.area}:${selected.path}:${revision}`}
            agent={agent}
            change={selected}
            onBack={() => navigate(agentChangesPath(agent.id))}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-sm text-muted-foreground">
            {changePath && status
              ? "This file no longer has changes here."
              : changes.length > 0
                ? "Select a changed file to see its diff."
                : null}
            {changePath ? (
              <Button
                size="sm"
                variant="outline"
                className="lg:hidden"
                onClick={() => navigate(agentChangesPath(agent.id))}
              >
                <ArrowLeftIcon />
                All changes
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ChangeRow({
  change,
  active,
  onOpen,
}: {
  change: GitChange;
  active: boolean;
  onOpen: () => void;
}) {
  const slash = change.path.lastIndexOf("/");
  const name = change.path.slice(slash + 1);
  const directory = slash >= 0 ? change.path.slice(0, slash) : "";
  const badge = KIND_BADGES[change.kind];
  return (
    <button
      type="button"
      data-active={active}
      title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}
      className="nav-item flex h-8 w-full items-center gap-2 px-3 text-left"
      onClick={onOpen}
    >
      <span
        aria-label={badge.label}
        className={cn(
          "w-3 shrink-0 text-center font-mono text-[11px] font-semibold",
          badge.className,
        )}
      >
        {badge.letter}
      </span>
      <span className="truncate text-[13px]">{name}</span>
      {directory ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground">{directory}</span>
      ) : null}
    </button>
  );
}

const KIND_BADGES: Record<GitChange["kind"], { letter: string; label: string; className: string }> =
  {
    added: { letter: "A", label: "Added", className: "text-[var(--color-green)]" },
    untracked: { letter: "U", label: "Untracked", className: "text-[var(--color-green)]" },
    modified: { letter: "M", label: "Modified", className: "text-[var(--color-orange)]" },
    type_changed: { letter: "T", label: "Type changed", className: "text-[var(--color-orange)]" },
    renamed: { letter: "R", label: "Renamed", className: "text-[var(--color-blue)]" },
    copied: { letter: "C", label: "Copied", className: "text-[var(--color-blue)]" },
    deleted: { letter: "D", label: "Deleted", className: "text-destructive" },
    conflicted: { letter: "!", label: "Conflicted", className: "text-destructive" },
  };

const AREA_LABELS: Record<GitChangeArea, string> = {
  staged: "Staged: HEAD → index",
  unstaged: "Unstaged: index → working tree",
  untracked: "Untracked: new file",
  conflicted: "Conflicted: ours → working tree",
};

function DiffPanel({
  agent,
  change,
  onBack,
}: {
  agent: AgentConfig;
  change: GitChange;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const dark = isDarkTheme(useThemePreference());
  const [diff, setDiff] = useState<GitFileDiff>();
  const [error, setError] = useState("");
  const [layout, setLayout] = useDiffLayout();
  const language = useMemo(() => inferLanguage(change.path), [change.path]);

  useEffect(() => {
    let cancelled = false;
    api
      .getAgentGitDiff(agent.id, change)
      .then((loaded) => {
        if (!cancelled) setDiff(loaded);
      })
      .catch((loadError) => {
        if (!cancelled) setError(errorMessage(loadError, "Unable to load this diff"));
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, change]);

  const unavailable = diff ? unavailableReason(diff.original, diff.modified) : undefined;
  // The working-tree file, when there is one to open.
  const openablePath =
    change.workspacePath && diff?.modified.kind !== "absent" && change.area !== "staged"
      ? change.workspacePath
      : undefined;

  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Button
          size="icon-sm"
          variant="ghost"
          className="lg:hidden"
          title="All changes"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-medium">
            {change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}
          </h2>
          <p className="truncate text-xs text-muted-foreground">{AREA_LABELS[change.area]}</p>
        </div>
        <div
          role="group"
          aria-label="Diff layout"
          className="hidden shrink-0 rounded-md border p-0.5 lg:flex"
        >
          {(["split", "unified"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={layout === option}
              className={cn(
                "rounded-sm px-2 py-0.5 text-xs capitalize text-muted-foreground",
                layout === option && "bg-[var(--ui2)] text-foreground",
              )}
              onClick={() => setLayout(option)}
            >
              {option}
            </button>
          ))}
        </div>
        {openablePath ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(agentFilesPath(agent.id, openablePath))}
          >
            <ExternalLinkIcon />
            Open file
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {error ? (
          <p className="p-4 text-xs break-words text-destructive">{error}</p>
        ) : !diff ? (
          <p className="p-4 text-xs text-muted-foreground">Loading diff...</p>
        ) : unavailable ? (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
            {unavailable}
          </div>
        ) : (
          <DiffViewer
            original={sideText(diff.original)}
            modified={sideText(diff.modified)}
            language={language}
            dark={dark}
            layout={layout}
          />
        )}
      </div>
    </>
  );
}

/**
 * Split needs width; on a narrow screen it is always unified. On desktop the
 * choice is remembered.
 */
function useDiffLayout(): [DiffLayout, (layout: DiffLayout) => void] {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);
  const [preferred, setPreferred] = useState<DiffLayout>(() =>
    window.localStorage.getItem(LAYOUT_STORAGE_KEY) === "unified" ? "unified" : "split",
  );
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const sync = () => setDesktop(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  const choose = (layout: DiffLayout) => {
    setPreferred(layout);
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
  };
  return [desktop ? preferred : "unified", choose];
}

function unavailableReason(original: GitDiffSide, modified: GitDiffSide) {
  if (original.kind === "binary" || modified.kind === "binary")
    return "Binary file; no text diff to show.";
  const tooLarge = [original, modified].find((side) => side.kind === "too_large");
  if (tooLarge?.kind === "too_large")
    return `Too large to diff here (${formatBytes(tooLarge.bytes)}).`;
  if (original.kind === "absent" && modified.kind === "absent") return "Nothing to compare.";
  return undefined;
}

function sideText(side: GitDiffSide) {
  return side.kind === "text" ? side.text : "";
}

function branchLabel(status: GitStatus | undefined) {
  if (!status?.repository) return "Changes";
  return (
    status.branch ?? (status.head ? `Detached at ${status.head.slice(0, 7)}` : "No commits yet")
  );
}

function summaryLabel(status: GitStatus | undefined, loading: boolean) {
  if (!status) return loading ? "Reading git status..." : "";
  if (!status.repository) return "Not a repository";
  const count = status.changes.length;
  const sync = [
    status.ahead ? `${status.ahead} ahead` : "",
    status.behind ? `${status.behind} behind` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return [`${count} ${count === 1 ? "change" : "changes"}`, sync].filter(Boolean).join(" · ");
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
