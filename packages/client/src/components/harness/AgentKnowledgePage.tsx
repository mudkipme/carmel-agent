import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BookOpenIcon, PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import type {
  AgentConfig,
  KnowledgeSettings,
  KnowledgeSearchResult,
  SavedMemory,
} from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Field, FieldLabel, FieldDescription, FieldGroup } from "@/components/ui/field";
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
import { ResourceError, ResourceLoading } from "./ResourceFeedback";

export function AgentKnowledgePage({ agent }: { agent: AgentConfig }) {
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
  const [settings, setSettings] = useState(false);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      await overview.refresh();
    } catch (error) {
      showError("Knowledge action failed", error);
    } finally {
      setBusy(false);
    }
  };
  const data = overview.data;
  const working = data && ["updating", "embedding"].includes(data.status.state);
  return (
    <div className="h-full min-w-0 overflow-y-auto px-4 py-6 sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-1 text-sm text-muted-foreground">{agent.name}</p>
            <h1 className="text-2xl font-semibold">Knowledge</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Sources and saved memories shared with everyone who can use this agent.
            </p>
          </div>
          {owner && data ? (
            <Button variant="outline" onClick={() => setSettings(!settings)}>
              Knowledge settings
            </Button>
          ) : null}
        </div>
        {overview.error ? (
          <ResourceError error={overview.error} onRetry={overview.refresh} />
        ) : null}
        {overview.loading ? <ResourceLoading label="Loading knowledge" /> : null}
        {data ? (
          <>
            {settings ? (
              <KnowledgeSettingsForm
                initial={data.settings}
                embeddingModel={data.embeddingModel}
                busy={busy}
                onSave={(value) =>
                  void act(async () => {
                    await api.saveKnowledgeSettings(agent.id, value);
                    setSettings(false);
                  })
                }
              />
            ) : null}
            {!data.settings.enabled ? (
              <Alert>
                <AlertTitle>Knowledge is off</AlertTitle>
                <AlertDescription>
                  {owner
                    ? "Enable knowledge in settings to register searchable sources and save memories."
                    : "The agent owner can enable knowledge in settings."}
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div
                  className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"
                  role="status"
                >
                  <Badge variant={data.status.state === "error" ? "destructive" : "secondary"}>
                    {data.status.state}
                  </Badge>
                  <span>{data.status.documents} documents</span>
                  {data.status.needsEmbedding > 0 ? (
                    <span>{data.status.needsEmbedding} awaiting embeddings</span>
                  ) : null}
                  {data.status.backend ? (
                    <span>
                      {data.status.backend}
                      {data.status.devices.length ? ` · ${data.status.devices.join(", ")}` : ""}
                    </span>
                  ) : null}
                  {data.status.lastUpdatedAt ? (
                    <span>Updated {new Date(data.status.lastUpdatedAt).toLocaleString()}</span>
                  ) : null}
                </div>
                {data.status.error ? (
                  <Alert variant="destructive">
                    <AlertTitle>Index needs attention</AlertTitle>
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
                      showError("Search failed", error);
                    } finally {
                      setSearching(false);
                    }
                  }}
                >
                  <Field className="min-w-40 flex-1">
                    <FieldLabel htmlFor="knowledge-query">Search knowledge</FieldLabel>
                    <Input
                      id="knowledge-query"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Find notes, decisions, or preferences…"
                      required
                      maxLength={2000}
                    />
                  </Field>
                  <Field className="w-36">
                    <FieldLabel htmlFor="knowledge-mode">Search mode</FieldLabel>
                    <Select value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
                      <SelectTrigger id="knowledge-mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="fast">Fast</SelectItem>
                          <SelectItem value="semantic">Semantic</SelectItem>
                          <SelectItem value="deep">Deep</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Button type="submit" disabled={searching || !query.trim()}>
                    <SearchIcon data-icon="inline-start" />
                    {searching ? "Searching…" : "Search"}
                  </Button>
                </form>
                {results ? (
                  <div className="flex flex-col gap-3" aria-live="polite">
                    {results.warning ? (
                      <Alert>
                        <AlertTitle>Search notice</AlertTitle>
                        <AlertDescription>{results.warning}</AlertDescription>
                      </Alert>
                    ) : null}
                    {!results.hits.length ? (
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>No matches</EmptyTitle>
                          <EmptyDescription>
                            Try another phrase or refresh the source index.
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
                                Read source
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
                  <CardTitle>{doc.data?.title ?? "Source document"}</CardTitle>
                  <CardDescription>{path}</CardDescription>
                </CardHeader>
                <CardContent>
                  {doc.loading ? <ResourceLoading label="Loading source" /> : null}
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
                    Close source
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
                      Next lines
                    </Button>
                  ) : null}
                </CardFooter>
              </Card>
            ) : null}
            <section className="flex flex-col gap-3" aria-label="Saved memories">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Saved memories</h2>
                {agent.permissions.write && data.settings.enabled ? (
                  <Button
                    variant="outline"
                    disabled={busy || Boolean(editor)}
                    onClick={() => setEditor("new")}
                  >
                    <PlusIcon data-icon="inline-start" />
                    New memory
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
                    <EmptyTitle>No saved memories</EmptyTitle>
                    <EmptyDescription>
                      Ask the agent to remember a fact or decision, or add one here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                data.memories.map((memory) => (
                  <Card key={memory.id}>
                    <CardHeader>
                      <CardTitle>{memory.title}</CardTitle>
                      <CardDescription>
                        Saved by{" "}
                        {users.find((u) => u.id === memory.contributorId)?.name ?? "an agent user"}{" "}
                        · {new Date(memory.updatedAt).toLocaleString()}
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
                          Edit memory
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={async () => {
                            if (
                              await confirmAction({
                                title: `Forget “${memory.title}”?`,
                                description:
                                  "This removes the saved memory for everyone using this agent. Source documents and conversations are kept.",
                                actionLabel: "Forget memory",
                              })
                            )
                              void act(() => api.forgetMemory(agent.id, memory));
                          }}
                        >
                          Forget memory
                        </Button>
                      </CardFooter>
                    ) : null}
                  </Card>
                ))
              )}
            </section>
            <section className="flex flex-col gap-3" aria-label="Knowledge sources">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Sources</h2>
                {owner && data.settings.enabled ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={busy || working}
                      onClick={() => void act(() => api.refreshKnowledge(agent.id))}
                    >
                      <RefreshCwIcon data-icon="inline-start" />
                      Refresh index
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
                      Build embeddings
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
                      Prepare deep search
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || addSource}
                      onClick={() => setAddSource(true)}
                    >
                      <PlusIcon data-icon="inline-start" />
                      Add source
                    </Button>
                  </div>
                ) : null}
              </div>
              {owner && data.settings.enabled ? (
                <p className="text-sm text-muted-foreground">
                  Markdown directories from this agent's workspace or mounts. Embeddings use the
                  configured model; missing models can download when the agent has network access.
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
                      {source.description || "Markdown documents"}
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
                        Disconnect source
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

function KnowledgeSettingsForm({
  initial,
  embeddingModel,
  busy,
  onSave,
}: {
  initial: KnowledgeSettings;
  embeddingModel: string;
  busy: boolean;
  onSave: (value: KnowledgeSettings) => void;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [acceleration, setAcceleration] = useState(initial.acceleration);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ enabled, acceleration });
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Knowledge settings</CardTitle>
          <CardDescription>
            Memory is shared by all users of this agent. Conversations remain separate.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="knowledge-enabled">Knowledge and memory</FieldLabel>
              <Select
                value={enabled ? "on" : "off"}
                onValueChange={(value) => setEnabled(value === "on")}
              >
                <SelectTrigger id="knowledge-enabled">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="on">On</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Agents save memories only when asked. Existing memories are retained when switched
                off.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="knowledge-acceleration">Acceleration</FieldLabel>
              <Select
                value={acceleration}
                onValueChange={(value) => setAcceleration(value as typeof acceleration)}
              >
                <SelectTrigger id="knowledge-acceleration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {["auto", "cpu", "vulkan", "cuda"].map((value) => (
                      <SelectItem key={value} value={value}>
                        {value === "auto" ? "Automatic" : value.toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Uses GPUs exposed to the runner. Vulkan works with compatible NVIDIA and AMD
                drivers.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="knowledge-model">Embedding model</FieldLabel>
              <Input id="knowledge-model" value={embeddingModel} readOnly />
              <FieldDescription>
                Shared by all agents. The server administrator configures this model.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button disabled={busy} type="submit">
            Save settings
          </Button>
        </CardFooter>
      </Card>
    </form>
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
          <CardTitle>{memory ? "Edit memory" : "New memory"}</CardTitle>
          <CardDescription>
            Keep facts specific and identify whose preferences or decisions they describe.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="memory-title">Title</FieldLabel>
              <Input
                id="memory-title"
                required
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="memory-content">Memory</FieldLabel>
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
            Save memory
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
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
          <CardTitle>Add source</CardTitle>
          <CardDescription>The original files stay in their existing location.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="source-name">Name</FieldLabel>
              <Input
                id="source-name"
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="source-path">Directory</FieldLabel>
              <Input
                id="source-path"
                required
                maxLength={2000}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="docs or /mounted-vault"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="source-description">Description</FieldLabel>
              <Textarea
                id="source-description"
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this collection useful for?"
              />
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="gap-2">
          <Button type="submit" disabled={busy}>
            Add source
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
