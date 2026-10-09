/** A browser and its authenticated profile belong to an agent, including shared users. */
export type BrowserControlState = {
  phase: "agent" | "pausing" | "waiting" | "human";
  reason?: string;
  controllerName?: string;
  revision: number;
};

export type BrowserTab = { id: string; title: string; url: string; active: boolean };
export type BrowserFrame = {
  type: "frame";
  seq: number;
  data: string;
  metadata: {
    deviceWidth: number;
    deviceHeight: number;
    pageScaleFactor?: number;
    offsetTop?: number;
  };
};
export type BrowserServerMessage =
  | BrowserFrame
  | { type: "control"; state: BrowserControlState; hasControl: boolean }
  | { type: "ready" }
  | { type: "status"; connected: boolean }
  | { type: "tabs"; tabs: BrowserTab[] }
  | { type: "url"; url: string }
  | { type: "error"; message: string };

export type BrowserClientMessage =
  | { type: "take_control" | "resume" | "release_input" }
  | { type: "ack"; seq: number }
  | { type: "navigate"; url: string }
  | { type: "tab"; id: string }
  | { type: "back" | "forward" | "reload" }
  | {
      type: "input_mouse";
      eventType: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      buttons?: number;
      modifiers?: number;
    }
  | {
      type: "input_keyboard";
      eventType: "keyDown" | "keyUp" | "char";
      key?: string;
      code?: string;
      text?: string;
      modifiers?: number;
      windowsVirtualKeyCode?: number;
    };
