import { CommandIcon, FileTextIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
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
import type {
  AgentCommandPayload,
  AgentConfig,
  AgentSlashCommand,
  AgentSlashCommandSource,
} from "@carmel-agent/shared";

type AgentCommandPaletteProps = {
  agent: AgentConfig;
  onInsert: (text: string) => void;
  className?: string;
};

export function AgentCommandPalette({ agent, onInsert, className }: AgentCommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<AgentCommandPayload>({
    commands: [],
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
      if (isSlashCommandTrigger(event)) {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }

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

  const groupedCommands = groupCommands(payload.commands);
  const hasCommands = payload.commands.length > 0;

  const insertCommand = (command: AgentSlashCommand) => {
    onInsert(command.commandText);
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
        description="Insert a prompt template or skill command."
      >
        <CommandInput placeholder="Search templates and skills..." />
        <CommandList>
          <CommandEmpty>{loading ? "Loading..." : "No commands found."}</CommandEmpty>
          <CommandSection
            heading="Prompt Commands"
            commands={groupedCommands.prompt}
            icon={FileTextIcon}
            onSelect={insertCommand}
          />
          {groupedCommands.prompt.length > 0 && groupedCommands.skill.length > 0 ? <CommandSeparator /> : null}
          <CommandSection
            heading="Skill Commands"
            commands={groupedCommands.skill}
            icon={SparklesIcon}
            onSelect={insertCommand}
          />
          {!loading && !hasCommands ? (
            <CommandGroup heading="Commands">
              <CommandItem disabled>No slash commands are available for this agent.</CommandItem>
            </CommandGroup>
          ) : null}
        </CommandList>
      </CommandDialog>
    </>
  );
}

type CommandSectionProps = {
  heading: string;
  commands: AgentSlashCommand[];
  icon: ComponentType;
  onSelect: (command: AgentSlashCommand) => void;
};

function CommandSection({ heading, commands, icon: Icon, onSelect }: CommandSectionProps) {
  if (commands.length === 0) return null;

  return (
    <CommandGroup heading={heading}>
      {commands.map((command) => (
        <CommandItem
          key={`${command.source}:${command.name}:${command.sourcePath ?? ""}`}
          value={`${command.source} ${command.name} ${command.description ?? ""} ${command.argumentHint ?? ""}`}
          onSelect={() => onSelect(command)}
        >
          <Icon />
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{command.commandText.startsWith("/") ? `/${command.name}` : command.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {command.description || command.argumentHint || command.sourcePath || command.commandText}
            </span>
          </div>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function groupCommands(commands: AgentSlashCommand[]) {
  const grouped: Record<AgentSlashCommandSource, AgentSlashCommand[]> = {
    prompt: [],
    skill: [],
  };
  for (const command of commands) grouped[command.source].push(command);
  return grouped;
}

function isSlashCommandTrigger(event: KeyboardEvent) {
  if (event.defaultPrevented || event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (!(event.target instanceof HTMLTextAreaElement)) return false;
  if (!event.target.closest(".agent-chat-host")) return false;
  return event.target.value.length === 0 && event.target.selectionStart === 0 && event.target.selectionEnd === 0;
}
