import { PanelLeftCloseIcon, PanelLeftIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getDefaultSidebarWidth } from "./sidebar-utils";

/**
 * Chrome-only stand-in for the harness while the first API call is in flight:
 * the sidebar and header frames render, the panels stay empty until data lands.
 */
export function HarnessSkeleton() {
  return (
    <main
      role="status"
      aria-busy="true"
      className="relative flex h-[100dvh] min-h-0 overflow-hidden bg-background text-foreground"
    >
      <span className="sr-only">Loading Carmel Agent</span>
      <aside
        className="hidden min-h-0 shrink-0 flex-col border-r bg-sidebar pt-[var(--safe-top)] pb-[var(--safe-bottom)] lg:flex"
        style={{ width: getDefaultSidebarWidth() }}
      >
        <div className="flex h-[var(--header-height)] shrink-0 items-center gap-2 px-3">
          <img src="/apple-touch-icon.png" alt="" className="size-6 rounded" draggable={false} />
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium">Carmel Agent</h1>
          <Button size="icon-sm" variant="ghost" disabled>
            <PanelLeftCloseIcon />
          </Button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col pr-[var(--safe-right)]">
        <header className="flex h-[calc(var(--header-height)+var(--safe-top))] shrink-0 items-center justify-between gap-3 border-b bg-background px-3 pt-[var(--safe-top)]">
          <Button size="icon-sm" variant="ghost" disabled>
            <PanelLeftIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" disabled>
            <SettingsIcon />
          </Button>
        </header>
        <div className="min-h-0 flex-1" />
      </section>
    </main>
  );
}
