import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { GitStatus, GitFileDiff } from "@carmel-agent/shared";

type Fixture = {
  url: string;
  agentId: string;
  secondAgentId: string;
  reviewIssueId: string;
  backlogIssueId: string;
  previousSessionId: string;
  pendingSessionId: string;
  taskSessionId: string;
  taskName: string;
  chatSessionId: string;
  questionSessionId: string;
  multipleQuestionSessionId: string;
  secretSessionId: string;
  declineSessionId: string;
  receiptSessionId: string;
};
const binary = process.env.AGENT_BROWSER_BIN ?? "agent-browser";
const session = `carmel-regression-${randomUUID()}`;
let server: ChildProcess | undefined;
let fixture: Fixture;

/** No shell interpolation, shared browser session, or production server bootstrap. */
function browser<T = Record<string, unknown>>(...args: string[]): T {
  let output: string;
  try {
    output = execFileSync(binary, ["--session", session, "--json", ...args], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2_000_000,
    });
  } catch (error) {
    execFileSync(binary, ["--session", session, "doctor", "--offline", "--quick"], {
      stdio: "ignore",
      timeout: 30_000,
    });
    for (const diagnostic of [
      ["get", "url"],
      ["snapshot", "-i"],
    ]) {
      try {
        process.stderr.write(
          execFileSync(binary, ["--session", session, ...diagnostic], {
            encoding: "utf8",
            timeout: 10_000,
          }),
        );
      } catch {
        // Diagnostics must not hide the original browser failure.
      }
    }
    throw error;
  }
  const response = JSON.parse(output) as {
    success: boolean;
    data: T;
    error?: string;
  };
  assert.equal(response.success, true, response.error);
  return response.data;
}
function waitForClickTarget(selector: string, name?: string, exact = true) {
  const waitId = randomUUID();
  browser(
    "wait",
    "--fn",
    `(() => {
      // agent-browser requires a boolean predicate; async predicates do not poll.
      if (window.carmelClickWait?.id !== ${JSON.stringify(waitId)}) {
        window.carmelClickWait = { id: ${JSON.stringify(waitId)}, bounds: new WeakMap() };
      }
      return Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(element => {
        const label = element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent.trim();
        if (!element.getClientRects().length || element.closest("[inert]") || element.matches(":disabled")) return false;
        if (!(${name === undefined ? "true" : exact ? `label === ${JSON.stringify(name)}` : `label.includes(${JSON.stringify(name)})`})) return false;
        // Avoid moving a visible option. Scrolling a Radix Select can reposition
        // its popup, so require the same bounds on consecutive polling checks.
        element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        const rect = element.getBoundingClientRect();
        const previous = window.carmelClickWait.bounds.get(element);
        window.carmelClickWait.bounds.set(element, rect);
        if (!previous || ["x", "y", "width", "height"].some(key => rect[key] !== previous[key])) return false;
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor.getAnimations().some(animation => animation.pending || animation.playState === "running")) return false;
        }
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit !== null && element.contains(hit);
      });
    })()`,
  );
}
function clickSelector(selector: string) {
  waitForClickTarget(selector);
  browser("click", selector);
}
function click(role: string, name: string, exact = true) {
  const selector = role === "button" ? "button" : role === "link" ? "a" : `[role="${role}"]`;
  waitForClickTarget(selector, name, exact);
  browser("find", "role", role, "click", "--name", name, ...(exact ? ["--exact"] : []));
}
function open(path: string) {
  browser("open", `${fixture.url}${path}`);
  browser("wait", 'button[title="Settings"]');
}
function agentPath(tail: string) {
  return `/agents/${fixture.agentId}/${tail}`;
}
function value(selector: string) {
  browser("wait", selector);
  return browser<{ value: string }>("get", "value", selector).value;
}
function evaluate<T>(script: string) {
  return browser<{ result: T }>("eval", script).result;
}
function snapshot() {
  return browser<{ snapshot: string }>("snapshot", "-i").snapshot;
}

before(
  async () => {
    server = spawn(process.execPath, ["--import", "tsx", "scripts/browser-preview.ts"], {
      cwd: fileURLToPath(new URL("../../server/", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    fixture = await new Promise<Fixture>((resolve, reject) => {
      let output = "";
      let errors = "";
      const timeout = setTimeout(
        () => reject(new Error(`Preview startup timed out: ${errors}`)),
        40_000,
      );
      server!.stderr!.on("data", (chunk) => {
        errors += String(chunk);
      });
      server!.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      server!.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Preview exited (${code}): ${errors}`));
      });
      server!.stdout!.on("data", (chunk) => {
        output += String(chunk);
        const line = output.split("\n").find((value) => value.startsWith('{"url":'));
        if (line) {
          clearTimeout(timeout);
          resolve(JSON.parse(line));
        }
      });
    });
    // Device emulation sets the user agent but does not enable a coarse pointer.
    browser("--args", "--blink-settings=primaryPointerType=2", "open", fixture.url);
    browser("wait", "--text", "Username");
    browser("find", "label", "Username", "fill", "browser-test");
    browser("find", "label", "Password", "fill", "browser-test-password");
    click("button", "Sign in");
    browser("wait", "--url", "**/agents/**");
  },
  { timeout: 60_000 },
);

after(async () => {
  try {
    browser("close");
  } finally {
    if (server && server.exitCode === null) {
      const stopped = new Promise<void>((resolve) => server!.once("exit", () => resolve()));
      server.kill("SIGTERM");
      await stopped;
    }
  }
});

test("questions, credentials, and browser help share a request area beside the composer", () => {
  browser("set", "viewport", "1280", "900");
  open(agentPath(`sessions/${fixture.questionSessionId}`));
  browser("wait", '[data-agent-request-area] [data-agent-request-kind="question"]');
  browser("wait", '[data-agent-request-area] [data-agent-request-kind="browser"]');
  browser("wait", "--fn", 'document.querySelector("[data-chat-history]").scrollTop > 0');
  assert.equal(
    evaluate(`(() => {
    const host = document.querySelector('.agent-chat-host');
    const area = host.querySelector('[data-agent-request-area]');
    return area.contains(host.querySelector('[data-agent-request-kind="question"]')) && area.contains(host.querySelector('[data-agent-request-kind="browser"]')) && !host.querySelector('[data-chat-history]').contains(area);
  })()`),
    true,
  );
  const position = () =>
    evaluate<{ top: number; bottom: number }>(`(() => {
    const rect = document.querySelector('.agent-chat-host [data-agent-request-area]').getBoundingClientRect();
    return {top:rect.top,bottom:rect.bottom};
  })()`);
  const before = position();
  evaluate(`document.querySelector('[data-chat-history]').scrollTop = 0`);
  assert.deepEqual(position(), before, "requests stay visible while earlier messages are read");
  for (const width of [390, 1280]) {
    browser("set", "viewport", String(width), "900");
    open(agentPath(`sessions/${fixture.secretSessionId}`));
    browser("wait", '[data-agent-request-area] input[type="password"]');
    assert.equal(
      evaluate(`(() => {
      const host = document.querySelector('.agent-chat-host').getBoundingClientRect();
      const area = document.querySelector('.agent-chat-host [data-agent-request-area]').getBoundingClientRect();
      return area.top >= host.top + host.height * 0.4 && area.bottom <= host.bottom + 1 && area.height <= host.height * 0.56;
    })()`),
      true,
      `request area stays near the composer at ${width}px`,
    );
    assert.equal(evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  }
  browser("fill", 'input[type="password"]', "unsent-private-request-draft");
  clickSelector('[data-agent-request-kind="browser"] button');
  browser("wait", '[aria-label="Agent browser"] [data-agent-request-area]');
  clickSelector('header button[aria-label="Close browser"]');
  browser("wait", '[data-agent-request-area] input[type="password"]');
  assert.equal(
    evaluate("document.querySelector('input[type=\"password\"]').value"),
    "unsent-private-request-draft",
    "opening browser assistance preserves an unsent credential in component memory",
  );
  browser("fill", 'input[type="password"]', "");
});

test(
  "question cards preserve requests across reloads and accept choices with text",
  { timeout: 60_000 },
  () => {
    browser("set", "viewport", "1280", "900");
    open(agentPath(`sessions/${fixture.questionSessionId}`));
    browser("wait", '[aria-label="Question from agent"]');
    assert.equal(
      evaluate(`document.querySelector('textarea[aria-label="Message"]').getClientRects().length`),
      0,
    );
    open(agentPath(`sessions/${fixture.questionSessionId}`));
    browser("wait", '[aria-label="Question from agent"]');
    clickSelector('button[aria-label="Main"]');
    browser("find", "label", "Your answer", "fill", "Use the stable branch.");
    click("button", "Submit answer");
    browser("wait", "--text", "Resume agent");
    open(agentPath(`sessions/${fixture.questionSessionId}`));
    browser("wait", "--text", "Use the stable branch.");
    assert.match(
      evaluate<string>(`document.querySelector('[aria-label="Question from agent"]').textContent`),
      /Main/,
    );
    assert.match(snapshot(), /Resume agent/);
  },
);

test(
  "multiple-choice and declined requests produce persisted continuation receipts",
  { timeout: 60_000 },
  () => {
    open(agentPath(`sessions/${fixture.multipleQuestionSessionId}`));
    browser("wait", '[aria-label="Question from agent"]');
    clickSelector('button[aria-label="Development"]');
    clickSelector('button[aria-label="Staging"]');
    click("button", "Submit answer");
    browser("wait", "--text", "Resume agent");
    const card = evaluate<string>(
      `document.querySelector('[aria-label="Question from agent"]').textContent`,
    );
    assert.match(card, /Development/);
    assert.match(card, /Staging/);
    open(agentPath(`sessions/${fixture.declineSessionId}`));
    browser("wait", '[aria-label="Question from agent"]');
    click("button", "Decline");
    browser("wait", "--text", "Resume agent");
    assert.match(
      evaluate<string>(`document.querySelector('[aria-label="Question from agent"]').textContent`),
      /cancelled/,
    );
  },
);

test(
  "credential cards save privately, promote and demote, and revoke without displaying values",
  { timeout: 90_000 },
  () => {
    open(agentPath(`sessions/${fixture.secretSessionId}`));
    browser("wait", 'input[type="password"]');
    const dummyToken = "ghp_browser_fixture_private_value";
    browser("fill", 'input[type="password"]', dummyToken);
    assert.equal(evaluate(`document.querySelector('input[type="password"]').autocomplete`), "off");
    click("button", "Provide credential");
    browser("wait", "--text", "This session only");
    browser("wait", "--text", "Resume agent");
    assert.ok(
      !evaluate<string>(`document.querySelector('.agent-chat-host').innerHTML`).includes(
        dummyToken,
      ),
    );
    open(agentPath(`sessions/${fixture.secretSessionId}`));
    browser("wait", "--text", "This session only");
    assert.equal(evaluate(`document.querySelectorAll('input[type="password"]').length`), 0);
    click("button", "Save for this agent");
    browser("wait", "--text", "Saved for this agent");
    open(agentPath(`sessions/${fixture.secretSessionId}`));
    browser("wait", "--text", "Saved for this agent");
    click("button", "Use in this session only");
    browser("wait", "--text", "This session only");
    click("button", "Revoke credential");
    browser("wait", "--text", "Credential revoked.");
    assert.ok(!evaluate<string>(`document.body.innerHTML`).includes(dummyToken));
  },
);

test("credential and question receipts render readable statuses after reload", () => {
  open(agentPath(`sessions/${fixture.receiptSessionId}`));
  browser("wait", '[data-testid="user-request-receipt"]');
  const receipts = () =>
    evaluate<string>(
      `Array.from(document.querySelectorAll('[data-testid="user-request-receipt"]')).map(element => element.innerText).join('\\n')`,
    );
  assert.match(receipts(), /GH_TOKEN/);
  assert.match(receipts(), /Credential provided/);
  assert.match(receipts(), /this session/);
  assert.match(receipts(), /Which branch\?/);
  assert.match(receipts(), /Main/);
  assert.doesNotMatch(
    receipts(),
    /Response to request|Secret reference|Internal question response/,
  );
  assert.equal(
    evaluate<number>(
      `document.querySelectorAll('[data-testid="user-request-receipt"] button').length`,
    ),
    0,
  );
  browser("reload");
  browser("wait", '[data-testid="user-request-receipt"]');
  assert.match(receipts(), /Credential provided/);
});

test(
  "reference picker selects files, folders, and conversations and restores rejected submissions",
  { timeout: 90_000 },
  () => {
    browser("set", "viewport", "1280", "900");
    open(agentPath(`sessions/${fixture.chatSessionId}`));
    // The sidebar loads before the session connection mounts the composer.
    browser("wait", 'textarea[aria-label="Message"]');
    browser("fill", 'textarea[aria-label="Message"]', "Review @");
    browser("wait", '[role="dialog"][aria-labelledby] [cmdk-input]');
    browser("fill", "[cmdk-input]", "docs/guide");
    browser("wait", '[cmdk-item][data-value="file:docs/guide.md"]');
    browser("press", "Enter");
    browser(
      "wait",
      "--fn",
      'document.querySelector("textarea[aria-label=Message]").value === "Review @docs/guide.md "',
    );
    click("button", "Mention a reference");
    browser("fill", "[cmdk-input]", "docs/");
    click("option", "Mention docs/");
    browser(
      "wait",
      "--fn",
      'document.querySelector("textarea[aria-label=Message]").value === "Review @docs/guide.md @docs/ "',
    );
    click("button", "Mention a reference");
    browser("fill", "[cmdk-input]", "Interrupted lookup");
    browser("press", "Enter");
    browser("wait", 'button[aria-label="Remove reference Interrupted lookup"]');
    assert.equal(
      evaluate<number>(
        `document.querySelectorAll('[aria-label="Selected references"] [data-slot="badge"]').length`,
      ),
      1,
    );
    evaluate(`void (window.referenceOriginalFetch = window.fetch); window.fetch = (input, init) => {
    if (String(input).endsWith('/run')) {
      window.referenceSubmission = JSON.parse(init.body);
      return Promise.resolve(Response.json({ error: 'Reference test rejection' }, { status: 400 }));
    }
    return window.referenceOriginalFetch(input, init);
  }`);
    try {
      click("button", "Send");
      browser("wait", "--text", "Reference test rejection");
      browser(
        "wait",
        "--fn",
        'document.querySelector("textarea[aria-label=Message]").value === "Review @docs/guide.md @docs/ "',
      );
      assert.deepEqual(evaluate("window.referenceSubmission.promptInput.references"), [
        { kind: "file", path: "docs/guide.md" },
        { kind: "folder", path: "docs" },
        {
          kind: "session",
          sessionId: fixture.pendingSessionId,
          agentId: fixture.agentId,
          label: "Interrupted lookup",
        },
      ]);
      browser("fill", 'textarea[aria-label="Message"]', "Review @docs/ ");
      click("button", "Send");
      browser(
        "wait",
        "--fn",
        'window.referenceSubmission.promptInput.references.length === 2 && document.querySelector("textarea[aria-label=Message]").value === "Review @docs/ "',
      );
      assert.deepEqual(evaluate("window.referenceSubmission.promptInput.references"), [
        { kind: "folder", path: "docs" },
        {
          kind: "session",
          sessionId: fixture.pendingSessionId,
          agentId: fixture.agentId,
          label: "Interrupted lookup",
        },
      ]);
    } finally {
      evaluate("window.fetch = window.referenceOriginalFetch");
    }
    browser("set", "viewport", "390", "844");
    click("button", "Mention a reference");
    browser("wait", "[cmdk-input]");
    assert.equal(
      evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth"),
      true,
    );
    browser("press", "Escape");
    browser("fill", 'textarea[aria-label="Message"]', "me@example.com");
    assert.equal(evaluate<number>('document.querySelectorAll("[role=dialog]").length'), 0);
    browser("set", "viewport", "1280", "900");
  },
);

test(
  "file and folder mentions stay at the cursor and restore focus without moving the draft suffix",
  { timeout: 90_000 },
  () => {
    browser("set", "viewport", "1280", "900");
    open(agentPath(`sessions/${fixture.chatSessionId}`));
    browser("wait", 'textarea[aria-label="Message"]');
    const expectCaret = (text: string, cursor: number) =>
      browser(
        "wait",
        "--fn",
        `(() => {
    const input = document.querySelector('textarea[aria-label="Message"]');
    return document.activeElement === input && input.value === ${JSON.stringify(text)} && input.selectionStart === ${cursor} && input.selectionEnd === ${cursor};
  })()`,
      );
    browser("fill", 'textarea[aria-label="Message"]', "Compare  with the current version.");
    evaluate('document.querySelector("textarea[aria-label=Message]").setSelectionRange(8, 8)');
    browser("keyboard", "type", "@");
    browser("wait", "[cmdk-input]");
    browser("fill", "[cmdk-input]", "docs/guide");
    browser("wait", '[cmdk-item][data-value="file:docs/guide.md"]');
    browser("press", "Enter");
    expectCaret(
      "Compare @docs/guide.md with the current version.",
      "Compare @docs/guide.md ".length,
    );
    browser("keyboard", "type", "alongside notes ");
    assert.equal(
      value('textarea[aria-label="Message"]'),
      "Compare @docs/guide.md alongside notes with the current version.",
    );

    browser("fill", 'textarea[aria-label="Message"]', "Inspect placeholder before making changes.");
    evaluate('document.querySelector("textarea[aria-label=Message]").setSelectionRange(8, 19)');
    click("button", "Mention a reference");
    browser("fill", "[cmdk-input]", "docs/");
    click("option", "Mention docs/");
    expectCaret("Inspect @docs/ before making changes.", "Inspect @docs/ ".length);
    browser("keyboard", "type", "carefully ");
    assert.equal(
      value('textarea[aria-label="Message"]'),
      "Inspect @docs/ carefully before making changes.",
    );

    browser("fill", 'textarea[aria-label="Message"]', "Compare  tomorrow.");
    evaluate('document.querySelector("textarea[aria-label=Message]").setSelectionRange(8, 8)');
    browser("keyboard", "type", "@");
    browser("wait", "[cmdk-input]");
    browser("press", "Escape");
    expectCaret("Compare @ tomorrow.", 9);
    browser("keyboard", "type", "person");
    assert.equal(value('textarea[aria-label="Message"]'), "Compare @person tomorrow.");
  },
);

test("tool disclosures preserve their output and fit desktop and mobile conversations", () => {
  for (const width of [1280, 390]) {
    browser("set", "viewport", String(width), "900");
    open(agentPath(`sessions/${fixture.chatSessionId}`));
    click("button", "Show work", false);
    assert.match(snapshot(), /1 failed/);
    click("button", "Run command", false);
    browser("wait", "--text", "All checks passed.");
    const output = evaluate<string>(
      `Array.from(document.querySelectorAll('.tool-call pre')).map(el => el.textContent).join('\\n')`,
    );
    assert.match(output, /<script>This is plain tool output, not markup\.<\/script>/);
    assert.match(snapshot(), /Copy input/);
    assert.match(snapshot(), /Copy output/);
    assert.equal(
      evaluate(`Array.from(document.querySelectorAll('.tool-call')).every(el => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    })`),
      true,
    );
    click("button", "Run command", false);
    assert.equal(evaluate(`document.querySelectorAll('.tool-call pre').length`), 0);
    click("button", "Hide work", false);
    assert.equal(evaluate(`document.querySelectorAll('.tool-call').length`), 0);
    assert.match(
      evaluate<string>(`document.querySelector('.agent-chat-host').textContent`),
      /A clearer path to deployment/,
    );
  }
  browser("set", "viewport", "1280", "900");
});

test("new chat drafts retain text, references, and images across navigation and reload", () => {
  browser("set", "viewport", "1280", "900");
  open(agentPath(""));
  browser("wait", 'textarea[aria-label="Message"]');
  browser("fill", 'textarea[aria-label="Message"]', "Keep my unfinished prompt");
  click("button", "Mention a reference");
  click("option", "workspace-review.md");
  evaluate(`(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'draft.png', {type:'image/png'}));
    document.querySelector('.chat-composer').dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:data}));
  })()`);
  browser("wait", 'button[aria-label="Remove draft.png"]');
  const text = value('textarea[aria-label="Message"]');
  click("link", "Tasks");
  click("button", "New session");
  assert.equal(value('textarea[aria-label="Message"]'), text);
  assert.match(snapshot(), /Remove draft.png/);
  browser("reload");
  browser("wait", 'textarea[aria-label="Message"]');
  assert.equal(value('textarea[aria-label="Message"]'), text);
  assert.match(snapshot(), /Remove draft.png/);
  open(`/agents/${fixture.secondAgentId}`);
  browser("wait", 'textarea[aria-label="Message"]');
  assert.equal(value('textarea[aria-label="Message"]'), "");
  open(agentPath(""));
  assert.equal(value('textarea[aria-label="Message"]'), text);
  browser("fill", 'textarea[aria-label="Message"]', "");
  click("button", "Remove draft.png");
});

test("agent settings fields have accessible names and navigation protects unsaved edits", () => {
  const openSettings = () => {
    click("button", "Agent settings");
    // The header mounts before the settings request finishes. Wait for the form itself.
    browser("wait", '[data-settings-content] input[id$="-description"]');
  };
  open(agentPath(""));
  // Hold the first real response so this also exercises a slow settings load on fast machines.
  evaluate(`(() => {
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (String(input).endsWith('/api/agents/${fixture.agentId}/settings')) {
        window.fetch = originalFetch;
        await new Promise(resolve => { window.releaseSettingsResponse = resolve; });
      }
      return response;
    };
  })()`);
  click("button", "Agent settings");
  browser("wait", "--fn", 'typeof window.releaseSettingsResponse === "function"');
  assert.match(evaluate<string>("document.body.innerText"), /Loading agent settings/);
  evaluate("window.releaseSettingsResponse()");
  browser("wait", '[data-settings-content] input[id$="-description"]');
  browser("find", "label", "Description", "fill", "Keep this settings draft");
  // A browser history exit is protected just like the app's Back button.
  browser("back");
  browser("wait", '[role="alertdialog"]');
  click("button", "Cancel");
  browser("wait", "--fn", 'document.querySelector("[role=alertdialog]") === null');
  assert.match(browser<{ url: string }>("get", "url").url, /settings\/general$/);
  const fields = snapshot();
  for (const name of ["Name", "Description", "System prompt"]) {
    assert.match(fields, new RegExp(`textbox "${name}"`));
  }
  for (const name of ["Working dir", "Default model", "Default thinking"]) {
    assert.match(fields, new RegExp(`combobox "${name}"`));
  }
  click("button", "Add mount");
  browser("find", "label", "Host path", "fill", "/tmp/unsaved-mount");
  browser("find", "label", "Container path", "fill", "/mount");
  click("button", "Remove mount");
  click("link", "Templates");
  assert.match(snapshot(), /textbox "Template name"/);
  assert.match(snapshot(), /textbox "Template text"/);
  click("link", "General");
  click("button", "Back to agent");
  browser("wait", '[role="alertdialog"]');
  click("button", "Cancel");
  browser("wait", "--fn", 'document.querySelector("[role=alertdialog]") === null');
  assert.equal(evaluate('document.querySelectorAll("[role=alertdialog]").length'), 0);
  assert.match(snapshot(), /Keep this settings draft/);
  assert.equal(
    evaluate(
      `(() => { const e = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; })()`,
    ),
    true,
  );
  const settingsUrl = `${fixture.url}/api/agents/${fixture.agentId}`;
  browser("network", "route", settingsUrl, "--abort");
  try {
    click("button", "Back to agent");
    click("button", "Save and leave");
    browser("wait", "--text", "Unable to save. Your changes are still here.");
    assert.match(browser<{ url: string }>("get", "url").url, /settings\/general$/);
  } finally {
    browser("network", "unroute", settingsUrl);
  }
  click("button", "Cancel");
  click("button", "Back to agent");
  click("button", "Discard changes");
  openSettings();
  assert.doesNotMatch(snapshot(), /Keep this settings draft/);
  browser("find", "label", "Description", "fill", "A saved settings description");
  click("button", "Back to agent");
  click("button", "Save and leave");
  browser("wait", "--url", `**/agents/${fixture.agentId}`);
  openSettings();
  assert.match(snapshot(), /A saved settings description/);
  browser("find", "label", "Description", "fill", "");
  click("button", "Save");
  browser("wait", "--text", "Agent saved.");
});

test("file navigation offers cancel, discard, and save; failed saves keep the draft", () => {
  open(agentPath(`files/workspace-review.md?chat=${fixture.chatSessionId}`));
  const edit = (text: string) => {
    click("tab", "Edit");
    browser("focus", "#workspace-pane .cm-content");
    browser("press", "Control+a");
    browser("keyboard", "inserttext", text);
  };
  edit("# A protected file draft");
  click("button", "Back to files");
  browser("wait", '[role="alertdialog"]');
  click("button", "Cancel");
  assert.match(
    evaluate<string>('document.querySelector(".cm-content").textContent'),
    /A protected file draft/,
  );
  const fileUrl = `${fixture.url}/api/agents/${fixture.agentId}/files/content`;
  browser("network", "route", `${fileUrl}*`, "--abort");
  try {
    click("button", "Back to files");
    click("button", "Save and leave");
    browser("wait", "--text", "Unable to save. Your changes are still here.");
    assert.match(browser<{ url: string }>("get", "url").url, /files\/workspace-review.md/);
  } finally {
    browser("network", "unroute", `${fileUrl}*`);
  }
  click("button", "Cancel");
  click("button", "Back to files");
  click("button", "Discard changes");
  clickSelector(
    '#workspace-pane [role="button"]:has(button[title="Actions for workspace-review.md"])',
  );
  browser("wait", "--text", "Updated draft.");
  edit("# A saved file draft");
  click("button", "Back to files");
  click("button", "Save and leave");
  browser("wait", 'button[title="Actions for workspace-review.md"]');
  clickSelector(
    '#workspace-pane [role="button"]:has(button[title="Actions for workspace-review.md"])',
  );
  browser("wait", "--text", "A saved file draft");
  edit("# Workspace review\n\nUpdated draft.\n");
  click("button", "Save");
  browser(
    "wait",
    "--fn",
    'document.querySelector("#workspace-pane button[aria-label=Save]").disabled',
  );
});

test("mobile settings keep the selected section visible and permission labels toggle their switches", (t) => {
  t.after(() => browser("set", "viewport", "1280", "900"));
  const waitForSelectedSection = (section: string) => {
    // The URL can change before React commits the new selection and scrolls
    // the navigation. Wait for that visible state without scrolling it ourselves.
    browser(
      "wait",
      "--fn",
      `(() => {
        const active = document.querySelector('nav a[aria-current="page"][href$="/settings/${section}"]');
        if (!active) return false;
        const rect = active.getBoundingClientRect();
        const nav = active.closest('nav').getBoundingClientRect();
        return rect.width > 0 && rect.left >= Math.max(0, nav.left) && rect.right <= Math.min(innerWidth, nav.right);
      })()`,
    );
  };
  browser("set", "viewport", "320", "740");
  browser("open", `${fixture.url}/settings/appearance`);
  browser("wait", "#appearance-theme");
  waitForSelectedSection("appearance");
  click("link", "Account");
  browser("wait", "#account-email");
  assert.equal(evaluate("document.documentElement.scrollWidth <= innerWidth"), true);

  browser("open", `${fixture.url}${agentPath("settings/permissions")}`);
  browser("wait", '[role="switch"]');
  assert.match(snapshot(), /switch "Write files".*checked/);
  browser("find", "text", "Write files", "click", "--exact");
  assert.equal(
    evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find(el => el.textContent === 'Write files');
    return document.getElementById(label.htmlFor).getAttribute('aria-checked');
  })()`),
    "false",
  );
  browser("find", "text", "Write files", "click", "--exact");
  assert.match(snapshot(), /switch "Write files".*checked/);
  click("link", "Archived");
  browser("wait", "--url", "**/settings/archived");
  waitForSelectedSection("archived");
  assert.equal(evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  click("button", "Back to agent");
  open(agentPath("issues"));
  browser("wait", '[role="tab"]');
  assert.equal(
    evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).every(el => {
    const rect = el.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth;
  })`),
    true,
  );
});

test("private integrations show QR setup, cancel it, and persist proactive messaging controls on mobile", (t) => {
  t.after(() => browser("set", "viewport", "1280", "900"));
  browser("set", "viewport", "320", "740");
  browser("open", `${fixture.url}${agentPath("settings/integrations")}`);
  browser("wait", "#telegram-proactive");
  assert.equal(
    evaluate(
      'document.querySelector(\'[aria-label="Telegram integration"]\').textContent.includes("Carmel test bot")',
    ),
    true,
  );
  browser("wait", 'img[alt="Scan to create your Feishu or Lark bot"]');
  assert.equal(evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  clickSelector("#telegram-proactive");
  browser(
    "wait",
    "--fn",
    'document.querySelector("#telegram-proactive").getAttribute("aria-checked") === "false"',
  );
  browser("open", `${fixture.url}${agentPath("settings/integrations")}`);
  browser(
    "wait",
    "--fn",
    'document.querySelector("#telegram-proactive")?.getAttribute("aria-checked") === "false"',
  );
  click("button", "Cancel setup");
  browser(
    "wait",
    "--fn",
    "!document.querySelector('img[alt=\"Scan to create your Feishu or Lark bot\"]')",
  );
  clickSelector('[aria-label="Feishu integration"] button:last-child');
  browser("wait", "#feishu-app-secret");
  assert.equal(evaluate('document.querySelector("#feishu-app-secret").type'), "password");
  assert.equal(evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  clickSelector("#telegram-proactive");
});

test("earlier issue conversations open the correct persisted session", () => {
  open(agentPath(`issues/${fixture.reviewIssueId}`));
  browser("wait", "--text", "Run history & issue events");
  // Target the summary: a text locator can match the enclosing details and click its content.
  clickSelector("summary.text-muted-foreground");
  evaluate(`Array.from(document.querySelectorAll('summary'))
    .find(element => element.textContent.startsWith('Run 1 · succeeded')).click()`);
  click("link", "Earlier conversation");
  browser("wait", "--url", `**/sessions/${fixture.previousSessionId}`);
  assert.equal(
    browser<{ url: string }>("get", "url").url,
    `${fixture.url}${agentPath(`sessions/${fixture.previousSessionId}`)}`,
  );
});

test("returning from an issue preserves the selected tab and search", () => {
  open(agentPath("issues"));
  click("tab", "Needs you");
  browser("find", "label", "Search issues", "fill", "guide");
  click("link", "Review the deployment guide", false);
  click("link", "Browser test agent / Issues");
  browser("wait", '[role="tab"][aria-label="Needs you"][aria-selected="true"]');
  assert.match(snapshot(), /tab "Needs you" \[selected/);
  assert.equal(value('[aria-label="Search issues"]'), "guide");
  assert.match(browser<{ url: string }>("get", "url").url, /filter=attention&q=guide$/);
});

test("new issue drafts survive navigation and reload, remain scoped to their agent, and clear on cancel", () => {
  open(agentPath("issues/new"));
  browser("find", "label", "Title", "fill", "Keep my unfinished brief");
  browser("find", "label", "Details", "fill", "Keep the context too");
  click("link", "Tasks");
  click("link", "Issues");
  click("link", "New issue");
  assert.equal(value("#issue-title"), "Keep my unfinished brief");
  browser("reload");
  browser("wait", "#issue-title");
  assert.equal(value("#issue-description"), "Keep the context too");
  open(`/agents/${fixture.secondAgentId}/issues/new`);
  browser("wait", "#issue-title");
  assert.equal(value("#issue-title"), "");
  open(agentPath("issues/new"));
  browser("wait", "#issue-title");
  assert.equal(value("#issue-title"), "Keep my unfinished brief");
  click("button", "Cancel");
  click("link", "New issue");
  assert.equal(value("#issue-title"), "");
});

test("saved issue drafts clear only after the server accepts them", () => {
  open(agentPath("issues/new"));
  browser("find", "label", "Title", "fill", "A saved backlog brief");
  click("button", "Save to backlog");
  browser("wait", "--text", "Edit brief");
  click("link", "Browser test agent / Issues");
  click("link", "New issue");
  assert.equal(value("#issue-title"), "");
});

test("issue replies survive leaving the conversation and clear after saving", () => {
  open(agentPath(`issues/${fixture.reviewIssueId}`));
  browser("wait", "#issue-reply");
  browser("find", "label", "Instructions or feedback", "fill", "Please verify the setup commands");
  click("link", "Tasks");
  open(agentPath(`issues/${fixture.reviewIssueId}`));
  browser("wait", "#issue-reply");
  assert.equal(value("#issue-reply"), "Please verify the setup commands");
  click("button", "Save note");
  browser("wait", "--fn", 'document.querySelector("#issue-reply").value === ""');
  assert.equal(value("#issue-reply"), "");
});

test("long task titles and controls fit mobile; creation controls have accessible labels", (t) => {
  t.after(() => browser("set", "viewport", "1440", "900"));
  browser("set", "viewport", "390", "844");
  open(agentPath("tasks"));
  browser("wait", "--text", fixture.taskName);
  assert.equal(
    evaluate<boolean>(
      'Array.from(document.querySelectorAll("li button")).every(button => { const bounds = button.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth; })',
    ),
    true,
  );
  assert.match(snapshot(), /Edit Review/);
  click("button", "New task");
  browser("find", "label", "Name", "fill", "A labelled task");
  // Sample the first enabled frame in the same browser call as the input event.
  // CLI latency otherwise hides an opacity fade from the disabled appearance.
  const enabledAppearance = evaluate<{ disabled: boolean; opacity: string }>(`(async () => {
    const prompt = document.querySelector('#task-prompt');
    const submit = document.querySelector('button[type="submit"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(prompt, 'Check the guide');
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    for (let frame = 0; frame < 60; frame++) {
      await new Promise(requestAnimationFrame);
      if (!submit.disabled) break;
    }
    return { disabled: submit.disabled, opacity: getComputedStyle(submit).opacity };
  })()`);
  assert.deepEqual(enabledAppearance, { disabled: false, opacity: "1" });
  assert.equal(value("#task-name"), "A labelled task");
  assert.equal(
    evaluate<boolean>('Boolean(document.querySelector("#task-repeats").labels.length)'),
    true,
  );
  const audit = browser<{ violations: { id: string }[] }>("a11y", "--tags", "wcag2a,wcag2aa");
  assert.deepEqual(audit.violations, []);
  click("button", "Cancel");
});

test("existing tasks can be edited without changing their paused state", () => {
  open(agentPath("tasks"));
  click("button", `Edit ${fixture.taskName}`);
  assert.equal(value("#task-prompt"), "Review the guide.");
  assert.equal(value("#task-schedule"), "1440");
  browser("find", "label", "Prompt", "fill", "Review the guide and verify backups.");
  click("button", "Save task");
  browser("wait", "--fn", '!document.querySelector("#task-name")');
  click("button", `Edit ${fixture.taskName}`);
  assert.equal(value("#task-prompt"), "Review the guide and verify backups.");
  assert.match(browser<{ snapshot: string }>("snapshot").snapshot, /Paused/);
  click("button", "Cancel");
});

test("workspace layout keeps chat and editor drafts mounted while resizing, expanding, and narrowing", (t) => {
  t.after(() => {
    browser("set", "viewport", "1440", "900");
    evaluate('localStorage.setItem("carmel-workspace-mode", "split")');
  });
  browser("set", "viewport", "1440", "900");
  open(agentPath(`sessions/${fixture.chatSessionId}`));
  // The shell is ready before the asynchronous session connection mounts the composer.
  browser("wait", ".agent-chat-host textarea");
  browser("fill", ".agent-chat-host textarea", "Keep this conversation draft");
  evaluate(
    'void (window.workspaceChatInput = document.querySelector(".agent-chat-host textarea"))',
  );
  click("button", "Browse files");
  browser("wait", '[data-workspace-layout="split"]');
  assert.match(browser<{ url: string }>("get", "url").url, /chat=browser-chat-session/);
  clickSelector(
    '#workspace-pane [role="button"]:has(button[title="Actions for workspace-review.md"])',
  );
  click("tab", "Edit");
  browser("wait", "#workspace-pane .cm-content");
  browser(
    "wait",
    "--fn",
    'document.querySelector("#workspace-pane .cm-content").textContent.includes("Updated draft.")',
  );
  browser("focus", "#workspace-pane .cm-content");
  browser("press", "Control+a");
  browser("keyboard", "type", "An unsaved workspace draft");
  evaluate('void (window.workspaceEditor = document.querySelector("#workspace-pane .cm-content"))');
  const width = () =>
    evaluate<number>('document.querySelector("#workspace-pane").getBoundingClientRect().width');
  const originalWidth = width();
  browser("focus", 'button[aria-label="Resize workspace pane"]');
  browser("press", "ArrowLeft");
  assert.equal(width(), originalWidth + 20);
  const divider = evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector('button[aria-label="Resize workspace pane"]').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  browser("mouse", "move", String(divider.x), String(divider.y));
  browser("mouse", "down");
  browser("mouse", "move", String(divider.x - 30), String(divider.y));
  browser("mouse", "up");
  assert.equal(width(), originalWidth + 50);
  const resizedWidth = width();
  const checkDrafts = () => {
    assert.equal(
      evaluate<boolean>(
        'window.workspaceChatInput === document.querySelector(".agent-chat-host textarea")',
      ),
      true,
    );
    assert.equal(
      evaluate<boolean>(
        'window.workspaceEditor === document.querySelector("#workspace-pane .cm-content")',
      ),
      true,
    );
    assert.equal(
      evaluate<string>("window.workspaceChatInput.value"),
      "Keep this conversation draft",
    );
    assert.equal(
      evaluate<string>('document.querySelector("#workspace-pane .cm-content").textContent'),
      "An unsaved workspace draft",
    );
  };
  click("button", "Expand files");
  browser("wait", '[data-workspace-layout="full"]');
  checkDrafts();
  assert.equal(
    evaluate<number>('document.querySelector("#workspace-conversation").getClientRects().length'),
    0,
  );
  click("button", "Show beside chat");
  browser("wait", '[data-workspace-layout="split"]');
  checkDrafts();
  assert.equal(width(), resizedWidth);
  browser("set", "viewport", "390", "844");
  browser("wait", '[data-workspace-layout="full"]');
  checkDrafts();
  assert.equal(evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"), true);
  browser("set", "viewport", "1440", "900");
  browser("wait", '[data-workspace-layout="split"]');
  checkDrafts();
  assert.equal(width(), resizedWidth);
  click("button", "Expand files");
  // The reload is intentional; first explicitly discard the editor draft.
  click("button", "Discard");
  browser("reload");
  browser("wait", '[data-workspace-layout="full"]');
  browser(
    "wait",
    "--fn",
    'document.querySelector("#workspace-conversation .agent-chat-host textarea") !== null',
  );
  click("tab", "Edit");
  browser("wait", "#workspace-pane .cm-content");
  assert.match(
    evaluate<string>('document.querySelector("#workspace-pane .cm-content").textContent'),
    /Updated draft/,
  );
  assert.match(
    evaluate<string>('document.querySelector("#workspace-conversation").textContent'),
    /A clearer path to deployment/,
  );
  click("button", "Show beside chat");
  assert.equal(width(), resizedWidth);
  evaluate(
    'void (window.restoredWorkspaceEditor = document.querySelector("#workspace-pane .cm-content"))',
  );
  click("button", "New session");
  browser("wait", "--fn", 'new URL(location.href).searchParams.get("chat") === "new"');
  browser("wait", "--text", "What can Browser test agent help with?");
  assert.equal(
    evaluate<boolean>(
      'window.restoredWorkspaceEditor === document.querySelector("#workspace-pane .cm-content")',
    ),
    true,
  );
  browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Open session Make the deployment guide easier to follow",
    "--exact",
  );
  browser(
    "wait",
    "--fn",
    'new URL(location.href).searchParams.get("chat") === "browser-chat-session"',
  );
  assert.equal(
    evaluate<boolean>(
      'window.restoredWorkspaceEditor === document.querySelector("#workspace-pane .cm-content")',
    ),
    true,
  );
  click("button", "Close workspace");
  browser("wait", "--url", `**/sessions/${fixture.chatSessionId}`);
});

test("Markdown previews render workspace documents and preserve drafts, undo history, saving, and relative resources", (t) => {
  t.after(() => browser("set", "viewport", "1440", "900"));
  browser("set", "viewport", "1440", "900");
  open(agentPath(`files/docs/guide.md?chat=${fixture.chatSessionId}`));
  browser("wait", '#workspace-pane [role="tabpanel"][data-state="active"] h1');
  const previewText = () =>
    evaluate<string>(
      'document.querySelector("#workspace-pane [role=tabpanel][data-state=active]").textContent',
    );
  assert.match(previewText(), /Preview guide/);
  assert.equal(
    evaluate<string>(
      'document.querySelector("#workspace-pane [role=tab][aria-selected=true]").textContent',
    ),
    "Preview",
  );
  assert.equal(
    evaluate<string>(
      'document.querySelector("#workspace-pane .markdown-content strong").textContent',
    ),
    "formatted",
  );
  assert.equal(
    evaluate<number>('document.querySelectorAll("#workspace-pane .markdown-content table").length'),
    1,
  );
  assert.match(
    evaluate<string>('document.querySelector("#workspace-pane .markdown-content pre").textContent'),
    /const ready = true/,
  );
  assert.equal(evaluate<boolean>("window.markdownPreviewExecuted === true"), false);
  browser(
    "wait",
    "--fn",
    `document.querySelector('#workspace-pane img[alt="A local diagram"]')?.naturalWidth > 0`,
  );
  const resource = evaluate<string>(
    'document.querySelector("#workspace-pane img").getAttribute("src")',
  );
  assert.equal(new URL(resource, fixture.url).searchParams.get("path"), "docs/diagram.svg");
  assert.match(
    evaluate<string>('document.querySelector("#workspace-pane a").getAttribute("href")'),
    /files\/docs\/notes.markdown\?chat=browser-chat-session$/,
  );

  const readSavedFile = () =>
    evaluate<string>(
      `fetch(${JSON.stringify(`${fixture.url}/api/agents/${fixture.agentId}/files/content?path=docs%2Fguide.md`)}).then(response => response.json()).then(file => file.content)`,
    );
  const original = readSavedFile();
  const draft =
    "# Revised guide\n\nStill **unsaved**.\n\n[Related notes](notes.markdown)\n\n![A local diagram](diagram.svg)\n";
  click("tab", "Edit");
  browser("wait", "#workspace-pane .cm-content");
  evaluate('void (window.markdownEditor = document.querySelector("#workspace-pane .cm-content"))');
  browser("focus", "#workspace-pane .cm-content");
  browser("press", "Control+a");
  browser("keyboard", "inserttext", draft);
  click("tab", "Preview");
  browser(
    "wait",
    "--fn",
    'document.querySelector("#workspace-pane .markdown-content h1")?.textContent === "Revised guide"',
  );
  assert.match(
    evaluate<string>('document.querySelector("#workspace-pane").textContent'),
    /Unsaved changes/,
  );
  assert.equal(readSavedFile(), original);
  click("tab", "Edit");
  assert.equal(
    evaluate<boolean>(
      'window.markdownEditor === document.querySelector("#workspace-pane .cm-content")',
    ),
    true,
  );
  browser("focus", "#workspace-pane .cm-content");
  browser("press", "Control+z");
  click("tab", "Preview");
  assert.match(previewText(), /Preview guide/);
  click("tab", "Edit");
  browser("focus", "#workspace-pane .cm-content");
  browser("press", "Control+y");
  click("tab", "Preview");
  assert.match(previewText(), /Revised guide/);
  click("button", "Save");
  browser(
    "wait",
    "--fn",
    'document.querySelector("#workspace-pane button[aria-label=Save]")?.disabled',
  );
  assert.equal(readSavedFile(), draft);

  browser("reload");
  browser(
    "wait",
    "--fn",
    'document.querySelector("#workspace-pane .markdown-content h1")?.textContent === "Revised guide"',
  );
  click("tab", "Edit");
  browser("focus", "#workspace-pane .cm-content");
  browser("press", "Control+a");
  browser("keyboard", "inserttext", "# Throw away this draft");
  click("tab", "Preview");
  assert.match(previewText(), /Throw away/);
  click("button", "Discard");
  assert.match(previewText(), /Revised guide/);
  assert.equal(readSavedFile(), draft);

  for (const width of [320, 390, 1440]) {
    browser("set", "viewport", String(width), "900");
    assert.equal(
      evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"),
      true,
      `Markdown preview at ${width}px`,
    );
    const overflow = evaluate<boolean>(`(() => {
      const pane = document.querySelector('#workspace-pane').getBoundingClientRect();
      return [...document.querySelectorAll('#workspace-pane [data-slot=tabs] > div:first-child button')].some(button => {
        const rect = button.getBoundingClientRect();
        return rect.left < pane.left || rect.right > pane.right;
      });
    })()`);
    assert.equal(overflow, false, `Markdown toolbar at ${width}px`);
  }
  click("link", "Related notes");
  browser(
    "wait",
    "--fn",
    'document.querySelector("#workspace-pane .markdown-content h1")?.textContent === "Related notes"',
  );
  assert.match(
    browser<{ url: string }>("get", "url").url,
    /notes.markdown\?chat=browser-chat-session$/,
  );
  open(agentPath("files/docs/plain.txt"));
  browser("wait", "#workspace-pane .cm-content");
  assert.equal(
    evaluate<number>('document.querySelectorAll("#workspace-pane [role=tablist]").length'),
    0,
  );
  browser(
    "wait",
    "--fn",
    'document.querySelector("#workspace-pane .cm-content").textContent.includes("Plain text stays editable.")',
  );
});

test("Changes uses its pane width and keeps the selected diff and conversation in navigation", (t) => {
  // Exercise the client at its Git API boundary; the fixture deliberately has
  // no container runtime. Git execution/security has separate server coverage.
  const statusUrl = `${fixture.url}/api/agents/${fixture.agentId}/git/status`;
  const diffUrl = `${fixture.url}/api/agents/${fixture.agentId}/git/diff*`;
  const status: GitStatus = {
    repository: true,
    branch: "workspace-review",
    changes: [
      {
        path: "workspace-review.md",
        workspacePath: "workspace-review.md",
        area: "unstaged",
        kind: "modified",
      },
    ],
    truncated: false,
  };
  const diff: GitFileDiff = {
    path: "workspace-review.md",
    area: "unstaged",
    original: { kind: "text", text: "# Workspace review\n\nOriginal draft.\n" },
    modified: { kind: "text", text: "# Workspace review\n\nUpdated draft.\n" },
  };
  browser("network", "route", statusUrl, "--body", JSON.stringify(status));
  browser("network", "route", diffUrl, "--body", JSON.stringify(diff));
  t.after(() => {
    browser("network", "unroute", statusUrl);
    browser("network", "unroute", diffUrl);
  });
  browser("set", "viewport", "1440", "900");
  open(agentPath(`sessions/${fixture.chatSessionId}`));
  click("button", "Uncommitted changes");
  browser("wait", '[data-workspace-layout="split"]');
  clickSelector('#workspace-pane button[title="workspace-review.md"]');
  browser("wait", "#workspace-pane .diff-viewer .cm-editor");
  assert.equal(
    evaluate<number>('document.querySelectorAll("#workspace-pane .cm-mergeView").length'),
    0,
  );
  assert.match(
    browser<{ url: string }>("get", "url").url,
    /area=unstaged&chat=browser-chat-session/,
  );
  click("button", "Expand changes");
  browser("wait", "#workspace-pane .cm-mergeView");
  click("button", "Show beside chat");
  browser("wait", "--fn", '!document.querySelector("#workspace-pane .cm-mergeView")');
  click("button", "All changes");
  browser("wait", '#workspace-pane button[title="workspace-review.md"]');
  clickSelector('#workspace-pane button[title="workspace-review.md"]');
  browser("wait", "#workspace-pane .diff-viewer .cm-editor");
  click("button", "Open file");
  click("tab", "Edit");
  browser("wait", "#workspace-pane .cm-content");
  assert.match(
    browser<{ url: string }>("get", "url").url,
    /files\/workspace-review.md\?chat=browser-chat-session/,
  );
  click("button", "Open terminal");
  browser("wait", "#workspace-pane .xterm");
  evaluate('void (window.workspaceTerminal = document.querySelector("#workspace-pane .xterm"))');
  click("button", "Expand terminal");
  assert.equal(
    evaluate<boolean>(
      'window.workspaceTerminal === document.querySelector("#workspace-pane .xterm")',
    ),
    true,
  );
  click("button", "Show beside chat");
  assert.equal(
    evaluate<boolean>(
      'window.workspaceTerminal === document.querySelector("#workspace-pane .xterm")',
    ),
    true,
  );
  click("button", "Close workspace");
});

test("browser handoff survives reload, supports navigation, and resumes explicitly", () => {
  open(agentPath(""));
  browser("wait", "--text", "Please sign in to the billing portal.");
  // The assistance callout and header both open the same pane.
  clickSelector('header button[aria-label="Open browser"]');
  browser(
    "wait",
    "--fn",
    'document.querySelector("#browser-address")?.value === "https://example.test/login?stream=live"',
  );
  browser(
    "wait",
    "--fn",
    'Array.from(document.querySelectorAll("button")).some(b => b.textContent === "Take control" && !b.disabled)',
  );
  click("button", "Take control");
  browser("wait", "--text", "You have control");
  assert.equal(
    evaluate(
      `Boolean(document.querySelector('[aria-label="Agent browser"] [data-agent-request-area] [data-agent-request-kind="browser"]'))`,
    ),
    true,
  );
  assert.equal(
    evaluate(
      `document.querySelector('[aria-label="Agent browser"] [data-agent-request-area] button').textContent`,
    ),
    "Resume agent",
  );
  click("button", "Expand browser");
  browser("wait", "--text", "You have control");
  click("button", "Show beside chat");
  browser("wait", "--text", "You have control");
  browser("find", "label", "Browser address", "fill", "example.test/account");
  click("button", "Go");
  browser(
    "wait",
    "--fn",
    'document.querySelector("#browser-address").value === "https://example.test/account"',
  );
  browser("reload");
  browser("wait", "--text", "Waiting for help");
  click("button", "Take control");
  browser("wait", "--text", "You have control");
  click("button", "Resume agent");
  browser("wait", "--text", "Agent has control");
  click("button", "Expand browser");
  assert.equal(
    evaluate<string>('document.querySelector("[data-workspace-layout]").dataset.workspaceLayout'),
    "full",
  );
  click("button", "Show beside chat");
  browser("set", "viewport", "390", "844");
  assert.equal(evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"), true);
  const audit = browser<{ violations: { id: string }[] }>("a11y", "--tags", "wcag2a,wcag2aa");
  assert.deepEqual(audit.violations, []);
  clickSelector('header button[aria-label="Close browser"]');
  browser("set", "viewport", "1440", "900");
});

test("browser clipboard controls and shortcuts transfer text without adding chat messages", () => {
  open(agentPath(""));
  clickSelector('header button[aria-label="Open browser"]');
  browser(
    "wait",
    "--fn",
    'Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Take control" && !button.disabled)',
  );
  click("button", "Take control");
  browser("wait", "--text", "You have control");
  // Device clipboard permissions vary; exercise both successful access and its manual fallback.
  evaluate(`Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{
    readText:async () => 'First line 🌍\\n第二行',
    writeText:async text => {window.carmelCopied = text;}
  }});`);
  click("button", "Paste");
  browser("wait", "--text", "Pasted into browser");
  click("button", "Copy selection");
  browser("wait", "--fn", `window.carmelCopied === 'First line 🌍\\n第二行'`);
  evaluate(
    `window.carmelCopied = ''; document.querySelector('textarea[aria-label="Remote browser keyboard input"]').focus();`,
  );
  browser("press", "Control+c");
  browser("wait", "--fn", `window.carmelCopied === 'First line 🌍\\n第二行'`);
  evaluate(
    `const data = new DataTransfer(); data.setData('text/plain','Pasted with keyboard 🌍'); document.querySelector('textarea[aria-label="Remote browser keyboard input"]').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));`,
  );
  browser(
    "wait",
    "--fn",
    'Array.from(document.querySelectorAll("button")).some(button => button.textContent.includes("Copy selection") && !button.disabled)',
  );
  click("button", "Copy selection");
  browser("wait", "--fn", `window.carmelCopied === 'Pasted with keyboard 🌍'`);
  evaluate(
    `navigator.clipboard.readText = async () => {throw new Error('Permission denied')}; navigator.clipboard.writeText = async () => {throw new Error('Permission denied')};`,
  );
  click("button", "Paste");
  browser("wait", "#browser-text");
  browser("fill", "#browser-text", "Manual fallback\nmultiline");
  click("button", "Send text");
  browser("wait", "--fn", 'document.querySelector("#browser-text").value === ""');
  click("button", "Copy selection");
  browser("wait", "#browser-copied-text");
  assert.equal(
    evaluate('document.querySelector("#browser-copied-text").value'),
    "Manual fallback\nmultiline",
  );
  assert.ok(
    !evaluate<string>('document.querySelector(".agent-chat-host").innerText').includes(
      "Manual fallback",
    ),
  );
  click("button", "Resume agent");
  browser("wait", "--text", "Agent has control");
  assert.equal(evaluate('document.querySelector("#browser-copied-text")'), null);
  clickSelector('header button[aria-label="Close browser"]');
});

test("a task conversation returns to its run history and keeps it open after reload", () => {
  open(agentPath(`sessions/${fixture.taskSessionId}`));
  click("link", "Run history");
  browser("wait", "--url", "**/tasks?task=browser-task");
  click("link", "Open conversation");
  browser("wait", "--url", `**/sessions/${fixture.taskSessionId}`);
  click("link", "Run history");
  browser("reload");
  browser("wait", "--text", "Open conversation");
  assert.equal(
    evaluate<boolean>(
      `Boolean(document.querySelector('button[aria-label^="Run history for"][aria-expanded="true"]'))`,
    ),
    true,
  );
});

test("failed issue loading shows an error and Retry instead of an empty list", () => {
  const url = `${fixture.url}/api/agents/${fixture.agentId}/issues`;
  browser("network", "route", url, "--abort");
  try {
    open(agentPath("issues"));
    browser("wait", "--text", "Unable to load issues");
    assert.match(snapshot(), /button "Retry"/);
    assert.equal(evaluate<boolean>('document.body.innerText.includes("No queued work")'), false);
  } finally {
    browser("network", "unroute", url);
  }
  click("button", "Retry");
  browser("wait", "--fn", '!document.body.innerText.includes("Unable to load issues")');
  click("tab", "Backlog");
  // Retry clears the error before the response and route transition finish.
  browser("wait", `[role="tabpanel"] a[href^="${agentPath(`issues/${fixture.backlogIssueId}`)}"]`);
  assert.match(snapshot(), /Explain backups/);
});

test("failed task loading can be retried and successful edits are not reported as failures when refresh fails", () => {
  const url = `${fixture.url}/api/agents/${fixture.agentId}/tasks`;
  browser("network", "route", url, "--abort");
  try {
    open(agentPath("tasks"));
    browser("wait", "--text", "Unable to load tasks");
    assert.equal(
      evaluate<boolean>('document.body.innerText.includes("No scheduled tasks")'),
      false,
    );
  } finally {
    browser("network", "unroute", url);
  }
  click("button", "Retry");
  browser("wait", "--text", fixture.taskName);
  click("button", `Edit ${fixture.taskName}`);
  browser("find", "label", "Prompt", "fill", "An edit accepted before refresh fails.");
  browser("network", "route", url, "--abort");
  try {
    click("button", "Save task");
    browser("wait", "--text", "Unable to load tasks");
    assert.equal(
      evaluate<boolean>('document.body.innerText.includes("Unable to save task")'),
      false,
    );
    assert.equal(evaluate<boolean>('Boolean(document.querySelector("#task-name"))'), false);
  } finally {
    browser("network", "unroute", url);
  }
  click("button", "Retry");
  browser("wait", "--fn", '!document.body.innerText.includes("Unable to load tasks")');
  click("button", `Edit ${fixture.taskName}`);
  assert.equal(value("#task-prompt"), "An edit accepted before refresh fails.");
  click("button", "Cancel");
});

test("chat controls fit narrow touch screens with reasoning and long model names", () => {
  assert.equal(evaluate<boolean>('matchMedia("(pointer: coarse)").matches'), true);
  for (const path of [agentPath(""), agentPath(`sessions/${fixture.taskSessionId}`)]) {
    open(path);
    browser("wait", ".agent-chat-host textarea");
    for (const [width, height] of [
      [320, 740],
      [390, 844],
      [430, 932],
      [844, 390],
      [1440, 900],
    ]) {
      browser("set", "viewport", String(width), String(height));
      const failures = evaluate<string[]>(`(() => {
        const failures = [];
        const composer = document.querySelector('.agent-chat-host textarea').parentElement;
        const bounds = composer.getBoundingClientRect();
        const controls = [...composer.querySelectorAll('button, [role="combobox"]')]
          .filter(element => element.getClientRects().length)
          .map(element => ({ element, rect: element.getBoundingClientRect(), label: element.getAttribute('aria-label') || element.title }));
        if (controls.length < 5) failures.push('Missing composer controls');
        for (const [index, control] of controls.entries()) {
          const { rect, label, element } = control;
          if (rect.left < bounds.left || rect.right > bounds.right || rect.top < bounds.top || rect.bottom > bounds.bottom) failures.push(label + ' outside composer');
          if (rect.height < 40) failures.push(label + ' below touch height');
          for (const child of element.querySelectorAll('svg, span')) {
            const childRect = child.getBoundingClientRect();
            if (childRect.width && (childRect.left < rect.left || childRect.right > rect.right)) failures.push(label + ' has overflowing content');
          }
          for (const other of controls.slice(index + 1)) {
            if (rect.left < other.rect.right && rect.right > other.rect.left && rect.top < other.rect.bottom && rect.bottom > other.rect.top) failures.push(label + ' overlaps ' + other.label);
          }
        }
        if (innerWidth === 1440 && controls.some(control => control.rect.top !== controls[0].rect.top)) failures.push('Desktop toolbar wraps');
        if (document.documentElement.scrollWidth > innerWidth) failures.push('Page overflows horizontally');
        if (document.querySelector('header h2').getBoundingClientRect().width < 40) failures.push('Header title is squeezed out');
        return failures;
      })()`);
      assert.deepEqual(failures, [], `${path} at ${width}×${height}`);
    }
    // Sample the first layout after a workspace-sized resize in the same browser
    // call, so CLI latency cannot hide briefly overflowing animated controls.
    const resizeFailures = evaluate<string[]>(`(() => {
      const composer = document.querySelector('.agent-chat-host textarea').parentElement;
      const modelButton = composer.querySelector('button[aria-label^="Choose model"]');
      const originalWidth = composer.style.width;
      modelButton.getBoundingClientRect();
      composer.style.width = '280px';
      try {
        const bounds = modelButton.getBoundingClientRect();
        return [...modelButton.querySelectorAll('svg, span')].filter(child => {
          const rect = child.getBoundingClientRect();
          return rect.width && (rect.left < bounds.left || rect.right > bounds.right);
        }).map(child => child.tagName + ' overflows the model chooser during resize');
      } finally {
        composer.style.width = originalWidth;
      }
    })()`);
    assert.deepEqual(resizeFailures, [], `${path} during composer resize`);
    browser("set", "viewport", "320", "740");
    click("combobox", "Thinking level");
    click("option", "high");
    browser(
      "wait",
      "--fn",
      'document.querySelector(\'[role="combobox"][aria-label="Thinking level"]\')?.textContent.trim() === "high"',
    );
    assert.match(snapshot(), /combobox "Thinking level".*high/);
    clickSelector('.agent-chat-host button[aria-label^="Choose model"]');
    browser("wait", '[role="dialog"]');
    assert.match(browser<{ snapshot: string }>("snapshot").snapshot, /Select Model/);
    browser("press", "Escape");
    browser("find", "placeholder", "Type a message...", "fill", "A mobile draft");
    assert.equal(
      browser<{ enabled: boolean }>("is", "enabled", 'button[aria-label="Send"]').enabled,
      true,
    );
  }
});

test(
  "a restarted session offers recovery and Stop clears its pending checkpoint",
  { timeout: 60_000 },
  () => {
    browser("set", "viewport", "375", "812");
    open(agentPath(`sessions/${fixture.pendingSessionId}`));
    browser("wait", "--text", "This conversation has unfinished work.");
    assert.match(snapshot(), /button "Resume"/);
    assert.match(snapshot(), /button "Stop"/);
    assert.equal(
      evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth"),
      true,
    );
    click("button", "Stop");
    browser(
      "wait",
      "--fn",
      "!document.body.innerText.includes('This conversation has unfinished work.')",
    );
    browser("reload");
    browser("wait", 'textarea[placeholder="Type a message..."]');
    assert.doesNotMatch(snapshot(), /button "Resume"/);
    assert.equal(
      evaluate<number>("document.querySelectorAll('.agent-chat-host textarea').length"),
      1,
    );
  },
);

test(
  "knowledge settings and shared memories remain editable after reloading",
  { timeout: 90_000 },
  () => {
    browser("set", "viewport", "1280", "900");
    open(agentPath("knowledge"));
    browser("wait", "--text", "Knowledge is off");
    assert.doesNotMatch(snapshot(), /link "Knowledge"/);
    click("link", "Knowledge settings");
    browser("wait", "--url", `**${agentPath("settings/knowledge")}`);
    browser("wait", "#knowledge-model");
    assert.equal(evaluate<string>('document.querySelector("h1").textContent'), "Agent Settings");
    assert.equal(evaluate<number>('document.querySelectorAll("footer button").length'), 0);
    assert.equal(evaluate<boolean>('document.querySelector("#knowledge-model").readOnly'), true);
    clickSelector("#knowledge-enabled");
    click("option", "On");
    click("button", "Save settings");
    browser("wait", "--text", "Knowledge settings saved.");
    browser("open", `${fixture.url}${agentPath("settings/knowledge")}`);
    browser("wait", "#knowledge-enabled");
    assert.match(snapshot(), /combobox "Knowledge and memory".*On/);
    click("link", "General");
    click("link", "Knowledge");
    browser("wait", "#knowledge-enabled");
    click("link", "Open knowledge");
    browser("wait", `nav[aria-label="Agent work"] a[href="${agentPath("knowledge")}"]`);
    open(`/agents/${fixture.secondAgentId}/knowledge`);
    browser("wait", "--text", "Knowledge is off");
    assert.doesNotMatch(snapshot(), /link "Knowledge"/);
    open(agentPath("knowledge"));
    browser("wait", `nav[aria-label="Agent work"] a[href="${agentPath("knowledge")}"]`);
    click("button", "New memory");
    browser("find", "label", "Title", "fill", "Family budget meeting");
    browser("find", "label", "Memory", "fill", "Alice and Bob review their budget on Sunday.");
    click("button", "Save memory");
    browser("wait", "--text", "Alice and Bob review their budget on Sunday.");
    open(agentPath("knowledge"));
    click("button", "Edit memory");
    assert.equal(value("#memory-content").trim(), "Alice and Bob review their budget on Sunday.");
    browser("fill", "#memory-content", "Alice and Bob review their budget on Monday.");
    click("button", "Save memory");
    browser("wait", "--text", "Alice and Bob review their budget on Monday.");
    browser("set", "viewport", "375", "812");
    assert.equal(
      evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth"),
      true,
    );
    click("button", "Forget memory");
    browser("wait", '[role="alertdialog"]');
    clickSelector('[role="alertdialog"] button[data-variant="destructive"]');
    browser("wait", "--text", "No saved memories");
    browser("set", "viewport", "1280", "900");
    click("link", "Knowledge settings");
    browser("wait", "#knowledge-enabled");
    clickSelector("#knowledge-enabled");
    click("option", "Off");
    click("button", "Save settings");
    browser("wait", "--text", "Knowledge settings saved.");
    click("link", "Open knowledge");
    browser("wait", "--text", "Knowledge is off");
    assert.doesNotMatch(snapshot(), /link "Knowledge"/);
  },
);
