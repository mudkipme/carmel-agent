import { i18n } from "@lingui/core";
/** Keep summaries deliberate: never dump arbitrary tool arguments into the transcript. */
export function toolPresentation(name: string, args: Record<string, unknown>) {
  const shortName = name.split("__").at(-1) ?? name;
  const kind = /^(bash|shell|exec|exec_command|terminal)$/i.test(shortName)
    ? "terminal"
    : /^(read|read_file|read_text_file)$/i.test(shortName)
      ? "read"
      : /^(write|edit|write_file|edit_file|apply_patch)$/i.test(shortName)
        ? "edit"
        : /search|grep|glob|find/i.test(shortName)
          ? "search"
          : /browser|navigate|fetch|web/i.test(shortName)
            ? "web"
            : "tool";
  const labels: Record<string, string> = {
    bash: i18n._("Run command"),
    exec_command: i18n._("Run command"),
    shell: i18n._("Run command"),
    read: i18n._("Read file"),
    read_file: i18n._("Read file"),
    write: i18n._("Write file"),
    write_file: i18n._("Write file"),
    edit: i18n._("Edit file"),
    edit_file: i18n._("Edit file"),
    apply_patch: i18n._("Apply patch"),
    grep: i18n._("Search content"),
    glob: i18n._("Find files"),
    ls: i18n._("List files"),
    codemode: i18n._("Run code"),
  };
  const keys =
    kind === "terminal"
      ? ["command", "cmd"]
      : kind === "read" || kind === "edit"
        ? ["path", "file_path", "filePath"]
        : kind === "search"
          ? ["query", "pattern", "q", "path"]
          : ["description", "path", "url", "query"];
  const value = keys
    .map((key) => args[key])
    .find((value) => typeof value === "string" && value.trim());
  return {
    kind,
    label:
      labels[shortName.toLowerCase()] ??
      shortName.replace(/[_-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase()),
    summary: typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 240) : "",
  };
}
