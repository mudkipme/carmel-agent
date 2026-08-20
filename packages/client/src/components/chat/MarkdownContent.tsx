import { isValidElement, memo, useMemo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { preserveSoftLineBreaks } from "@/lib/markdown";
import { CodeBlock } from "./CodeBlock";

type MarkdownContentProps = {
  content: string;
  thinking?: boolean;
};

const components: Components = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children, ...props }) => (
    <div className="my-4 overflow-x-auto">
      <table {...props}>{children}</table>
    </div>
  ),
  pre: ({ children }) => {
    const code = isValidElement<ComponentPropsWithoutRef<"code">>(children) ? children : null;
    const language = languageFromClassName(code?.props.className);
    return <div className="mt-2"><CodeBlock code={childrenToText(code?.props.children)} language={language} /></div>;
  },
};

// Memoized because each render re-runs the full remark parse; unchanged content
// (everything but the actively streaming part) must skip it.
export const MarkdownContent = memo(function MarkdownContent({ content, thinking = false }: MarkdownContentProps) {
  const source = useMemo(() => preserveSoftLineBreaks(content), [content]);

  return (
    <div
      className={cn(
        "markdown-content max-w-none break-words [overflow-wrap:anywhere] [&>*:last-child]:mb-0",
        thinking ? "text-sm italic text-muted-foreground" : "text-foreground",
      )}
    >
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </Markdown>
    </div>
  );
});

function languageFromClassName(className?: string) {
  const match = /language-(\w+)/.exec(className ?? "");
  return match?.[1] ?? "text";
}

function childrenToText(children: ReactNode): string {
  if (typeof children === "string") return children.replace(/\n$/, "");
  if (Array.isArray(children)) return children.map(childrenToText).join("");
  if (isValidElement<{ children?: ReactNode }>(children)) return childrenToText(children.props.children);
  if (children == null || children === false) return "";
  return String(children);
}
