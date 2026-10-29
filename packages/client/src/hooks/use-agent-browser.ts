import { useLingui } from "@lingui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { browserClipboardLimit } from "@carmel-agent/shared";
import type {
  BrowserClientMessage,
  BrowserControlState,
  BrowserFrame,
  BrowserServerMessage,
  BrowserTab,
} from "@carmel-agent/shared";

export function useAgentBrowser(agentId: string) {
  const { i18n } = useLingui();
  const socket = useRef<WebSocket | undefined>(undefined);
  const pendingAck = useRef<number | undefined>(undefined);
  const clipboardRequests = useRef(
    new Map<
      string,
      {
        resolve: (text: string) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const cancelClipboard = useCallback(() => {
    for (const request of clipboardRequests.current.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(i18n._("Browser clipboard transfer was interrupted.")));
    }
    clipboardRequests.current.clear();
  }, [i18n]);
  const [attempt, setAttempt] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [control, setControl] = useState<BrowserControlState>({ phase: "agent", revision: 0 });
  const [hasControl, setHasControl] = useState(false);
  const [frame, setFrame] = useState<BrowserFrame>();
  const [url, setUrl] = useState("");
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const send = useCallback((message: BrowserClientMessage) => {
    if (message.type === "ack" && document.hidden) {
      pendingAck.current = message.seq;
      return;
    }
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);

  const clipboard = useCallback(
    (operation: "copy" | "paste", text = "") => {
      if (socket.current?.readyState !== WebSocket.OPEN)
        return Promise.reject(new Error(i18n._("Browser disconnected.")));
      if (text.length > browserClipboardLimit)
        return Promise.reject(new Error(i18n._("Paste at most 16,384 characters at a time.")));
      const requestId = crypto.randomUUID();
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          clipboardRequests.current.delete(requestId);
          reject(
            new Error(
              i18n._("Clipboard transfer timed out. Reconnect the browser before trying again."),
            ),
          );
        }, 120000);
        clipboardRequests.current.set(requestId, { resolve, reject, timer });
        send(
          operation === "copy"
            ? { type: "clipboard", requestId, operation }
            : { type: "clipboard", requestId, operation, text },
        );
      });
    },
    [send, i18n],
  );

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const visible = () => {
      if (!document.hidden && pendingAck.current !== undefined) {
        send({ type: "ack", seq: pendingAck.current });
        pendingAck.current = undefined;
      }
    };
    document.addEventListener("visibilitychange", visible);
    const connect = () => {
      if (disposed) return;
      setConnected(false);
      setHasControl(false);
      setFrame(undefined);
      pendingAck.current = undefined;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/api/browser?agent=${encodeURIComponent(agentId)}`,
      );
      socket.current = ws;
      ws.onmessage = (event) => {
        if (disposed || socket.current !== ws) return;
        let message: BrowserServerMessage;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        switch (message.type) {
          case "ready":
            setConnected(true);
            setError(undefined);
            failures = 0;
            break;
          case "control":
            if (!message.hasControl) cancelClipboard();
            setControl(message.state);
            setHasControl(message.hasControl);
            break;
          case "clipboard_result": {
            const request = clipboardRequests.current.get(message.requestId);
            if (!request) break;
            clearTimeout(request.timer);
            clipboardRequests.current.delete(message.requestId);
            if (message.error) request.reject(new Error(message.error));
            else request.resolve(message.text ?? "");
            break;
          }
          case "frame":
            setFrame(message);
            break;
          case "tabs":
            setTabs(message.tabs);
            break;
          case "url":
            setUrl(message.url);
            break;
          case "status":
            setConnected(message.connected);
            if (!message.connected) setFrame(undefined);
            if (!message.connected) cancelClipboard();
            break;
          case "error":
            setError(message.message);
            break;
        }
      };
      ws.onclose = () => {
        if (disposed || socket.current !== ws) return;
        cancelClipboard();
        setConnected(false);
        setHasControl(false);
        setFrame(undefined);
        setError((previous) => previous ?? i18n._("Browser disconnected. Reconnecting…"));
        if (++failures <= 3) retry = setTimeout(connect, Math.min(15000, failures * 2000));
      };
      ws.onerror = () => {
        /* onclose owns recovery. */
      };
    };
    connect();
    return () => {
      disposed = true;
      cancelClipboard();
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", visible);
      socket.current?.close();
      socket.current = undefined;
    };
  }, [agentId, attempt, send, cancelClipboard, i18n]);

  return {
    connected,
    error,
    control,
    hasControl: hasControl && connected,
    frame,
    url,
    tabs,
    send,
    clipboard,
    reconnect: () => {
      setError(undefined);
      setAttempt((value) => value + 1);
    },
    clearError: () => setError(undefined),
  };
}
