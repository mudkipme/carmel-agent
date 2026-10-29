import { useLingui } from "@lingui/react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";

export function AgentRequestCard({
  label,
  kind,
  icon,
  title,
  status,
  description,
  children,
  actions,
}: {
  label: string;
  kind: "question" | "secret" | "browser";
  icon: ReactNode;
  title: ReactNode;
  status: string;
  description: ReactNode;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <Card aria-label={label} data-agent-request-kind={kind}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {icon}
          <span className="min-w-0 break-words">{title}</span>
          <Badge variant="secondary" role="status">
            {status}
          </Badge>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
      <CardFooter className="flex-wrap gap-2">{actions}</CardFooter>
    </Card>
  );
}

/** Active requests stay beside the composer rather than scrolling with history. */
export function AgentRequestArea({ children }: { children: ReactNode }) {
  const { i18n } = useLingui();
  if (!children) return null;
  return (
    <section
      aria-label={i18n._("Agent requests")}
      data-agent-request-area
      className="max-h-[55%] min-h-0 shrink-0 overflow-y-auto px-3 py-3 sm:px-4"
    >
      <div className="mx-auto flex w-full max-w-[var(--line-width)] min-w-0 flex-col gap-3">
        {children}
      </div>
    </section>
  );
}
