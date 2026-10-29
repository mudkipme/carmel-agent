import { Trans } from "@lingui/react/macro";
import type { AgentConfig } from "@carmel-agent/shared";
import { AgentAvatar } from "@/components/harness/shell/AgentAvatar";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

export function ChatWelcome({ agent }: { agent: AgentConfig }) {
  return (
    <Empty className="flex-none p-0 md:p-0">
      <EmptyHeader className="max-w-full gap-3">
        <EmptyMedia className="mb-0">
          <AgentAvatar agent={agent} className="size-10 rounded-lg" />
        </EmptyMedia>
        <EmptyTitle>
          <h1 className="text-lg font-medium tracking-tight break-words sm:text-xl">
            <Trans>What can {agent.name} help with?</Trans>
          </h1>
        </EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}
