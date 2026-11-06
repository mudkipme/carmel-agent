import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { BrainIcon, PinIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import type { HomeMemory, HomeMemoryMode, HomeMemoryRevision } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { useHarnessStore } from "@/store/harness-store";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { confirmAction } from "@/lib/action-dialogs";
import { ResourceError, ResourceLoading } from "./ResourceFeedback";

export function HomeMemoryPanel({ agentId }: { agentId: string }) {
  const { i18n } = useLingui();
  const userId = useHarnessStore((state) => state.activeUserId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<HomeMemory | "new">();
  const [content, setContent] = useState("");
  const [scope, setScope] = useState("");
  const [kind, setKind] = useState<HomeMemory["kind"]>("fact");
  const [expiry, setExpiry] = useState("");
  const [history, setHistory] = useState<{ note: HomeMemory; rows: HomeMemoryRevision[] }>();
  const [mountedAt] = useState(() => Date.now());
  const notifiedAt = useRef(mountedAt);
  const { data: noticeData, refresh: refreshNotices } = useRemoteResource({
    key: `home-memory-notices:${userId}:${agentId}`,
    topics: ["homes"],
    load: (signal) => api.homeMemory(agentId, "", 0, signal),
  });
  const overview = useRemoteResource({
    key: `home-memory:${userId}:${agentId}:${query}:${offset}`,
    enabled: open,
    topics: ["homes"],
    load: (signal) => api.homeMemory(agentId, query, offset, signal),
  });
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      await Promise.all([overview.refresh(), refreshNotices()]);
    } catch (error) {
      showError(i18n._("Memory action failed"), error);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const data = noticeData;
    if (!data?.lastCaptureAt || data.lastCaptureAt <= notifiedAt.current) return;
    const notes = data.memories.filter(
      (note) => note.origin === "automatic" && note.updatedAt > notifiedAt.current,
    );
    notifiedAt.current = data.lastCaptureAt;
    if (!notes.length) return;
    const noticeId = `home-memory:${userId}:${agentId}:${data.lastCaptureAt}`;
    toast(
      i18n._("Remembered {count, plural, one {# detail} other {# details}}", {
        count: notes.length,
      }),
      {
        id: noticeId,
        action: { label: i18n._("Review"), onClick: () => setOpen(true) },
        cancel: {
          label: i18n._("Undo"),
          onClick: () => {
            void Promise.all(
              notes.map(async (note) => {
                if (note.revision === 1)
                  await api.forgetHomeMemory(agentId, note.id, note.revision);
                else {
                  const previous = (await api.homeMemoryHistory(agentId, note.id)).find(
                    (item) => item.revision === note.revision - 1,
                  );
                  if (previous)
                    await api.restoreHomeMemory(agentId, note.id, previous.revision, note.revision);
                }
              }),
            )
              .then(() => refreshNotices())
              .catch((error) => showError(i18n._("Memory action failed"), error));
          },
        },
      },
    );
  }, [noticeData, agentId, userId, i18n, refreshNotices]);
  const edit = (note: HomeMemory | "new") => {
    setEditor(note);
    setHistory(undefined);
    setContent(note === "new" ? "" : note.content);
    setScope(note === "new" ? "" : note.scope);
    setKind(note === "new" ? "fact" : note.kind);
    const date = note === "new" || !note.expiresAt ? null : new Date(note.expiresAt);
    setExpiry(
      date
        ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
        : "",
    );
  };
  const data = overview.data;
  useEffect(() => {
    if (data && history && !data.memories.some((note) => note.id === history.note.id))
      setHistory(undefined);
  }, [data, history]);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <BrainIcon data-icon="inline-start" />
        <Trans>Memory</Trans>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-0 right-0 left-auto flex h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col rounded-none sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              <Trans>Home memory</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>Private to you and this agent. New context keeps these notes.</Trans>
            </DialogDescription>
          </DialogHeader>
          {overview.error ? (
            <ResourceError error={overview.error} onRetry={overview.refresh} />
          ) : null}
          {overview.loading ? <ResourceLoading label={i18n._("Loading memory")} /> : null}
          {data ? (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
              <ToggleGroup
                className="w-full flex-wrap"
                type="single"
                variant="outline"
                value={data.mode}
                disabled={busy}
                aria-label={i18n._("Memory mode")}
                onValueChange={(mode) => {
                  if (mode) void act(() => api.setHomeMemoryMode(agentId, mode as HomeMemoryMode));
                }}
              >
                <ToggleGroupItem value="off">
                  <Trans>Off</Trans>
                </ToggleGroupItem>
                <ToggleGroupItem value="manual">
                  <Trans>Remember when asked</Trans>
                </ToggleGroupItem>
                <ToggleGroupItem value="automatic">
                  <Trans>Learn from Home</Trans>
                </ToggleGroupItem>
              </ToggleGroup>
              {data.mode === "automatic" ? (
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Learn useful details from future Home messages using your Home model. Background
                    model usage may incur charges.
                  </Trans>
                </p>
              ) : null}
              {data.error ? (
                <Alert>
                  <AlertDescription>{data.error}</AlertDescription>
                </Alert>
              ) : null}
              {editor ? (
                <form
                  className="flex flex-col gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(async () => {
                      const input = {
                        content,
                        scope,
                        kind,
                        expiresAt: expiry ? new Date(expiry).getTime() : null,
                      };
                      if (editor === "new") await api.saveHomeMemory(agentId, input);
                      else
                        await api.editHomeMemory(agentId, editor.id, {
                          ...input,
                          expectedRevision: editor.revision,
                        });
                      setEditor(undefined);
                    });
                  }}
                >
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="home-memory-content">
                        <Trans>Memory</Trans>
                      </FieldLabel>
                      <Textarea
                        id="home-memory-content"
                        value={content}
                        onChange={(event) => setContent(event.target.value)}
                        maxLength={2000}
                        required
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="home-memory-scope">
                        <Trans>Scope</Trans>
                      </FieldLabel>
                      <Input
                        id="home-memory-scope"
                        value={scope}
                        onChange={(event) => setScope(event.target.value)}
                        maxLength={120}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>
                        <Trans>Kind</Trans>
                      </FieldLabel>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        value={kind}
                        onValueChange={(value) => {
                          if (value) setKind(value as HomeMemory["kind"]);
                        }}
                      >
                        <ToggleGroupItem value="fact">
                          <Trans>Fact</Trans>
                        </ToggleGroupItem>
                        <ToggleGroupItem value="preference">
                          <Trans>Preference</Trans>
                        </ToggleGroupItem>
                        <ToggleGroupItem value="decision">
                          <Trans>Decision</Trans>
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="home-memory-expiry">
                        <Trans>Expires</Trans>
                      </FieldLabel>
                      <Input
                        id="home-memory-expiry"
                        type="datetime-local"
                        value={expiry}
                        onChange={(event) => setExpiry(event.target.value)}
                      />
                    </Field>
                  </FieldGroup>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={() => setEditor(undefined)}>
                      <Trans>Cancel</Trans>
                    </Button>
                    <Button type="submit" disabled={busy || !content.trim()}>
                      <Trans>Save memory</Trans>
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="flex gap-2">
                    <Input
                      aria-label={i18n._("Search memory")}
                      placeholder={i18n._("Search memory")}
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setOffset(0);
                      }}
                    />
                    <Button variant="outline" onClick={() => edit("new")}>
                      <PlusIcon data-icon="inline-start" />
                      <Trans>Add</Trans>
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {i18n._("Pinned context: {used} / {budget} tokens", {
                      used: data.pinnedTokens,
                      budget: data.pinBudget,
                    })}
                  </p>
                  {!data.memories.length ? (
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>
                          <Trans>No memories</Trans>
                        </EmptyTitle>
                      </EmptyHeader>
                    </Empty>
                  ) : null}
                  {data.memories.map((note) => (
                    <Card key={note.id}>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          {note.scope || i18n._("General")}
                          {note.pinned ? (
                            <PinIcon aria-label={i18n._("Pinned")} className="size-4" />
                          ) : null}
                          {note.origin === "automatic" ? (
                            <Badge variant="secondary">
                              <Trans>Learned</Trans>
                            </Badge>
                          ) : null}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-2">
                        <p className="whitespace-pre-wrap">{note.content}</p>
                        {note.expiresAt ? (
                          <p className="text-sm text-muted-foreground">
                            {i18n._("Expires {date}", {
                              date: new Date(note.expiresAt).toLocaleString(i18n.locale),
                            })}
                          </p>
                        ) : null}
                        {note.sourceQuote ? (
                          <details>
                            <summary className="cursor-pointer text-sm text-muted-foreground">
                              <Trans>Source</Trans>
                            </summary>
                            <blockquote className="mt-2 border-l-2 pl-3 text-sm">
                              {note.sourceQuote}
                            </blockquote>
                            {note.sourceEntryId ? (
                              <Link
                                className="text-sm underline"
                                to={`/agents/${agentId}/home?entry=${encodeURIComponent(note.sourceEntryId)}`}
                                onClick={() => setOpen(false)}
                              >
                                <Trans>Open message</Trans>
                              </Link>
                            ) : null}
                          </details>
                        ) : null}
                      </CardContent>
                      <CardFooter className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              api.editHomeMemory(agentId, note.id, {
                                expectedRevision: note.revision,
                                pinned: !note.pinned,
                              }),
                            )
                          }
                        >
                          {note.pinned ? <Trans>Unpin</Trans> : <Trans>Pin</Trans>}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => edit(note)}
                        >
                          <Trans>Edit</Trans>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              setHistory({
                                note,
                                rows: await api.homeMemoryHistory(agentId, note.id),
                              });
                            })
                          }
                        >
                          <Trans>History</Trans>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void act(() => api.forgetHomeMemory(agentId, note.id, note.revision))
                          }
                        >
                          <Trans>Forget</Trans>
                        </Button>
                      </CardFooter>
                    </Card>
                  ))}
                  <div className="flex justify-between gap-2">
                    <Button
                      variant="ghost"
                      disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - 50))}
                    >
                      <Trans>Previous</Trans>
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={offset + 50 >= data.total}
                      onClick={() => setOffset(offset + 50)}
                    >
                      <Trans>Next</Trans>
                    </Button>
                  </div>
                  {history ? (
                    <section className="flex flex-col gap-3" aria-label={i18n._("Memory history")}>
                      <h3 className="font-medium">
                        <Trans>History</Trans>
                      </h3>
                      {history.rows.map((row) => (
                        <div className="flex items-start justify-between gap-3" key={row.revision}>
                          <p className="whitespace-pre-wrap text-sm">{row.content}</p>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || row.revision === history.note.revision}
                            onClick={() =>
                              void act(async () => {
                                await api.restoreHomeMemory(
                                  agentId,
                                  history.note.id,
                                  row.revision,
                                  history.note.revision,
                                );
                                setHistory(undefined);
                              })
                            }
                          >
                            <Trans>Restore</Trans>
                          </Button>
                        </div>
                      ))}
                    </section>
                  ) : null}
                  <Button
                    variant="ghost"
                    disabled={busy || !data.total}
                    onClick={async () => {
                      if (
                        await confirmAction({
                          title: i18n._("Forget all Home memory?"),
                          description: i18n._(
                            "Notes and their revision history will be deleted. Your Home conversation stays.",
                          ),
                          actionLabel: i18n._("Forget all"),
                        })
                      )
                        void act(() => api.clearHomeMemory(agentId));
                    }}
                  >
                    <Trans>Forget all memory</Trans>
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
