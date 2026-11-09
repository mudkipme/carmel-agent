import test from "node:test";
import assert from "node:assert/strict";
import { CARMEL_LINK_PLACEHOLDER, resolveCarmelLinks } from "@carmel-agent/shared";
import { carmelLinkInstructions, carmelPublicBaseUrl } from "./carmel-links.ts";

test("Carmel link instructions use a placeholder instead of the public URL", () => {
  const previous = process.env.CARMEL_PUBLIC_URL;
  process.env.CARMEL_PUBLIC_URL = "https://carmel.example.test/app/";
  try {
    const instructions = carmelLinkInstructions("agent_1");
    assert.ok(instructions.includes(`${CARMEL_LINK_PLACEHOLDER}/agents/agent_1/home`));
    assert.doesNotMatch(instructions, /https:\/\/carmel\.example\.test/);
  } finally {
    if (previous === undefined) delete process.env.CARMEL_PUBLIC_URL;
    else process.env.CARMEL_PUBLIC_URL = previous;
  }
});

test("resolveCarmelLinks uses the public base URL or an app-relative path", () => {
  const link = `${CARMEL_LINK_PLACEHOLDER}/agents/agent_1/home`;
  assert.equal(
    resolveCarmelLinks(link, "https://carmel.example.test/app/"),
    "https://carmel.example.test/app/agents/agent_1/home",
  );
  assert.equal(resolveCarmelLinks(link), "/agents/agent_1/home");
  assert.equal(resolveCarmelLinks("No link here.", "https://carmel.example.test"), "No link here.");
});

test("carmelPublicBaseUrl trims trailing slashes and rejects non-HTTP values", () => {
  const previous = process.env.CARMEL_PUBLIC_URL;
  try {
    process.env.CARMEL_PUBLIC_URL = "https://carmel.example.test/app/";
    assert.equal(carmelPublicBaseUrl(), "https://carmel.example.test/app");
    process.env.CARMEL_PUBLIC_URL = "ftp://carmel.example.test";
    assert.equal(carmelPublicBaseUrl(), undefined);
    delete process.env.CARMEL_PUBLIC_URL;
    assert.equal(carmelPublicBaseUrl(), undefined);
  } finally {
    if (previous === undefined) delete process.env.CARMEL_PUBLIC_URL;
    else process.env.CARMEL_PUBLIC_URL = previous;
  }
});
