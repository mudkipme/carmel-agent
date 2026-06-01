import { useEffect, useRef } from "react";
import type { MarkdownBlock } from "@mariozechner/mini-lit/dist/MarkdownBlock.js";

type MarkdownContentProps = {
  content: string;
  thinking?: boolean;
};

export function MarkdownContent({ content, thinking = false }: MarkdownContentProps) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const blockRef = useRef<MarkdownBlock | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!blockRef.current) {
      blockRef.current = document.createElement("markdown-block") as MarkdownBlock;
      container.appendChild(blockRef.current);
    }
    blockRef.current.content = content;
    blockRef.current.isThinking = thinking;
    blockRef.current.requestUpdate();
  }, [content, thinking]);

  return <span ref={containerRef} />;
}
