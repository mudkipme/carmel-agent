import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("production startup refuses missing or blank encryption keys before serving requests", () => {
  for (const key of ["", "   "]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/env.ts"], {
      env: { ...process.env, NODE_ENV: "production", CARMEL_SECRET_KEY: key },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CARMEL_SECRET_KEY is required in production/);
  }

  const configured = spawnSync(process.execPath, ["--import", "tsx", "src/env.ts"], {
    env: { ...process.env, NODE_ENV: "production", CARMEL_SECRET_KEY: "test-only-stable-key" },
    encoding: "utf8",
  });
  assert.equal(configured.status, 0, configured.stderr);
});
