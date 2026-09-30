import { cn } from "@/lib/utils";

/* Agents are the app's primary scope, so they get a stable visual identity that
   survives a rename: the colour is derived from the immutable id, the initials
   from the current name. */
const AGENT_ACCENTS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

function agentAccent(agentId: string) {
  let hash = 0;
  for (let index = 0; index < agentId.length; index += 1) hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
  return AGENT_ACCENTS[hash % AGENT_ACCENTS.length];
}

function agentInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const initials = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[words.length - 1][0]}`;
  return initials.toUpperCase();
}

export function AgentAvatar({
  agent,
  className,
}: {
  agent?: { id: string; name: string };
  className?: string;
}) {
  const accent = agent ? agentAccent(agent.id) : "var(--tx3)";

  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-md text-[9px] font-semibold tracking-tight tabular-nums",
        className,
      )}
      style={{ backgroundColor: `color-mix(in oklab, ${accent} 20%, transparent)`, color: "var(--foreground)" }}
    >
      {agent ? agentInitials(agent.name) : "—"}
    </span>
  );
}
