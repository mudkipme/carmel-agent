import { AlertCircleIcon, AlertTriangleIcon } from "lucide-react";
import type { ContextPressure } from "@/lib/remote-agent";

/**
 * Compaction could not keep this session inside its context budget.
 *
 * Deliberately not a toast: the condition persists past the run that reported
 * it, and every remedy -- switch to a model with a larger window, start a new
 * session -- is something the reader has to decide to do. A notification that
 * fades out would put this back where it started, which was a `console.warn` on
 * the server.
 */
export function ContextPressureNotice({ pressure }: { pressure: ContextPressure }) {
  const critical = pressure.level === "critical";
  const Icon = critical ? AlertCircleIcon : AlertTriangleIcon;
  return (
    <div
      role="status"
      className={`flex items-start gap-2 border-b px-4 py-2 text-sm ${
        critical ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"
      }`}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span>{pressure.message}</span>
    </div>
  );
}
