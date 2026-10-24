import {
  isValidElement,
  memo,
  useContext,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import { Link, useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { agentFilesPath, workspaceFileFromHref } from "@/lib/file-links";
import { cn } from "@/lib/utils";
import { preserveSoftLineBreaks } from "@/lib/markdown";
import { api } from "@/lib/api";
import { workspaceChatPath } from "@/lib/workspace-layout";
import { CodeBlock } from "./CodeBlock";
import { MermaidBlock } from "./MermaidBlock";
import { WorkspaceFileLinkAgentContext, WorkspaceFilePathContext } from "./workspace-file-links";

type MarkdownContentProps = {
  content: string;
  thinking?: boolean;
  preserveLineBreaks?: boolean;
};

const components: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  table: ({ children, ...props }) => (
    <div className="my-4 overflow-x-auto">
      <table {...props}>{children}</table>
    </div>
  ),
  pre: ({ children }) => {
    const code = isValidElement<ComponentPropsWithoutRef<"code">>(children) ? children : null;
    const language = languageFromClassName(code?.props.className);
    const source = childrenToText(code?.props.children);
    return (
      <div className="mt-2">
        {language?.toLowerCase() === "mermaid" ? (
          <MermaidBlock code={source} />
        ) : (
          <CodeBlock code={source} language={language} />
        )}
      </div>
    );
  },
};

// Memoized because each render re-runs the full remark parse; unchanged content
// (everything but the actively streaming part) must skip it.
export const MarkdownContent = memo(function MarkdownContent({
  content,
  thinking = false,
  preserveLineBreaks = true,
}: MarkdownContentProps) {
  const source = useMemo(
    () => (preserveLineBreaks ? preserveSoftLineBreaks(content) : content),
    [content, preserveLineBreaks],
  );

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
  const sourceFile = useContext(WorkspaceFilePathContext);
  const [params] = useSearchParams();
  const filePath = agentId ? workspaceFileFromHref(href, sourceFile) : undefined;
  if (agentId && filePath) {
    const path = agentFilesPath(agentId, filePath);
    return (
      <Link
        {...props}
        to={params.has("chat") ? workspaceChatPath(path, params.get("chat")!) : path}
      >
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

function MarkdownImage({
  src,
  alt,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"img"> & { node?: unknown }) {
  const agentId = useContext(WorkspaceFileLinkAgentContext);
  const sourceFile = useContext(WorkspaceFilePathContext);
  const path =
    agentId && sourceFile
      ? workspaceFileFromHref(typeof src === "string" ? src : undefined, sourceFile)
      : undefined;
  return (
    <img
      {...props}
      src={agentId && path ? api.getAgentFileRawUrl(agentId, path) : src}
      alt={alt ?? ""}
      className="max-w-full"
    />
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
