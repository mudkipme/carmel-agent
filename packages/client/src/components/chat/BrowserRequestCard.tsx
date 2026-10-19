import type { BrowserControlState } from "@carmel-agent/shared";
import { GlobeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentRequestCard } from "./AgentRequestCard";

export function BrowserRequestCard({
  control,
  hasControl,
  actionLabel = "Open browser",
  disabled,
  onAction,
}: {
  control: BrowserControlState;
  hasControl?: boolean;
  actionLabel?: string;
  disabled?: boolean;
  onAction: () => void;
}) {
  return (
    <AgentRequestCard
      label="Browser assistance"
      kind="browser"
      icon={<GlobeIcon aria-hidden="true" />}
      title="Browser assistance"
      status={
        hasControl
          ? "You have control"
          : control.phase === "pausing"
            ? "Pausing agent…"
            : control.phase === "human"
              ? "Browser in use"
              : "Waiting for you"
      }
      description={control.reason ?? "The agent needs your help in the browser."}
      actions={
        <Button size="sm" disabled={disabled} onClick={onAction}>
          {actionLabel}
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        {hasControl
          ? "Complete the action, then select Resume agent. Your browser input is not added to chat."
          : control.phase === "pausing"
            ? "Waiting for the current tool call to finish before handing over control."
            : control.controllerName
              ? `${control.controllerName} is helping. Automation stays paused until they resume the agent.`
              : "Take control to complete the action, then resume the agent."}
      </p>
    </AgentRequestCard>
  );
}
