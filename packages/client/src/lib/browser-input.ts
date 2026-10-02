/** Convert displayed image coordinates to viewport CSS pixels, independent of preview scaling. */
export function browserPoint(x: number, y: number, rect: { left: number; top: number; width: number; height: number }, viewport: { deviceWidth: number; deviceHeight: number }) {
  // Screencasts preserve their aspect ratio. agent-browser can report the configured
  // window height (720) while Chromium renders a shorter content viewport (633).
  // Use the width scale for both axes so that this difference cannot stretch clicks.
  const scale = viewport.deviceWidth / Math.max(1, rect.width);
  return {
    x: Math.max(0, Math.min(viewport.deviceWidth - 1, (x - rect.left) * scale)),
    y: Math.max(0, Math.min(rect.height * scale - 1, (y - rect.top) * scale)),
  };
}

export function browserModifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

export function browserAddress(value: string) {
  const address = value.trim();
  if (address === "about:blank") return address;
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(address) ? address : `https://${address}`);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Enter an HTTP or HTTPS address.");
  return url.href;
}
