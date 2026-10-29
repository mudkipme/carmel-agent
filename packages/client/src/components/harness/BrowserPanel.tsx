import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GlobeIcon,
  KeyboardIcon,
  RotateCwIcon,
  CopyIcon,
  ClipboardPasteIcon,
} from "lucide-react";
import type { AgentConfig } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Field, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { AgentRequestArea } from "@/components/chat/AgentRequestCard";
import { BrowserRequestCard } from "@/components/chat/BrowserRequestCard";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentBrowser } from "@/hooks/use-agent-browser";
import { browserAddress, browserModifiers, browserPoint } from "@/lib/browser-input";

export function BrowserPanel({ agent }: { agent: AgentConfig }) {
  const { i18n } = useLingui();
  const browser = useAgentBrowser(agent.id);
  const { send, frame, hasControl } = browser;
  const image = useRef<HTMLImageElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const clipboardBusy = useRef(false);
  const [transferring, setTransferring] = useState(false);
  const [copiedText, setCopiedText] = useState<string>();
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string>();
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const touch = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
  const control = browser.control;
  const canInput = hasControl && Boolean(frame);
  const clipboardLease = useRef({ active: canInput, revision: browser.control.revision });
  clipboardLease.current = { active: canInput, revision: browser.control.revision };
  useEffect(
    () => () => {
      clipboardLease.current.active = false;
    },
    [],
  );
  useEffect(() => {
    setAddress(browser.url);
  }, [browser.url]);
  useEffect(() => {
    if (!hasControl) {
      setTyped("");
      setKeyboardOpen(false);
      setCopiedText(undefined);
    }
  }, [hasControl]);
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
      const img = image.current;
      if (!img) return;
      event.preventDefault();
      const point = browserPoint(
        event.clientX,
        event.clientY,
        img.getBoundingClientRect(),
        frame.metadata,
      );
      const scale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.metadata.deviceHeight : 1;
      const bounded = (value: number) => Math.max(-10000, Math.min(10000, value * scale));
      send({
        type: "input_mouse",
        eventType: "mouseWheel",
        ...point,
        deltaX: bounded(event.deltaX),
        deltaY: bounded(event.deltaY),
        modifiers: browserModifiers(event),
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [canInput, frame, send]);

  const pointer = (
    event: PointerEvent<HTMLImageElement>,
    kind: "mousePressed" | "mouseMoved" | "mouseReleased",
  ) => {
    if (!canInput || !frame) return;
    event.preventDefault();
    const point = browserPoint(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      frame.metadata,
    );
    if (kind === "mousePressed") {
      keyboard.current?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (event.pointerType === "touch") {
      if (kind === "mousePressed") {
        touch.current = { ...point, moved: false };
        return;
      }
      const previous = touch.current;
      if (!previous) return;
      if (kind === "mouseMoved") {
        const dx = previous.x - point.x,
          dy = previous.y - point.y;
        if (Math.abs(dx) + Math.abs(dy) > 3 || previous.moved) {
          send({ type: "input_mouse", eventType: "mouseWheel", ...point, deltaX: dx, deltaY: dy });
          touch.current = { ...point, moved: true };
        }
        return;
      }
      if (!previous.moved) {
        send({
          type: "input_mouse",
          eventType: "mousePressed",
          ...point,
          button: "left",
          clickCount: 1,
        });
        send({
          type: "input_mouse",
          eventType: "mouseReleased",
          ...point,
          button: "left",
          clickCount: 1,
        });
      }
      touch.current = undefined;
      return;
    }
    send({
      type: "input_mouse",
      eventType: kind,
      ...point,
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
      buttons: event.buttons,
      clickCount: 1,
      modifiers: browserModifiers(event),
    });
  };
  const key = (event: KeyboardEvent<HTMLDivElement>, eventType: "keyDown" | "keyUp") => {
    if (!canInput || event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && event.shiftKey) {
      event.preventDefault();
      surface.current?.blur();
      keyboard.current?.blur();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && ["c", "v"].includes(event.key.toLowerCase())) {
      // The hidden text input receives a trusted paste event, including on HTTP hosts.
      if (event.key.toLowerCase() === "v") return;
      event.preventDefault();
      if (eventType === "keyDown" && !event.repeat) void transfer("copy");
      return;
    }
    event.preventDefault();
    send({
      type: "input_keyboard",
      eventType,
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode,
      modifiers: browserModifiers(event),
      text:
        eventType === "keyDown" &&
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
          ? event.key
          : undefined,
    });
  };
  const transfer = async (operation: "copy" | "paste", text?: string) => {
    if (!canInput || clipboardBusy.current) return;
    const revision = clipboardLease.current.revision;
    const active = () =>
      clipboardLease.current.active && clipboardLease.current.revision === revision;
    clipboardBusy.current = true;
    setTransferring(true);
    setCopiedText(undefined);
    try {
      if (operation === "paste" && text === undefined) {
        try {
          text = await navigator.clipboard.readText();
        } catch {
          if (active()) {
            setKeyboardOpen(true);
            toast.info(i18n._("Paste text into the text entry field, then select Send text."), {
              position: "top-center",
            });
          }
          return;
        }
      }
      if (!active()) return;
      const result = await browser.clipboard(operation, text);
      if (!active()) return;
      if (operation === "copy") {
        if (!result) {
          toast.info(i18n._("Select text in the remote page before copying."), {
            position: "top-center",
          });
          return;
        }
        try {
          await navigator.clipboard.writeText(result);
          toast.success(i18n._("Copied from browser"), { position: "top-center" });
        } catch {
          if (active()) setCopiedText(result);
        }
      } else {
        setTyped("");
        toast.success(i18n._("Pasted into browser"), { position: "top-center" });
      }
    } catch (error) {
      if (active())
        toast.error(error instanceof Error ? error.message : i18n._("Clipboard transfer failed."), {
          position: "top-center",
        });
    } finally {
      clipboardBusy.current = false;
      setTransferring(false);
    }
  };
  const status = !browser.connected
    ? i18n._("Connecting")
    : hasControl
      ? i18n._("You have control")
      : control.phase === "pausing"
        ? i18n._("Pausing agent…")
        : control.controllerName
          ? i18n._("{controllerName} has control", { controllerName: control.controllerName })
          : control.phase === "waiting"
            ? i18n._("Waiting for help")
            : i18n._("Agent has control");
  const controlDisabled =
    !browser.connected ||
    control.phase === "pausing" ||
    Boolean(control.controllerName && !hasControl);
  const changeControl = () => {
    browser.clearError();
    send({ type: hasControl ? "resume" : "take_control" });
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={i18n._("Agent browser")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <div className="flex min-w-0 items-center gap-2">
          <GlobeIcon className="size-4" />
          <span className="text-sm font-medium">
            <Trans>Browser</Trans>
          </span>
          <Badge variant="secondary">{status}</Badge>
        </div>
        {control.phase === "agent" ? (
          <div className="flex items-center gap-1">
            <Button size="sm" disabled={controlDisabled} onClick={changeControl}>
              {hasControl ? i18n._("Resume agent") : i18n._("Take control")}
            </Button>
          </div>
        ) : null}
      </div>
      <form
        className="flex items-center gap-1 border-b p-2"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            send({ type: "navigate", url: browserAddress(address) });
            setAddressError(undefined);
          } catch {
            setAddressError(i18n._("Enter an HTTP or HTTPS address."));
          }
        }}
      >
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={i18n._("Browser back")}
          disabled={!hasControl}
          onClick={() => send({ type: "back" })}
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={i18n._("Browser forward")}
          disabled={!hasControl}
          onClick={() => send({ type: "forward" })}
        >
          <ArrowRightIcon />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={i18n._("Reload browser page")}
          disabled={!hasControl}
          onClick={() => send({ type: "reload" })}
        >
          <RotateCwIcon />
        </Button>
        <Field className="min-w-0 flex-1">
          <FieldLabel htmlFor="browser-address" className="sr-only">
            <Trans>Browser address</Trans>
          </FieldLabel>
          <Input
            id="browser-address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            readOnly={!hasControl}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(addressError)}
            placeholder="https://example.com"
          />
        </Field>
        <Button size="sm" variant="outline" type="submit" disabled={!hasControl}>
          <Trans>Go</Trans>
        </Button>
      </form>
      {browser.tabs.length > 1 ? (
        <div className="border-b p-2">
          <Select
            value={browser.tabs.find((tab) => tab.active)?.id ?? ""}
            disabled={!hasControl}
            onValueChange={(id) => send({ type: "tab", id })}
          >
            <SelectTrigger className="w-full" aria-label={i18n._("Browser tab")}>
              <SelectValue placeholder={i18n._("Select tab")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {browser.tabs.map((tab) => (
                  <SelectItem key={tab.id} value={tab.id}>
                    {tab.title || tab.url || i18n._("Untitled")}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {browser.error || addressError ? (
        <div className="px-3 py-2">
          <Alert variant="destructive">
            <AlertTitle>
              <Trans>Browser connection</Trans>
            </AlertTitle>
            <AlertDescription>
              {addressError ?? browser.error}
              <Button variant="outline" size="sm" onClick={browser.reconnect}>
                <Trans>Reconnect</Trans>
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {frame ? (
          <div
            ref={surface}
            tabIndex={canInput ? 0 : -1}
            role="application"
            aria-label={
              canInput
                ? i18n._(
                    "Remote browser. Click to focus, then type or use copy and paste shortcuts. Shift+Escape leaves the remote browser. Use the Keyboard button for text entry on mobile.",
                  )
                : i18n._("Live browser preview. Take control to interact.")
            }
            onKeyDown={(event) => key(event, "keyDown")}
            onKeyUp={(event) => key(event, "keyUp")}
            onBlur={() => {
              if (hasControl) send({ type: "release_input" });
            }}
            onPaste={(event) => {
              if (canInput) {
                event.preventDefault();
                void transfer("paste", event.clipboardData.getData("text/plain"));
              }
            }}
            onContextMenu={(event) => {
              if (canInput) event.preventDefault();
            }}
          >
            <textarea
              ref={keyboard}
              className="sr-only"
              aria-label={i18n._("Remote browser keyboard input")}
              tabIndex={-1}
              autoComplete="off"
              value=""
              onChange={() => {}}
              onBeforeInput={(event) => event.preventDefault()}
            />
            <img
              ref={image}
              src={`data:image/${frame.data.startsWith("iVBOR") ? "png" : "jpeg"};base64,${frame.data}`}
              alt={i18n._("Live page in the agent's browser")}
              className="block h-auto w-full select-none"
              style={{ touchAction: canInput ? "none" : "auto" }}
              draggable={false}
              onLoad={() => send({ type: "ack", seq: frame.seq })}
              onError={() => send({ type: "ack", seq: frame.seq })}
              onPointerDown={(event) => pointer(event, "mousePressed")}
              onPointerMove={(event) => pointer(event, "mouseMoved")}
              onPointerUp={(event) => pointer(event, "mouseReleased")}
              onPointerCancel={(event) => {
                touch.current = undefined;
                pointer(event, "mouseReleased");
              }}
            />
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GlobeIcon />
              </EmptyMedia>
              <EmptyTitle>
                {browser.connected
                  ? i18n._("Waiting for the page")
                  : i18n._("Connecting to the browser")}
              </EmptyTitle>
              {!browser.connected ? (
                <EmptyDescription>
                  <Trans>Reconnecting preserves the agent’s browser and saved sign-ins.</Trans>
                </EmptyDescription>
              ) : null}
            </EmptyHeader>
          </Empty>
        )}
      </div>
      {keyboardOpen && hasControl ? (
        <form
          className="flex items-end gap-2 border-t p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void transfer("paste", typed);
          }}
        >
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor="browser-text">
              <Trans>Type into the focused browser field</Trans>
            </FieldLabel>
            <Textarea
              id="browser-text"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Button type="submit" size="sm" disabled={!typed || transferring}>
            <Trans>Send text</Trans>
          </Button>
        </form>
      ) : null}
      {copiedText !== undefined && hasControl ? (
        <Field className="p-3">
          <FieldLabel htmlFor="browser-copied-text">
            <Trans>Copy from browser</Trans>
          </FieldLabel>
          <p className="text-xs text-muted-foreground">
            <Trans>
              Clipboard access is blocked. Select this text and copy it using your device’s copy
              command.
            </Trans>
          </p>
          <Textarea
            id="browser-copied-text"
            value={copiedText}
            readOnly
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button variant="outline" size="sm" onClick={() => setCopiedText(undefined)}>
            <Trans>Dismiss</Trans>
          </Button>
        </Field>
      ) : null}
      {control.phase !== "agent" ? (
        <AgentRequestArea>
          <BrowserRequestCard
            control={control}
            hasControl={hasControl}
            actionLabel={hasControl ? i18n._("Resume agent") : i18n._("Take control")}
            disabled={controlDisabled}
            onAction={changeControl}
          />
        </AgentRequestArea>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {agent.shared
            ? i18n._("Shared agent · Shared sign-ins")
            : i18n._("Agent profile · Sign-ins retained")}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={!canInput || transferring}
            onClick={() => void transfer("copy")}
          >
            <CopyIcon data-icon="inline-start" />
            <Trans>Copy selection</Trans>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!canInput || transferring}
            onClick={() => void transfer("paste")}
          >
            <ClipboardPasteIcon data-icon="inline-start" />
            <Trans>Paste</Trans>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!canInput}
            onClick={() => setKeyboardOpen((open) => !open)}
            aria-pressed={keyboardOpen}
          >
            <KeyboardIcon data-icon="inline-start" />
            <Trans>Keyboard</Trans>
          </Button>
        </div>
      </div>
    </section>
  );
}
