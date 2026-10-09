import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserClientMessage,
  BrowserControlState,
  BrowserFrame,
  BrowserServerMessage,
  BrowserTab,
} from "@carmel-agent/shared";

export function useAgentBrowser(agentId: string) {
  const socket = useRef<WebSocket | undefined>(undefined);
  const pendingAck = useRef<number | undefined>(undefined);
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
            setControl(message.state);
            setHasControl(message.hasControl);
            break;
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
            break;
          case "error":
            setError(message.message);
            break;
        }
      };
      ws.onclose = () => {
        if (disposed || socket.current !== ws) return;
        setConnected(false);
        setHasControl(false);
        setFrame(undefined);
        setError((previous) => previous ?? "Browser disconnected. Reconnecting…");
        if (++failures <= 3) retry = setTimeout(connect, Math.min(15000, failures * 2000));
      };
      ws.onerror = () => {
        /* onclose owns recovery. */
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", visible);
      socket.current?.close();
      socket.current = undefined;
    };
  }, [agentId, attempt, send]);

  return {
    connected,
    error,
    control,
    hasControl: hasControl && connected,
    frame,
    url,
    tabs,
    send,
    reconnect: () => {
      setError(undefined);
      setAttempt((value) => value + 1);
    },
    clearError: () => setError(undefined),
  };
}
