import { statusLabel } from "@/lib/labels";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  BookOpenIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  UnplugIcon,
} from "lucide-react";
import type { AgentConfig, KnowledgeSearchResult } from "@carmel-agent/shared";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { useHarnessStore } from "@/store/harness-store";
import { PageHeader } from "./form-primitives";
import { ResourceError, ResourceLoading } from "./ResourceFeedback";

export function AgentKnowledgePage({ agent }: { agent: AgentConfig }) {
  const { i18n } = useLingui();
  const userId = useHarnessStore((s) => s.activeUserId);
  const owner = agent.ownerUserId === userId;
  const overview = useRemoteResource({
    key: `knowledge:${agent.id}`,
    load: (signal) => api.knowledge(agent.id, signal),
    topics: ["knowledge"],
  });
  const [params, setParams] = useSearchParams();
  const sourceId = params.get("source"),
    path = params.get("path");
  const fromLine = Math.max(1, Number(params.get("line")) || 1);
  // Merge instead of replacing, so opening a document keeps unrelated params
  // (for example the Home `from` marker) intact.
  const updateParams = (patch: Record<string, string | undefined>) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) next.delete(key);
        else next.set(key, value);
      }
      return next;
    });
  const doc = useRemoteResource({
    key: `knowledge-doc:${agent.id}:${sourceId}:${path}:${fromLine}`,
    topics: ["knowledge"],
    enabled: Boolean(sourceId && path),
    load: (signal) =>
      api.readKnowledge(agent.id, { sourceId: sourceId!, path: path!, fromLine }, signal),
  });
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"fast" | "semantic" | "deep">("fast");
  const [results, setResults] = useState<KnowledgeSearchResult>();
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addSource, setAddSource] = useState(false);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      await overview.refresh();
    } catch (error) {
      showError(i18n._("Knowledge action failed"), error);
    } finally {
      setBusy(false);
    }
  };
  const data = overview.data;
  const working = data && ["updating", "embedding"].includes(data.status.state);
  return (
    <div className="h-full min-w-0 overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <PageHeader
          title={i18n._("Knowledge")}

          icon={BookOpenIcon}
          actions={
            owner ? (
              <Button variant="outline" asChild>
                <Link to={`/agents/${agent.id}/settings/knowledge`}>
                  <Trans>Knowledge settings</Trans>
                </Link>
              </Button>
            ) : null
          }
        />
        {overview.error ? (
          <ResourceError error={overview.error} onRetry={overview.refresh} />
        ) : null}
        {overview.loading ? <ResourceLoading label={i18n._("Loading knowledge")} /> : null}
        {data ? (
          <>
            {!data.settings.enabled ? (
              <Alert>
                <AlertTitle>
                  <Trans>Knowledge is off</Trans>
                </AlertTitle>
                <AlertDescription>
                  {owner
                    ? i18n._(
                        "Enable knowledge in settings to register searchable document sources.",
                      )
                    : i18n._("The agent owner can enable knowledge in settings.")}
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div
                  className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"
                  role="status"
                >
                  <Badge variant={data.status.state === "error" ? "destructive" : "secondary"}>
                    {statusLabel(data.status.state)}
                  </Badge>
                  <span>
                    <Trans>{data.status.documents} documents</Trans>
                  </span>
                  {data.status.needsEmbedding > 0 ? (
                    <span>
                      <Trans>{data.status.needsEmbedding} awaiting embeddings</Trans>
                    </span>
                  ) : null}
                  {data.status.backend ? (
                    <span>
                      {data.status.backend}
                      {data.status.devices.length ? ` · ${data.status.devices.join(", ")}` : ""}
                    </span>
                  ) : null}
                  {data.status.lastUpdatedAt ? (
                    <span>
                      <Trans>
                        Updated {new Date(data.status.lastUpdatedAt).toLocaleString(i18n.locale)}
                      </Trans>
                    </span>
                  ) : null}
                </div>
                {data.status.error ? (
                  <Alert variant="destructive">
                    <AlertTitle>
                      <Trans>Index needs attention</Trans>
                    </AlertTitle>
                    <AlertDescription>{data.status.error}</AlertDescription>
                  </Alert>
                ) : null}
                <form
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    setSearching(true);
                    try {
                      setResults(await api.searchKnowledge(agent.id, { query, mode }));
                    } catch (error) {
                      showError(i18n._("Search failed"), error);
                    } finally {
                      setSearching(false);
                    }
                  }}
                >
                  <Field className="min-w-40 flex-1">
                    <FieldLabel htmlFor="knowledge-query">
                      <Trans>Search knowledge</Trans>
                    </FieldLabel>
                    <Input
                      id="knowledge-query"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={i18n._("Search reference documents…")}
                      required
                      maxLength={2000}
                    />
                  </Field>
                  <Field className="w-36">
                    <FieldLabel htmlFor="knowledge-mode">
                      <Trans>Search mode</Trans>
                    </FieldLabel>
                    <Select value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
                      <SelectTrigger id="knowledge-mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="fast">
                            <Trans>Fast</Trans>
                          </SelectItem>
                          <SelectItem value="semantic">
                            <Trans>Semantic</Trans>
                          </SelectItem>
                          <SelectItem value="deep">
                            <Trans>Deep</Trans>
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Button type="submit" disabled={searching || !query.trim()}>
                    <SearchIcon data-icon="inline-start" />
                    {searching ? i18n._("Searching…") : i18n._("Search")}
                  </Button>
                </form>
                {results ? (
                  <div className="flex flex-col gap-3" aria-live="polite">
                    {results.warning ? (
                      <Alert>
                        <AlertTitle>
                          <Trans>Search notice</Trans>
                        </AlertTitle>
                        <AlertDescription>{results.warning}</AlertDescription>
                      </Alert>
                    ) : null}
                    {!results.hits.length ? (
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>
                            <Trans>No matches</Trans>
                          </EmptyTitle>
                          <EmptyDescription>
                            <Trans>Try another phrase or refresh the source index.</Trans>
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      results.hits.map((hit) => (
                        <Card key={`${hit.sourceId}/${hit.path}`}>
                          <CardHeader>
                            <CardTitle>
                              <Link to={hit.citation}>{hit.title}</Link>
                            </CardTitle>
                            <CardDescription>
                              {hit.sourceName} · {hit.path}
                            </CardDescription>
                          </CardHeader>
                          <CardContent>
                            <MarkdownContent content={hit.excerpt} preserveLineBreaks={false} />
                          </CardContent>
                          <CardFooter>
                            <Button variant="outline" size="sm" asChild>
                              <Link to={hit.citation}>
                                <BookOpenIcon data-icon="inline-start" />
                                <Trans>Read source</Trans>
                              </Link>
                            </Button>
                          </CardFooter>
                        </Card>
                      ))
                    )}
                  </div>
                ) : null}
              </>
            )}
            {sourceId && path ? (
              <Card>
                <CardHeader>
                  <CardTitle>{doc.data?.title ?? i18n._("Source document")}</CardTitle>
                  <CardDescription>{path}</CardDescription>
                </CardHeader>
                <CardContent>
                  {doc.loading ? <ResourceLoading label={i18n._("Loading source")} /> : null}
                  {doc.error ? <ResourceError error={doc.error} onRetry={doc.refresh} /> : null}
                  {doc.data ? (
                    <MarkdownContent content={doc.data.content} preserveLineBreaks={false} />
                  ) : null}
                </CardContent>
                <CardFooter className="gap-2">
                  <Button
                    variant="outline"
                    onClick={() =>
                      updateParams({ source: undefined, path: undefined, line: undefined })
                    }
                  >
                    <Trans>Close source</Trans>
                  </Button>
                  {doc.data && fromLine + 100 <= doc.data.totalLines ? (
                    <Button
                      variant="outline"
                      onClick={() =>
                        updateParams({
                          source: sourceId ?? undefined,
                          path: path ?? undefined,
                          line: String(fromLine + 100),
                        })
                      }
                    >
                      <Trans>Next lines</Trans>
                    </Button>
                  ) : null}
                </CardFooter>
              </Card>
            ) : null}
            <section className="flex flex-col gap-3" aria-label={i18n._("Knowledge sources")}>
              <Dialog
                open={addSource}
                onOpenChange={(open) => {
                  if (!busy) setAddSource(open);
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold">
                    <Trans>Sources</Trans>
                  </h2>
                  {owner && data.settings.enabled ? (
                    <div className="flex items-center gap-2">
                      <DialogTrigger asChild>
                        <Button disabled={busy}>
                          <PlusIcon data-icon="inline-start" />
                          <Trans>Add source</Trans>
                        </Button>
                      </DialogTrigger>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy || working}
                            aria-label={i18n._("Index actions")}
                            title={i18n._("Index actions")}
                          >
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onSelect={() => void act(() => api.refreshKnowledge(agent.id))}
                            >
                              <RefreshCwIcon />
                              <Trans>Refresh index</Trans>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                void act(() =>
                                  api.refreshKnowledge(agent.id, true, agent.permissions.network),
                                )
                              }
                            >
                              <Trans>Build embeddings</Trans>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                void act(() =>
                                  api.refreshKnowledge(
                                    agent.id,
                                    true,
                                    agent.permissions.network,
                                    true,
                                  ),
                                )
                              }
                            >
                              <Trans>Prepare deep search</Trans>
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ) : null}
                </div>
                {addSource ? (
                  <SourceForm
                    busy={busy}
                    onCancel={() => setAddSource(false)}
                    onSave={(name, path, description) =>
                      void act(async () => {
                        await api.addKnowledgeSource(agent.id, {
                          name,
                          path,
                          description,
                        });
                        setAddSource(false);
                      })
                    }
                  />
                ) : null}
              </Dialog>
              {data.sources.length ? (
                <ul className="divide-y rounded-lg border">
                  {data.sources.map((source) => (
                    <li key={source.id} className="flex items-start gap-3 p-4">
                      <FolderIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-medium break-words">{source.name}</h3>
                        <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                          {source.path}
                        </p>
                        {source.description ? (
                          <p className="mt-2 text-sm break-words text-muted-foreground">
                            {source.description}
                          </p>
                        ) : null}
                      </div>
                      {owner ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={busy}
                              aria-label={i18n._("Source actions for {name}", {
                                name: source.name,
                              })}
                            >
                              <MoreHorizontalIcon />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuGroup>
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() =>
                                  void act(() => api.deleteKnowledgeSource(agent.id, source.id))
                                }
                              >
                                <UnplugIcon />
                                <Trans>Disconnect source</Trans>
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FolderIcon />
                    </EmptyMedia>
                    <EmptyTitle>
                      <Trans>No sources yet</Trans>
                    </EmptyTitle>
                    {owner && data.settings.enabled ? (
                      <EmptyDescription>
                        <Trans>
                          Add a Markdown directory from this agent's workspace or mounts.
                        </Trans>
                      </EmptyDescription>
                    ) : null}
                  </EmptyHeader>
                </Empty>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function SourceForm({
  busy,
  onCancel,
  onSave,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string, path: string, description: string) => void;
}) {
  const { i18n } = useLingui();
  const [name, setName] = useState(""),
    [path, setPath] = useState(""),
    [description, setDescription] = useState("");
  return (
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto" showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>
          <Trans>Add source</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>Add a Markdown directory from this agent's workspace or mounts.</Trans>
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(name, path, description);
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="source-name">
              <Trans>Name</Trans>
            </FieldLabel>
            <Input
              id="source-name"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="source-path">
              <Trans>Directory</Trans>
            </FieldLabel>
            <Input
              id="source-path"
              required
              maxLength={2000}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={i18n._("docs or /mounted-vault")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="source-description">
              <Trans>Description</Trans>
            </FieldLabel>
            <Textarea
              id="source-description"
              maxLength={1000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={i18n._("What is this collection useful for?")}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={busy}>
            <Trans>Add source</Trans>
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
