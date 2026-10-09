import {
  isValidElement,
  memo,
  useContext,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { agentFilesPath, workspaceFileFromHref } from "@/lib/file-links";
import { cn } from "@/lib/utils";
import { preserveSoftLineBreaks } from "@/lib/markdown";
import { CodeBlock } from "./CodeBlock";
import { WorkspaceFileLinkAgentContext } from "./workspace-file-links";

type MarkdownContentProps = {
  content: string;
  thinking?: boolean;
};

const components: Components = {
  a: MarkdownLink,
  table: ({ children, ...props }) => (
    <div className="my-4 overflow-x-auto">
      <table {...props}>{children}</table>
    </div>
  ),
  pre: ({ children }) => {
    const code = isValidElement<ComponentPropsWithoutRef<"code">>(children) ? children : null;
    const language = languageFromClassName(code?.props.className);
    return (
      <div className="mt-2">
        <CodeBlock code={childrenToText(code?.props.children)} language={language} />
      </div>
    );
  },
};

// Memoized because each render re-runs the full remark parse; unchanged content
// (everything but the actively streaming part) must skip it.
export const MarkdownContent = memo(function MarkdownContent({
  content,
  thinking = false,
}: MarkdownContentProps) {
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

function MarkdownLink({
  children,
  href,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  const agentId = useContext(WorkspaceFileLinkAgentContext);
  const filePath = agentId ? workspaceFileFromHref(href) : undefined;
  if (agentId && filePath) {
    return (
      <Link {...props} to={agentFilesPath(agentId, filePath)}>
        {children}
      </Link>
    );
  }
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function languageFromClassName(className?: string) {
  const match = /language-(\w+)/.exec(className ?? "");
  return match?.[1] ?? "text";
}

function childrenToText(children: ReactNode): string {
  if (typeof children === "string") return children.replace(/\n$/, "");
  if (Array.isArray(children)) return children.map(childrenToText).join("");
  if (isValidElement<{ children?: ReactNode }>(children))
    return childrenToText(children.props.children);
  if (children == null || children === false) return "";
  return String(children);
}
