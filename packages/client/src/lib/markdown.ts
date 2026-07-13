// Markdown treats a single newline as a soft break that collapses into a space.
// Agents often rely on single newlines for line breaks, so append two trailing
// spaces to non-empty lines (outside code fences) to preserve them.
export function preserveSoftLineBreaks(markdown: string) {
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
