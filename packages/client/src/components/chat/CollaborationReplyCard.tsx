import { useState } from "react";
import { useLingui } from "@lingui/react";
import { ChevronDownIcon, ChevronUpIcon, ArrowUpRightIcon } from "lucide-react";
import { Link } from "react-router-dom";
import type { CollaborationReply } from "@carmel-agent/shared";
import { useHarnessStore } from "@/store/harness-store";
import { AgentAvatar } from "@/components/harness/shell/AgentAvatar";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
  CardAction,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "./MarkdownContent";
import { cn } from "@/lib/utils";

export function CollaborationReplyCard({ reply }: { reply: CollaborationReply }) {
  const { i18n } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const agent = useHarnessStore((state) =>
    state.agents.find((agent) => agent.id === reply.agentId),
  );
  const name = agent?.name ?? reply.agentName ?? i18n._("Agent");
  const long = reply.answer.length > 400 || reply.answer.split("\n").length > 4;
  const link = reply.taskId
    ? `/agents/${reply.agentId}/tasks/${reply.taskId}?from=home`
    : reply.sessionId
      ? `/agents/${reply.agentId}/sessions/${reply.sessionId}`
      : undefined;
  return (
    <Card data-collaboration-reply={reply.id} className="min-w-0 gap-3">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <AgentAvatar agent={agent} className="size-7" />
          <span className="min-w-0 break-words">{name}</span>
        </CardTitle>
        {link ? (
          <CardAction>
            <Button asChild variant="ghost" size="sm">
              <Link to={link}>
                <ArrowUpRightIcon data-icon="inline-start" />
                {reply.taskId ? i18n._("Open task") : i18n._("Open conversation")}
              </Link>
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className={cn("min-w-0", long && !expanded && "line-clamp-3")} data-reply-content>
          <MarkdownContent content={reply.answer} />
        </div>
      </CardContent>
      {long ? (
        <CardFooter>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <ChevronUpIcon data-icon="inline-start" />
            ) : (
              <ChevronDownIcon data-icon="inline-start" />
            )}
            {expanded ? i18n._("Show less") : i18n._("Show more")}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
