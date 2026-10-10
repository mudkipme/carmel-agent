import { CheckIcon, CopyIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { highlightCode } from "@/lib/highlight";
import { copyText } from "./chat-utils";

type CodeBlockProps = {
  code: string;
  language?: string;
  label?: string;
};

export function CodeBlock({ code, language, label }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const displayLanguage = language || "plaintext";
  const plainText = language === "text" || language === "plaintext";
  const highlighted = useMemo(
    () => (plainText ? "" : highlightCode(code, language ?? "")),
    [code, language, plainText],
  );

  const handleCopy = async () => {
    try {
      await copyText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  return (
    <div className="code-block min-w-0 overflow-hidden rounded-lg border border-border/70 bg-muted/60">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{label ?? displayLanguage}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          title={label ? `Copy ${label.toLowerCase()}` : "Copy code"}
          aria-label={label ? `Copy ${label.toLowerCase()}` : "Copy code"}
          className="text-ui-smaller inline-flex items-center gap-1 rounded px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          <span>{copied ? "Copied!" : "Copy"}</span>
        </button>
      </div>
      <div className="max-h-96 overflow-auto">
        <pre className="m-0 p-4 font-mono text-xs leading-relaxed text-foreground">
          {plainText ? (
            <code className="hljs">{code}</code>
          ) : (
            <code
              className={`hljs language-${displayLanguage}`}
              // Highlighted HTML is produced by highlight.js from plain code text.
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          )}
        </pre>
      </div>
    </div>
  );
}
