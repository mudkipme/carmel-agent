import { BookOpenTextIcon, CommandIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { api } from "@/lib/api";
import type { AgentCommandPayload, AgentConfig } from "@carmel-agent/shared";

type AgentCommandPaletteProps = {
  agent: AgentConfig;
  onInsert: (text: string) => void;
  className?: string;
};

export function AgentCommandPalette({ agent, onInsert, className }: AgentCommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<AgentCommandPayload>({
    promptTemplates: [],
    skills: [],
  });
  const [loading, setLoading] = useState(false);
  const requestSeq = useRef(0);

  const loadCommands = useCallback(() => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setLoading(true);
    void api
      .getAgentCommands(agent.id)
      .then((commands) => {
        if (requestSeq.current === seq) setPayload(commands);
      })
      .finally(() => {
        if (requestSeq.current === seq) setLoading(false);
      });
  }, [agent.id]);

  const setPaletteOpen = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) loadCommands();
    },
    [loadCommands],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) {
          setOpen(false);
        } else {
          setPaletteOpen(true);
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, setPaletteOpen]);

  const hasCommands = payload.promptTemplates.length > 0 || payload.skills.length > 0;
  const skillPrompts = useMemo(
    () =>
      payload.skills.map((skill) => ({
        ...skill,
        prompt: `Use the ${skill.name} skill for this task.\n\n`,
      })),
    [payload.skills],
  );

  const insert = (text: string) => {
    onInsert(text);
    setOpen(false);
  };

  return (
    <>
      <Button className={className} variant="outline" size="sm" onClick={() => setPaletteOpen(true)}>
        <CommandIcon data-icon="inline-start" />
        Commands
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setPaletteOpen}
        title="Command Palette"
        description="Insert a prompt template or skill instruction."
      >
        <CommandInput placeholder="Search templates and skills..." />
        <CommandList>
          <CommandEmpty>{loading ? "Loading..." : "No commands found."}</CommandEmpty>
          {payload.promptTemplates.length > 0 ? (
            <CommandGroup heading="Prompt Templates">
              {payload.promptTemplates.map((template) => (
                <CommandItem
                  key={template.id}
                  value={`template ${template.name} ${template.body}`}
                  onSelect={() => insert(template.body)}
                >
                  <BookOpenTextIcon />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{template.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{template.body}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {payload.promptTemplates.length > 0 && payload.skills.length > 0 ? <CommandSeparator /> : null}
          {payload.skills.length > 0 ? (
            <CommandGroup heading="Skills">
              {skillPrompts.map((skill) => (
                <CommandItem
                  key={skill.filePath}
                  value={`skill ${skill.name} ${skill.description}`}
                  onSelect={() => insert(skill.prompt)}
                >
                  <SparklesIcon />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{skill.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{skill.description}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {!loading && !hasCommands ? (
            <CommandGroup heading="Commands">
              <CommandItem disabled>No prompt templates or skills configured.</CommandItem>
            </CommandGroup>
          ) : null}
        </CommandList>
      </CommandDialog>
    </>
  );
}
