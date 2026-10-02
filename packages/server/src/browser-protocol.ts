import { z } from "zod";

const point = z.number().finite().min(0).max(16384);
const input = z.discriminatedUnion("type", [
  z.object({ type: z.literal("take_control") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("release_input") }),
  z.object({ type: z.literal("ack"), seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  z.object({ type: z.literal("navigate"), url: z.string().max(8192).refine((value) => {
    if (value === "about:blank") return true;
    try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
  }) }),
  z.object({ type: z.literal("tab"), id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/) }),
  z.object({ type: z.literal("back") }), z.object({ type: z.literal("forward") }), z.object({ type: z.literal("reload") }),
  z.object({
    type: z.literal("input_mouse"), eventType: z.enum(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
    x: point, y: point, button: z.enum(["left", "right", "middle"]).optional(),
    clickCount: z.number().int().min(0).max(3).optional(), buttons: z.number().int().min(0).max(7).optional(),
    deltaX: z.number().finite().min(-10000).max(10000).optional(), deltaY: z.number().finite().min(-10000).max(10000).optional(),
    modifiers: z.number().int().min(0).max(15).optional(),
  }),
  z.object({
    type: z.literal("input_keyboard"), eventType: z.enum(["keyDown", "keyUp", "char"]),
    key: z.string().max(100).optional(), code: z.string().max(100).optional(), text: z.string().max(4096).optional(),
    modifiers: z.number().int().min(0).max(15).optional(), windowsVirtualKeyCode: z.number().int().min(0).max(255).optional(),
  }),
]);

export function parseBrowserInput(raw: string) {
  if (Buffer.byteLength(raw) > 32 * 1024) return undefined;
  try { const result = input.safeParse(JSON.parse(raw)); return result.success ? result.data : undefined; }
  catch { return undefined; }
}

const output = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("command_done"), id: z.number().int().nonnegative() }),
  z.object({ type: z.literal("error"), message: z.string().max(2000) }),
  z.object({ type: z.literal("status"), connected: z.boolean() }),
  z.object({ type: z.literal("url"), url: z.string().max(8192) }),
  z.object({ type: z.literal("tabs"), tabs: z.array(z.object({ id: z.string().max(128), title: z.string().max(4096), url: z.string().max(8192), active: z.boolean() })).max(100) }),
  z.object({ type: z.literal("frame"), seq: z.number().int().nonnegative(), data: z.string().max(16 * 1024 * 1024), metadata: z.object({ deviceWidth: point.positive(), deviceHeight: point.positive(), pageScaleFactor: z.number().finite().positive().optional(), offsetTop: point.optional() }) }),
]);

/** Sandbox output can never forge server-owned control messages. */
export function parseBrowserOutput(value: unknown) {
  const result = output.safeParse(value);
  return result.success ? result.data : undefined;
}
