import { statusLabel } from "@/lib/labels";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BookOpenIcon, PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import type { AgentConfig, KnowledgeSearchResult, SavedMemory } from "@carmel-agent/shared";
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
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { confirmAction } from "@/lib/action-dialogs";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { useHarnessStore } from "@/store/harness-store";
import { PageHeader } from "./form-primitives";
import { ResourceError, ResourceLoading } from "./ResourceFeedback";

export function AgentKnowledgePage({ agent }: { agent: AgentConfig }) {
  const { i18n } = useLingui();
  const userId = useHarnessStore((s) => s.activeUserId);
  const users = useHarnessStore((s) => s.users);
  const owner = agent.ownerUserId === userId;
  const overview = useRemoteResource({
    key: `knowledge:${agent.id}`,
    load: (signal) => api.knowledge(agent.id, signal),
    pollInterval: 5000,
  });
  const [params, setParams] = useSearchParams();
  const sourceId = params.get("source"),
    path = params.get("path");
  const fromLine = Math.max(1, Number(params.get("line")) || 1);
  const doc = useRemoteResource({
    key: `knowledge-doc:${agent.id}:${sourceId}:${path}:${fromLine}`,
    enabled: Boolean(sourceId && path),
    load: (signal) =>
      api.readKnowledge(agent.id, { sourceId: sourceId!, path: path!, fromLine }, signal),
  });
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"fast" | "semantic" | "deep">("fast");
  const [results, setResults] = useState<KnowledgeSearchResult>();
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<SavedMemory | "new">();
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
                        "Enable knowledge in settings to register searchable sources and save memories.",
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
                      placeholder={i18n._("Find notes, decisions, or preferences…")}
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
                            <p className="whitespace-pre-wrap break-words text-sm">{hit.excerpt}</p>
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
                    <pre className="whitespace-pre-wrap break-words font-mono text-sm">
                      {doc.data.content
                        .split("\n")
                        .map((line, i) => `${doc.data!.fromLine + i}  ${line}`)
                        .join("\n")}
                    </pre>
                  ) : null}
                </CardContent>
                <CardFooter className="gap-2">
                  <Button variant="outline" onClick={() => setParams({})}>
                    <Trans>Close source</Trans>
                  </Button>
                  {doc.data && fromLine + 100 <= doc.data.totalLines ? (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setParams({
                          source: sourceId,
                          path,
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
            <section className="flex flex-col gap-3" aria-label={i18n._("Saved memories")}>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">
                  <Trans>Saved memories</Trans>
                </h2>
                {agent.permissions.write && data.settings.enabled ? (
                  <Button
                    variant="outline"
                    disabled={busy || Boolean(editor)}
                    onClick={() => setEditor("new")}
                  >
                    <PlusIcon data-icon="inline-start" />
                    <Trans>New memory</Trans>
                  </Button>
                ) : null}
              </div>
              {editor ? (
                <MemoryForm
                  key={editor === "new" ? "new" : editor.id}
                  memory={editor === "new" ? undefined : editor}
                  busy={busy}
                  onCancel={() => setEditor(undefined)}
                  onSave={(title, content) =>
                    void act(async () => {
                      await api.saveMemory(
                        agent.id,
                        {
                          title,
                          content,
                          expectedRevision: editor === "new" ? undefined : editor.revision,
                        },
                        editor === "new" ? undefined : editor.id,
                      );
                      setEditor(undefined);
                    })
                  }
                />
              ) : null}
              {!data.memories.length ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>
                      <Trans>No saved memories</Trans>
                    </EmptyTitle>
                    <EmptyDescription>
                      <Trans>Ask the agent to remember a fact or decision, or add one here.</Trans>
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                data.memories.map((memory) => (
                  <Card key={memory.id}>
                    <CardHeader>
                      <CardTitle>{memory.title}</CardTitle>
                      <CardDescription>
                        <Trans>
                          Saved by{" "}
                          {users.find((u) => u.id === memory.contributorId)?.name ??
                            "an agent user"}{" "}
                          · {new Date(memory.updatedAt).toLocaleString(i18n.locale)}
                        </Trans>
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="whitespace-pre-wrap break-words text-sm">{memory.content}</p>
                    </CardContent>
                    {agent.permissions.edit ? (
                      <CardFooter className="gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || Boolean(editor) || !data.settings.enabled}
                          onClick={() => setEditor(memory)}
                        >
                          <Trans>Edit memory</Trans>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={async () => {
                            if (
                              await confirmAction({
                                title: i18n._("Forget “{title}”?", { title: memory.title }),
                                description: i18n._(
                                  "This removes the saved memory for everyone using this agent. Source documents and conversations are kept.",
                                ),
                                actionLabel: i18n._("Forget memory"),
                              })
                            )
                              void act(() => api.forgetMemory(agent.id, memory));
                          }}
                        >
                          <Trans>Forget memory</Trans>
                        </Button>
                      </CardFooter>
                    ) : null}
                  </Card>
                ))
              )}
            </section>
            <section className="flex flex-col gap-3" aria-label={i18n._("Knowledge sources")}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">
                  <Trans>Sources</Trans>
                </h2>
                {owner && data.settings.enabled ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={busy || working}
                      onClick={() => void act(() => api.refreshKnowledge(agent.id))}
                    >
                      <RefreshCwIcon data-icon="inline-start" />
                      <Trans>Refresh index</Trans>
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || working}
                      onClick={() =>
                        void act(() =>
                          api.refreshKnowledge(agent.id, true, agent.permissions.network),
                        )
                      }
                    >
                      <Trans>Build embeddings</Trans>
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || working}
                      onClick={() =>
                        void act(() =>
                          api.refreshKnowledge(agent.id, true, agent.permissions.network, true),
                        )
                      }
                    >
                      <Trans>Prepare deep search</Trans>
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || addSource}
                      onClick={() => setAddSource(true)}
                    >
                      <PlusIcon data-icon="inline-start" />
                      <Trans>Add source</Trans>
                    </Button>
                  </div>
                ) : null}
              </div>
              {owner && data.settings.enabled ? (
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Markdown directories from this agent's workspace or mounts. Embeddings use the
                    configured model; missing models can download when the agent has network access.
                  </Trans>
                </p>
              ) : null}
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
              {data.sources.map((source) => (
                <Card key={source.id}>
                  <CardHeader>
                    <CardTitle>{source.name}</CardTitle>
                    <CardDescription className="break-all">{source.path}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {source.description || i18n._("Markdown documents")}
                    </p>
                  </CardContent>
                  {owner ? (
                    <CardFooter>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void act(() => api.deleteKnowledgeSource(agent.id, source.id))
                        }
                      >
                        <Trans>Disconnect source</Trans>
                      </Button>
                    </CardFooter>
                  ) : null}
                </Card>
              ))}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function MemoryForm({
  memory,
  busy,
  onCancel,
  onSave,
}: {
  memory?: SavedMemory;
  busy: boolean;
  onCancel: () => void;
  onSave: (title: string, content: string) => void;
}) {
  const { i18n } = useLingui();
  const [title, setTitle] = useState(memory?.title ?? ""),
    [content, setContent] = useState(memory?.content ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(title, content);
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>{memory ? i18n._("Edit memory") : i18n._("New memory")}</CardTitle>
          <CardDescription>
            <Trans>
              Keep facts specific and identify whose preferences or decisions they describe.
            </Trans>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="memory-title">
                <Trans>Title</Trans>
              </FieldLabel>
              <Input
                id="memory-title"
                required
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="memory-content">
                <Trans>Memory</Trans>
              </FieldLabel>
              <Textarea
                id="memory-content"
                required
                maxLength={20000}
                rows={5}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="gap-2">
          <Button type="submit" disabled={busy}>
            <Trans>Save memory</Trans>
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
        </CardFooter>
      </Card>
    </form>
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
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(name, path, description);
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <Trans>Add source</Trans>
          </CardTitle>
          <CardDescription>
            <Trans>The original files stay in their existing location.</Trans>
          </CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
        <CardFooter className="gap-2">
          <Button type="submit" disabled={busy}>
            <Trans>Add source</Trans>
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
