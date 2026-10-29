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
import { CarmelBotIcon } from "@/components/CarmelBotIcon";

export const agentIconOptions = [
  { value: "bot", label: /*i18n*/ "Bot", icon: CarmelBotIcon },
  { value: "sparkles", label: /*i18n*/ "Sparkles", icon: SparklesIcon },
  { value: "orbit", label: /*i18n*/ "Orbit", icon: OrbitIcon },
  { value: "compass", label: /*i18n*/ "Compass", icon: CompassIcon },
  { value: "sprout", label: /*i18n*/ "Sprout", icon: SproutIcon },
  { value: "sun", label: /*i18n*/ "Sun", icon: SunIcon },
  { value: "moon", label: /*i18n*/ "Moon", icon: MoonStarIcon },
  { value: "rocket", label: /*i18n*/ "Rocket", icon: RocketIcon },
  { value: "book", label: /*i18n*/ "Book", icon: BookOpenIcon },
  { value: "code", label: /*i18n*/ "Code", icon: CodeXmlIcon },
  { value: "palette", label: /*i18n*/ "Palette", icon: PaletteIcon },
  { value: "heart", label: /*i18n*/ "Heart", icon: HeartIcon },
] satisfies Array<{
  value: AgentIcon;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}>;

export const agentColorOptions = [
  { value: "blue", label: /*i18n*/ "Blue" },
  { value: "green", label: /*i18n*/ "Green" },
  { value: "orange", label: /*i18n*/ "Orange" },
  { value: "purple", label: /*i18n*/ "Violet" },
  { value: "cyan", label: /*i18n*/ "Teal" },
  { value: "pink", label: /*i18n*/ "Rose" },
] satisfies Array<{ value: AgentColor; label: string }>;

export function agentColor(agent?: Pick<AgentConfig, "id" | "color">): AgentColor {
  if (agent?.color) return agent.color;
  let hash = 0;
  for (const char of agent?.id ?? "") hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return agentColorOptions[hash % 5].value;
}
