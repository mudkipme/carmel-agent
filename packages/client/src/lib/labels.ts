import { i18n } from "@lingui/core";
import type { AgentThinkingLevel, Issue } from "@carmel-agent/shared";

export function thinkingLevelLabel(level: AgentThinkingLevel) {
  return {
    off: i18n._("Off"),
    minimal: i18n._("Minimal"),
    low: i18n._("Low"),
    medium: i18n._("Medium"),
    high: i18n._("High"),
    xhigh: i18n._("X-High"),
    max: i18n._("Max"),
  }[level];
}

export function priorityLabel(priority: Issue["priority"]) {
  return {
    low: i18n._("Low"),
    normal: i18n._("Normal"),
    high: i18n._("High"),
    urgent: i18n._("Urgent"),
  }[priority];
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    connecting: i18n._("Connecting"),
    connected: i18n._("Connected"),
    disabled: i18n._("Disabled"),
    error: i18n._("Error"),
    pending: i18n._("Pending"),
    sending: i18n._("Sending"),
    sent: i18n._("Sent"),
    failed: i18n._("Failed"),
    cancelled: i18n._("Cancelled"),
    uncertain: i18n._("Uncertain"),
    idle: i18n._("Idle"),
    updating: i18n._("Updating"),
    embedding: i18n._("Building embeddings"),
    ready: i18n._("Ready"),
    answered: i18n._("Answered"),
    expired: i18n._("Expired"),
  };
  return labels[status] ?? status;
}

export function platformLabel(platform: string): string {
  return { telegram: "Telegram", feishu: i18n._("Feishu"), lark: "Lark" }[platform] ?? platform;
}
