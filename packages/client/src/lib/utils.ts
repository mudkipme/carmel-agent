import { i18n } from "@lingui/core";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(value: number) {
  const seconds = Math.max(1, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return i18n._("{count}s", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return i18n._("{count}m", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n._("{count}h", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return i18n._("{count}d", { count: days });
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return i18n._("{count}w", { count: weeks });
  return i18n._("{count}y", { count: Math.floor(weeks / 52) });
}
