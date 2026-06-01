import "@mariozechner/mini-lit/dist/CodeBlock.js";
import { MarkdownBlock } from "@mariozechner/mini-lit/dist/MarkdownBlock.js";

const patched = Symbol.for("carmel.markdownSoftBreaksPatched");
const prototype = MarkdownBlock.prototype as MarkdownBlock & { [patched]?: boolean };

if (!prototype[patched]) {
  prototype[patched] = true;
  const render = prototype.render;

  prototype.render = function renderWithSoftBreaks(this: MarkdownBlock) {
    const originalContent = this.content;
    this.content = preserveSoftLineBreaks(originalContent);
    try {
      return render.call(this);
    } finally {
      this.content = originalContent;
    }
  };
}

function preserveSoftLineBreaks(markdown: string) {
  const lines = markdown.split(/(\r?\n)/);
  let inFence = false;

  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index] ?? "";
    const newline = lines[index + 1];
    if (isFence(line)) inFence = !inFence;
    if (inFence || newline === undefined || line.trim() === "") continue;
    if (line.endsWith("  ") || line.endsWith("\\")) continue;
    lines[index] = `${line}  `;
  }

  return lines.join("");
}

function isFence(line: string) {
  return /^\s*(```|~~~)/.test(line);
}
