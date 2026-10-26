import type { AgentConfig } from "@carmel-agent/shared";
import { agentColor, agentIconOptions } from "@/lib/agent-appearance";
import { cn } from "@/lib/utils";

export function AgentAvatar({
  agent,
  className,
}: {
  agent?: Pick<AgentConfig, "id" | "icon" | "color">;
  className?: string;
}) {
  const color = agentColor(agent);
  const { icon: Icon, value: icon } =
    agentIconOptions.find((option) => option.value === agent?.icon) ?? agentIconOptions[0];
  const accent = `var(--color-${color})`;
  return (
    <span
      aria-hidden
      data-agent-icon={icon}
      data-agent-color={color}
      className={cn("flex size-5 shrink-0 items-center justify-center rounded-md", className)}
      style={{
        backgroundColor: `color-mix(in oklab, ${accent} 16%, transparent)`,
        color: accent,
      }}
    >
      <Icon className="size-[70%]" />
    </span>
  );
}
