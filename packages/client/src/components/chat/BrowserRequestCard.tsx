import { useLingui } from "@lingui/react";
import { i18n } from "@lingui/core";
import type { BrowserControlState } from "@carmel-agent/shared";
import { GlobeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentRequestCard } from "./AgentRequestCard";

export function BrowserRequestCard({
  control,
  hasControl,
  actionLabel = i18n._("Open browser"),
  disabled,
  onAction,
}: {
  control: BrowserControlState;
  hasControl?: boolean;
  actionLabel?: string;
  disabled?: boolean;
  onAction: () => void;
}) {
  useLingui();
  return (
    <AgentRequestCard
      label={i18n._("Browser assistance")}
      kind="browser"
      icon={<GlobeIcon aria-hidden="true" />}
      title={i18n._("Browser assistance")}
      status={
        hasControl
          ? i18n._("You have control")
          : control.phase === "pausing"
            ? i18n._("Pausing agent…")
            : control.phase === "human"
              ? i18n._("Browser in use")
              : i18n._("Waiting for you")
      }
      description={control.reason ?? i18n._("The agent needs your help in the browser.")}
      actions={
        <Button size="sm" disabled={disabled} onClick={onAction}>
          {actionLabel}
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        {hasControl
          ? i18n._(
              "Complete the action, then select Resume agent. Your browser input is not added to chat.",
            )
          : control.phase === "pausing"
            ? i18n._("Waiting for the current tool call to finish before handing over control.")
            : control.controllerName
              ? i18n._(
                  "{controllerName} is helping. Automation stays paused until they resume the agent.",
                  { controllerName: control.controllerName },
                )
              : i18n._("Take control to complete the action, then resume the agent.")}
      </p>
    </AgentRequestCard>
  );
}
