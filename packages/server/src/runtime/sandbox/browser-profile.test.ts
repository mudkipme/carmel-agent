import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareBrowserProfileScript } from "./browser-profile.ts";

test("fresh sandbox preparation removes stale singleton links without touching profile data or link targets", () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-profile-"));
  const profile = join(dir, "profile");
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(join(profile, "Default", "Cookies"), "saved sign-in data");
  const outside = join(dir, "socket-target");
  writeFileSync(outside, "do not follow links");
  symlinkSync("old-container-63", join(profile, "SingletonLock"));
  symlinkSync("12345", join(profile, "SingletonCookie"));
  symlinkSync(outside, join(profile, "SingletonSocket"));
  try {
    execFileSync(process.execPath, ["-e", prepareBrowserProfileScript, profile]);
    for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      assert.throws(() => lstatSync(join(profile, name)), { code: "ENOENT" });
    }
    assert.equal(readFileSync(join(profile, "Default", "Cookies"), "utf8"), "saved sign-in data");
    assert.equal(readFileSync(outside, "utf8"), "do not follow links");
    // Empty/new profiles and repeated preparation are harmless.
    execFileSync(process.execPath, ["-e", prepareBrowserProfileScript, profile]);
    execFileSync(process.execPath, ["-e", prepareBrowserProfileScript, join(dir, "missing")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profile preparation refuses unexpected lock files", () => {
  const profile = mkdtempSync(join(tmpdir(), "browser-profile-"));
  writeFileSync(join(profile, "SingletonCookie"), "keep this file");
  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, ["-e", prepareBrowserProfileScript, profile], {
          stdio: "pipe",
        }),
      /Unexpected browser profile lock type/,
    );
    assert.equal(readFileSync(join(profile, "SingletonCookie"), "utf8"), "keep this file");
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
