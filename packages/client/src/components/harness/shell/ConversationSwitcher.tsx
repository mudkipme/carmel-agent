import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { HomeIcon, MessageSquarePlusIcon, MessagesSquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { SessionList } from "./SessionList";
import type { SessionMetadata } from "@carmel-agent/shared";

export function ConversationSwitcher({
  sessions,
  activeSessionId,
  runningSessionIds,
  runOverrides,
  onSelect,
}: {
  sessions: SessionMetadata[];
  activeSessionId?: string;
  runningSessionIds: Set<string>;
  runOverrides: Record<string, boolean>;
  onSelect: (session: SessionMetadata | "home" | "new") => void;
}) {
  const { i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const select = (session: SessionMetadata | "home" | "new") => {
    onSelect(session);
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" title={i18n._("Switch conversation")}>
          <MessagesSquareIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[80dvh] flex-col" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Switch conversation</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={() => select("home")}>
            <HomeIcon data-icon="inline-start" />
            <Trans>Home</Trans>
          </Button>
          <Button variant="outline" onClick={() => select("new")}>
            <MessageSquarePlusIcon data-icon="inline-start" />
            <Trans>New session</Trans>
          </Button>
        </div>
        <SessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          runningSessionIds={runningSessionIds}
          runOverrides={runOverrides}
          onSelectSession={select}
        />
      </DialogContent>
    </Dialog>
  );
}
