import { CheckIcon, CopyIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { highlightCode } from "@/lib/highlight";
import { copyText } from "./chat-utils";

type CodeBlockProps = {
  code: string;
  language?: string;
};

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const displayLanguage = language || "plaintext";
  const highlighted = useMemo(() => highlightCode(code, language ?? ""), [code, language]);

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
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between px-3 py-1">
        <span className="font-mono text-xs text-muted-foreground">{displayLanguage}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          title="Copy code"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          <span>{copied ? "Copied!" : "Copy"}</span>
        </button>
      </div>
      <div className="max-h-96 overflow-auto">
        <pre className="m-0 px-4 pb-4 font-mono text-xs text-foreground">
          <code
            className={`hljs language-${displayLanguage}`}
            // Highlighted HTML is produced by highlight.js from plain code text.
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
      </div>
    </div>
  );
}
