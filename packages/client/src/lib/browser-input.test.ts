import test from "node:test";
import assert from "node:assert/strict";
import { browserAddress, browserModifiers, browserPoint } from "./browser-input.ts";

test("remote coordinates remain accurate when a viewport is scaled down or a pointer is captured outside it", () => {
  const rect = { left: 100, top: 50, width: 640, height: 360 };
  const viewport = { deviceWidth: 1280, deviceHeight: 720 };
  assert.deepEqual(browserPoint(420, 230, rect, viewport), { x: 640, y: 360 });
  assert.deepEqual(browserPoint(-100, 9999, rect, viewport), { x: 0, y: 719 });
});
test("clicks follow the image aspect ratio when Chromium content is shorter than its configured viewport", () => {
  const rect = { left: 100, top: 50, width: 640, height: 316.5 };
  const viewport = { deviceWidth: 1280, deviceHeight: 720 };
  assert.deepEqual(browserPoint(135, 140, rect, viewport), { x: 70, y: 180 });
  assert.deepEqual(browserPoint(135, 9999, rect, viewport), { x: 70, y: 632 });
});
test("address input normalizes domains without permitting active content", () => {
  assert.equal(browserAddress(" example.com/login "), "https://example.com/login");
  assert.equal(browserAddress("http://localhost:3000"), "http://localhost:3000/");
  assert.equal(browserAddress("about:blank"), "about:blank");
  assert.throws(() => browserAddress("javascript:alert(1)"));
  assert.throws(() => browserAddress("file:///etc/passwd"));
  assert.equal(
    browserModifiers({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true }),
    13,
  );
});
