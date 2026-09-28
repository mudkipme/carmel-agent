import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export const ACTIVITY_UPDATED = "carmel-activity-updated";

export function useActivityCount(userId: string) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(0);
    let controller: AbortController | undefined;
    const refresh = () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      void api.activityUnreadCount(request.signal).then(({ unreadCount }) => {
        if (!request.signal.aborted) setCount(unreadCount);
      }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 8_000);
    window.addEventListener("focus", refresh);
    window.addEventListener(ACTIVITY_UPDATED, refresh);
    return () => {
      controller?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(ACTIVITY_UPDATED, refresh);
    };
  }, [userId]);
  return count;
}
