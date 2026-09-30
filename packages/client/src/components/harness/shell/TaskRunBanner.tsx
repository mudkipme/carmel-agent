import { CalendarClockIcon, ListPlusIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { showError } from "@/lib/errors";
import { useHarnessStore } from "@/store/harness-store";
import type { SessionMetadata } from "@carmel-agent/shared";

/**
 * Says where a task run's session came from, since it is not in the session
 * list to say so. Replying works as in any session; moving it to the list is
 * for a run worth keeping around.
 */
export function TaskRunBanner({ session }: { session: SessionMetadata }) {
  const moveSessionToList = useHarnessStore((state) => state.moveSessionToList);
  const [moving, setMoving] = useState(false);

  const move = async () => {
    setMoving(true);
    try {
      await moveSessionToList(session.id);
      toast.success("Moved to sessions");
    } catch (error) {
      showError("Unable to move session", error);
    } finally {
      setMoving(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-3 py-1.5 text-[13px]">
      <CalendarClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 truncate text-muted-foreground">
        Task run · <span className="text-foreground">{session.title}</span> ·{" "}
        {new Date(session.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
      </p>
      <div className="flex shrink-0 items-center gap-1">
        <Button asChild size="xs" variant="ghost">
          <Link to={`/agents/${session.agentId}/tasks?task=${encodeURIComponent(session.taskId ?? "")}`}>Run history</Link>
        </Button>
        <Button size="xs" variant="outline" disabled={moving} onClick={() => void move()}>
          <ListPlusIcon data-icon="inline-start" />
          Move to sessions
        </Button>
      </div>
    </div>
  );
}
