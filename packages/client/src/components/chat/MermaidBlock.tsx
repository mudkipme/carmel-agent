import { Trans } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import type { Mounted } from "pele";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";

export function MermaidBlock({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let diagram: Mounted | undefined;

    void import("pele")
      .then(({ mount }) => {
        if (cancelled) return;
        diagram = mount(container, code, {
          links: false,
          images: false,
          onRender: () => setFailed(false),
          onError: () => setFailed(true),
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      diagram?.destroy();
      container.replaceChildren();
    };
  }, [code]);

  return (
    <div className="mermaid-block min-w-0">
      <div
        ref={containerRef}
        className={cn("mermaid-diagram min-w-0 overflow-hidden", failed && "h-0")}
        aria-hidden={failed || undefined}
      />
      {failed ? (
        <CodeBlock code={code} language="mermaid" />
      ) : (
        <details className="mt-2">
          <summary className="w-fit cursor-pointer rounded text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <Trans>Source</Trans>
          </summary>
          <div className="mt-2">
            <CodeBlock code={code} language="mermaid" />
          </div>
        </details>
      )}
    </div>
  );
}
