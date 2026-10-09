import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { RotateCcwIcon } from "lucide-react";
import type { AgentConfig } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { useThemePreference } from "@/lib/theme";

/**
 * An interactive shell in the agent's runner container.
 *
 * The shell lives on the server, keyed by agent and user, so this component is
 * a view onto it rather than its owner: unmounting detaches, and mounting again
 * reattaches to the same shell and replays what was missed. That is why the
 * terminal is not torn down and rebuilt on every re-render, and why closing the
 * tab does not kill whatever was running.
 */

type ServerMessage =
  | { type: "ready" }
  | { type: "output"; data: string }
  | { type: "exit"; reason: string }
  | { type: "error"; message: string };

type Status = { kind: "connecting" } | { kind: "open" } | { kind: "closed"; reason: string };

export function TerminalPanel({ agent }: { agent: AgentConfig }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>(undefined);
  const fitRef = useRef<FitAddon>(undefined);
  const socketRef = useRef<WebSocket>(undefined);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const themePreference = useThemePreference();

  const bashEnabled = agent.permissions.bash;

  /* Colors come from the rendered element rather than the CSS variables: the
     tokens are authored in hsl()/oklch() and xterm needs values it can parse,
     which is exactly what getComputedStyle hands back. */
  const applyTheme = useCallback(() => {
    const terminal = terminalRef.current;
    const host = hostRef.current;
    if (!terminal || !host) return;
    const styles = getComputedStyle(host);
    terminal.options.theme = {
      background: styles.backgroundColor,
      foreground: styles.color,
      cursor: styles.color,
      cursorAccent: styles.backgroundColor,
    };
  }, []);

  useEffect(() => {
    if (!bashEnabled) return;
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    applyTheme();
    fit.fit();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams({
      agent: agent.id,
      rows: String(terminal.rows),
      cols: String(terminal.cols),
    });
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/terminal?${query}`);
    socketRef.current = socket;
    setStatus({ kind: "connecting" });

    const send = (message: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (message.type === "output") terminal.write(message.data);
      else if (message.type === "ready") setStatus({ kind: "open" });
      else if (message.type === "exit") setStatus({ kind: "closed", reason: message.reason });
      else setStatus({ kind: "closed", reason: message.message });
    };
    /* Only a drop the server did not explain: an `exit` or `error` frame has
       already set a more useful reason than "connection lost". */
    socket.onclose = () =>
      setStatus((current) =>
        current.kind === "closed" ? current : { kind: "closed", reason: "Connection lost." },
      );

    const inputSubscription = terminal.onData((data) => send({ type: "input", data }));

    const resize = () => {
      try {
        fit.fit();
      } catch {
        // The panel can be measured mid-layout; the observer will fire again.
        return;
      }
      send({ type: "resize", rows: terminal.rows, cols: terminal.cols });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      observer.disconnect();
      inputSubscription.dispose();
      socket.onclose = null;
      socket.close();
      terminal.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
      socketRef.current = undefined;
    };
  }, [agent.id, applyTheme, attempt, bashEnabled]);

  // Repaint on a theme change without rebuilding the terminal or the session.
  useEffect(() => {
    applyTheme();
  }, [applyTheme, themePreference]);

  if (!bashEnabled) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Bash is disabled for this agent. Enable it in the agent's permissions to open a terminal.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {status.kind !== "open" ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-1.5">
          <p className="truncate text-xs text-muted-foreground">
            {status.kind === "connecting" ? "Starting shell…" : status.reason}
          </p>
          {status.kind === "closed" ? (
            <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
              <RotateCcwIcon data-icon="inline-start" />
              Restart
            </Button>
          ) : null}
        </div>
      ) : null}
      {/* The host carries the theme tokens applyTheme reads back out of it. */}
      <div ref={hostRef} className="min-h-0 flex-1 bg-background px-2 py-1 text-foreground" />
    </div>
  );
}
