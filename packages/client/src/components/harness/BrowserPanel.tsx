import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowLeftIcon, ArrowRightIcon, ExpandIcon, GlobeIcon, KeyboardIcon, MinimizeIcon, RotateCwIcon, XIcon } from "lucide-react";
import type { AgentConfig } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAgentBrowser } from "@/hooks/use-agent-browser";
import { browserAddress, browserModifiers, browserPoint } from "@/lib/browser-input";

export function BrowserPanel({ agent, expanded, onExpand, onClose }: {
  agent: AgentConfig; expanded: boolean; onExpand: () => void; onClose: () => void;
}) {
  const browser = useAgentBrowser(agent.id);
  const { send, frame, hasControl } = browser;
  const image = useRef<HTMLImageElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string>();
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const touch = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
  const control = browser.control;
  const canInput = hasControl && Boolean(frame);
  useEffect(() => { setAddress(browser.url); }, [browser.url]);
  useEffect(() => { if (!hasControl) { setTyped(""); setKeyboardOpen(false); } }, [hasControl]);
  useEffect(() => {
    // Consecutive frames can have identical pixels. React then keeps the same src,
    // so no load event fires; acknowledge the new sequence if that image is decoded.
    if (frame && image.current?.complete) send({ type: "ack", seq: frame.seq });
  }, [frame, send]);

  // Wheel listeners must be non-passive to avoid scrolling the host conversation.
  useEffect(() => {
    const element = surface.current;
    if (!element || !frame || !canInput) return;
    const wheel = (event: WheelEvent) => {
      const img = image.current; if (!img) return;
      event.preventDefault();
      const point = browserPoint(event.clientX, event.clientY, img.getBoundingClientRect(), frame.metadata);
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.metadata.deviceHeight : 1;
      const bounded = (value: number) => Math.max(-10000, Math.min(10000, value * scale));
      send({ type: "input_mouse", eventType: "mouseWheel", ...point, deltaX: bounded(event.deltaX), deltaY: bounded(event.deltaY), modifiers: browserModifiers(event) });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [canInput, frame, send]);

  const pointer = (event: PointerEvent<HTMLImageElement>, kind: "mousePressed" | "mouseMoved" | "mouseReleased") => {
    if (!canInput || !frame) return;
    event.preventDefault();
    const point = browserPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), frame.metadata);
    if (kind === "mousePressed") { surface.current?.focus(); event.currentTarget.setPointerCapture(event.pointerId); }
    if (event.pointerType === "touch") {
      if (kind === "mousePressed") { touch.current = { ...point, moved: false }; return; }
      const previous = touch.current;
      if (!previous) return;
      if (kind === "mouseMoved") {
        const dx = previous.x - point.x, dy = previous.y - point.y;
        if (Math.abs(dx) + Math.abs(dy) > 3 || previous.moved) {
          send({ type: "input_mouse", eventType: "mouseWheel", ...point, deltaX: dx, deltaY: dy });
          touch.current = { ...point, moved: true };
        }
        return;
      }
      if (!previous.moved) {
        send({ type: "input_mouse", eventType: "mousePressed", ...point, button: "left", clickCount: 1 });
        send({ type: "input_mouse", eventType: "mouseReleased", ...point, button: "left", clickCount: 1 });
      }
      touch.current = undefined; return;
    }
    send({ type: "input_mouse", eventType: kind, ...point, button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left", buttons: event.buttons, clickCount: 1, modifiers: browserModifiers(event) });
  };
  const key = (event: KeyboardEvent<HTMLDivElement>, eventType: "keyDown" | "keyUp") => {
    if (!canInput || event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && event.shiftKey) { event.preventDefault(); surface.current?.blur(); return; }
    // Let the browser deliver paste through the clipboard event, without reading it programmatically.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    event.preventDefault();
    send({ type: "input_keyboard", eventType, key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode,
      modifiers: browserModifiers(event), text: eventType === "keyDown" && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? event.key : undefined });
  };
  const paste = (text: string) => {
    for (let offset = 0; offset < text.length; offset += 4096) send({ type: "input_keyboard", eventType: "char", text: text.slice(offset, offset + 4096) });
  };
  const status = !browser.connected ? "Connecting" : hasControl ? "You have control" : control.phase === "pausing" ? "Pausing agent…" : control.controllerName ? `${control.controllerName} has control` : control.phase === "waiting" ? "Waiting for help" : "Agent has control";

  return <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Agent browser">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
      <div className="flex min-w-0 items-center gap-2"><GlobeIcon className="size-4" /><span className="text-sm font-medium">Browser</span><Badge variant="secondary">{status}</Badge></div>
      <div className="flex items-center gap-1">
        <Button size="sm" disabled={!browser.connected || control.phase === "pausing" || Boolean(control.controllerName && !hasControl)} onClick={() => { browser.clearError(); send({ type: hasControl ? "resume" : "take_control" }); }}>{hasControl ? "Resume agent" : "Take control"}</Button>
        <Button size="icon-sm" variant="ghost" aria-label={expanded ? "Show conversation" : "Expand browser"} onClick={onExpand}>{expanded ? <MinimizeIcon /> : <ExpandIcon />}</Button>
        <Button size="icon-sm" variant="ghost" aria-label="Close browser" onClick={onClose}><XIcon /></Button>
      </div>
    </div>
    <form className="flex items-center gap-1 border-b p-2" onSubmit={(event) => { event.preventDefault(); try { send({ type: "navigate", url: browserAddress(address) }); setAddressError(undefined); } catch { setAddressError("Enter an HTTP or HTTPS address."); } }}>
      <Button type="button" size="icon-sm" variant="ghost" aria-label="Browser back" disabled={!hasControl} onClick={() => send({ type: "back" })}><ArrowLeftIcon /></Button>
      <Button type="button" size="icon-sm" variant="ghost" aria-label="Browser forward" disabled={!hasControl} onClick={() => send({ type: "forward" })}><ArrowRightIcon /></Button>
      <Button type="button" size="icon-sm" variant="ghost" aria-label="Reload browser page" disabled={!hasControl} onClick={() => send({ type: "reload" })}><RotateCwIcon /></Button>
      <Field className="min-w-0 flex-1"><FieldLabel htmlFor="browser-address" className="sr-only">Browser address</FieldLabel><Input id="browser-address" value={address} onChange={(event) => setAddress(event.target.value)} readOnly={!hasControl} autoComplete="off" spellCheck={false} aria-invalid={Boolean(addressError)} placeholder="https://example.com" /></Field>
      <Button size="sm" variant="outline" type="submit" disabled={!hasControl}>Go</Button>
    </form>
    {browser.tabs.length > 1 ? <div className="border-b p-2"><Select value={browser.tabs.find((tab) => tab.active)?.id ?? ""} disabled={!hasControl} onValueChange={(id) => send({ type: "tab", id })}><SelectTrigger className="w-full" aria-label="Browser tab"><SelectValue placeholder="Select tab" /></SelectTrigger><SelectContent><SelectGroup>{browser.tabs.map((tab) => <SelectItem key={tab.id} value={tab.id}>{tab.title || tab.url || "Untitled"}</SelectItem>)}</SelectGroup></SelectContent></Select></div> : null}
    {control.phase !== "agent" ? <div className="p-3"><Alert role="status"><AlertTitle>{hasControl ? "The agent is paused" : control.phase === "pausing" ? "Waiting for the current tool call to finish" : "Browser assistance"}</AlertTitle><AlertDescription>{hasControl ? "Complete the action in the browser, then select Resume agent. Your input is not added to chat." : control.reason ?? "Take control to help the agent."}</AlertDescription></Alert></div> : null}
    {browser.error || addressError ? <div className="px-3 py-2"><Alert variant="destructive"><AlertTitle>Browser connection</AlertTitle><AlertDescription>{addressError ?? browser.error}<Button variant="outline" size="sm" onClick={browser.reconnect}>Reconnect</Button></AlertDescription></Alert></div> : null}
    <div className="min-h-0 flex-1 overflow-auto p-2">
      {frame ? <div ref={surface} tabIndex={canInput ? 0 : -1} role="application" aria-label={canInput ? "Remote browser. Click to focus, then type. Shift+Escape leaves the remote browser. Use the Keyboard button for text entry on mobile." : "Live browser preview. Take control to interact."}
        onKeyDown={(event) => key(event, "keyDown")} onKeyUp={(event) => key(event, "keyUp")}
        onBlur={() => { if (hasControl) send({ type: "release_input" }); }}
        onPaste={(event) => { if (canInput) { event.preventDefault(); paste(event.clipboardData.getData("text/plain")); } }}
        onContextMenu={(event) => { if (canInput) event.preventDefault(); }}>
        <img ref={image} src={`data:image/${frame.data.startsWith("iVBOR") ? "png" : "jpeg"};base64,${frame.data}`} alt="Live page in the agent's browser" className="block h-auto w-full select-none" style={{ touchAction: canInput ? "none" : "auto" }} draggable={false}
          onLoad={() => send({ type: "ack", seq: frame.seq })} onError={() => send({ type: "ack", seq: frame.seq })}
          onPointerDown={(event) => pointer(event, "mousePressed")} onPointerMove={(event) => pointer(event, "mouseMoved")} onPointerUp={(event) => pointer(event, "mouseReleased")}
          onPointerCancel={(event) => { touch.current = undefined; pointer(event, "mouseReleased"); }} />
      </div> : <Empty><EmptyHeader><EmptyMedia variant="icon"><GlobeIcon /></EmptyMedia><EmptyTitle>{browser.connected ? "Waiting for the page" : "Connecting to the browser"}</EmptyTitle><EmptyDescription>{browser.connected ? "The live page will appear here." : "Reconnecting preserves the agent’s browser and saved sign-ins."}</EmptyDescription></EmptyHeader></Empty>}
    </div>
    {keyboardOpen && hasControl ? <form className="flex items-end gap-2 border-t p-3" onSubmit={(event) => { event.preventDefault(); paste(typed); setTyped(""); }}>
      <Field className="min-w-0 flex-1"><FieldLabel htmlFor="browser-text">Type into the focused browser field</FieldLabel><Input id="browser-text" type="password" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" /></Field><Button type="submit" size="sm" disabled={!typed}>Send text</Button>
    </form> : null}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2"><span className="text-xs text-muted-foreground">{agent.shared ? "Shared agent · Shared sign-ins" : "Agent profile · Sign-ins retained"}</span><Button variant="ghost" size="sm" disabled={!canInput} onClick={() => setKeyboardOpen((open) => !open)} aria-pressed={keyboardOpen}><KeyboardIcon data-icon="inline-start" />Keyboard</Button></div>
  </section>;
}
