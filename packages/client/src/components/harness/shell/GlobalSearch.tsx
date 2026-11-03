import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentConfig } from "@carmel-agent/shared";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { api } from "@/lib/api";
import { ResourceError } from "../ResourceFeedback";

export function GlobalSearch({
  open,
  onOpenChange,
  agents,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: AgentConfig[];
  onNavigate: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-2xl" aria-describedby={undefined}>
        <DialogTitle className="sr-only">
          <Trans>Search</Trans>
        </DialogTitle>
        {open ? (
          <SearchResults
            agents={agents}
            onSelect={() => {
              onOpenChange(false);
              onNavigate();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SearchResults({ agents, onSelect }: { agents: AgentConfig[]; onSelect: () => void }) {
  const { i18n } = useLingui();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [query]);
  const search = useRemoteResource({
    key: `session-search:${debouncedQuery}`,
    enabled: Boolean(debouncedQuery),
    load: (signal) => api.searchSessions(debouncedQuery, signal),
  });
  const loading = Boolean(query.trim()) && (query.trim() !== debouncedQuery || search.loading);
  const results = !loading && query.trim() ? (search.data ?? []) : [];

  return (
    <Command shouldFilter={false}>
      <CommandInput
        aria-label={i18n._("Search titles and messages")}
        placeholder={i18n._("Search titles and messages")}
        value={query}
        maxLength={500}
        onValueChange={setQuery}
        className="pr-10"
      />
      <CommandList className="max-h-[60dvh]" aria-busy={loading}>
        {loading ? (
          <div role="status" className="p-6 text-center text-sm text-muted-foreground">
            <Trans>Searching…</Trans>
          </div>
        ) : search.error && query.trim() ? (
          <div className="p-3">
            <ResourceError
              error={search.error}
              onRetry={search.refresh}
              title={i18n._("Unable to search")}
            />
          </div>
        ) : (
          <>
            <CommandEmpty>
              {query.trim() ? i18n._("No sessions found.") : i18n._("Search titles and messages")}
            </CommandEmpty>
            {agents.map((agent) => {
              const matches = results.filter((result) => result.agentId === agent.id);
              if (!matches.length) return null;
              return (
                <CommandGroup key={agent.id} heading={agent.name}>
                  {matches.map((result) => (
                    <CommandItem
                      key={result.link}
                      value={result.link}
                      onSelect={() => {
                        onSelect();
                        navigate(result.link);
                      }}
                    >
                      <div className="flex min-w-0 flex-col gap-1 py-1">
                        <span className="truncate">{result.title}</span>
                        {result.excerpt ? (
                          <span className="whitespace-normal break-words text-xs text-muted-foreground">
                            <SearchExcerpt text={result.excerpt} query={debouncedQuery} />
                          </span>
                        ) : null}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </>
        )}
      </CommandList>
    </Command>
  );
}

function SearchExcerpt({ text, query }: { text: string; query: string }) {
  const start = text.toLowerCase().indexOf(query.toLowerCase());
  if (start < 0) return text;
  const end = start + query.length;
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-transparent font-semibold text-inherit">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}
