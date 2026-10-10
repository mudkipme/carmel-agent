import { ArrowLeftIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SettingsLayout({
  title,
  subtitle,
  backLabel,
  onBack,
  sections,
  activeSection,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  backLabel: string;
  onBack: () => void;
  sections: Array<{ id: string; label: string; icon: LucideIcon; to: string }>;
  activeSection: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[data-active="true"]');
    if (nav && active && nav.scrollWidth > nav.clientWidth) {
      nav.scrollLeft =
        active.offsetLeft - nav.offsetLeft - (nav.clientWidth - active.clientWidth) / 2;
    }
  }, [activeSection]);

  return (
    <main className="flex h-[100dvh] min-h-0 flex-col bg-background pr-[var(--safe-right)] pl-[var(--safe-left)] text-foreground">
      <header className="flex h-[calc(var(--header-height)+var(--safe-top))] shrink-0 items-center gap-3 border-b px-3 pt-[var(--safe-top)] sm:px-5">
        <Button
          variant="ghost"
          size="icon-sm"
          title={backLabel}
          aria-label={backLabel}
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <h1 className="truncate text-sm font-semibold">{title}</h1>
        {subtitle ? (
          <span className="truncate border-l pl-3 text-sm text-muted-foreground">{subtitle}</span>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b bg-sidebar p-2 md:w-60 md:border-r md:border-b-0 md:p-4">
          <p className="nav-label hidden px-3 pt-2 pb-4 md:block">
            {subtitle ? "Agent preferences" : "Workspace preferences"}
          </p>
          <nav
            ref={navRef}
            aria-label={title}
            className="relative flex gap-1 overflow-x-auto md:flex-col"
          >
            {sections.map(({ id, label, icon: Icon, to }) => (
              <NavLink
                key={id}
                to={to}
                data-active={id === activeSection}
                className={cn(
                  "nav-item flex min-h-10 shrink-0 items-center gap-2.5 rounded-lg px-3 text-[13px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  id === activeSection && "font-medium",
                )}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                {label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div
              data-settings-content
              className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6 px-4 py-6 pb-[calc(1.5rem+var(--safe-bottom))] sm:px-8 sm:py-10"
            >
              {children}
            </div>
          </div>
          {footer}
        </section>
      </div>
    </main>
  );
}
