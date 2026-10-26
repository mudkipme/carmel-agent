import type { ComponentType, SVGProps } from "react";
import {
  BookOpenIcon,
  CodeXmlIcon,
  CompassIcon,
  HeartIcon,
  MoonStarIcon,
  OrbitIcon,
  PaletteIcon,
  RocketIcon,
  SparklesIcon,
  SproutIcon,
  SunIcon,
} from "lucide-react";
import type { AgentColor, AgentConfig, AgentIcon } from "@carmel-agent/shared";

function CarmelBotIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 5V3.5M2 12v4m20-4v4" />
      <circle cx="12" cy="2.5" r="1" fill="currentColor" stroke="none" />
      <rect x="4" y="6" width="16" height="15" rx="6" />
      <rect
        x="6.5"
        y="9"
        width="11"
        height="9"
        rx="3.5"
        fill="currentColor"
        fillOpacity=".12"
        stroke="none"
      />
      <path d="M8.5 12v1.5m7-1.5v1.5M9.5 16a3.5 3.5 0 0 0 5 0" />
    </svg>
  );
}

export const agentIconOptions = [
  { value: "bot", label: "Bot", icon: CarmelBotIcon },
  { value: "sparkles", label: "Sparkles", icon: SparklesIcon },
  { value: "orbit", label: "Orbit", icon: OrbitIcon },
  { value: "compass", label: "Compass", icon: CompassIcon },
  { value: "sprout", label: "Sprout", icon: SproutIcon },
  { value: "sun", label: "Sun", icon: SunIcon },
  { value: "moon", label: "Moon", icon: MoonStarIcon },
  { value: "rocket", label: "Rocket", icon: RocketIcon },
  { value: "book", label: "Book", icon: BookOpenIcon },
  { value: "code", label: "Code", icon: CodeXmlIcon },
  { value: "palette", label: "Palette", icon: PaletteIcon },
  { value: "heart", label: "Heart", icon: HeartIcon },
] satisfies Array<{
  value: AgentIcon;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}>;

export const agentColorOptions = [
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "orange", label: "Orange" },
  { value: "purple", label: "Violet" },
  { value: "cyan", label: "Teal" },
  { value: "pink", label: "Rose" },
] satisfies Array<{ value: AgentColor; label: string }>;

export function agentColor(agent?: Pick<AgentConfig, "id" | "color">): AgentColor {
  if (agent?.color) return agent.color;
  let hash = 0;
  for (const char of agent?.id ?? "") hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return agentColorOptions[hash % 5].value;
}
