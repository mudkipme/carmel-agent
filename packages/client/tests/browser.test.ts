import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

type Fixture = {
  url: string;
  agentId: string;
  secondAgentId: string;
  reviewIssueId: string;
  backlogIssueId: string;
  previousSessionId: string;
  taskSessionId: string;
  taskName: string;
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
    execFileSync(
      binary,
      ["--session", session, "doctor", "--offline", "--quick"],
      { stdio: "ignore", timeout: 30_000 },
    );
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
function click(role: string, name: string, exact = true) {
  const selector =
    role === "button" ? "button" : role === "link" ? "a" : `[role="${role}"]`;
  browser(
    "wait",
    "--fn",
    `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(element => {
    const label = element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent.trim();
    return element.getClientRects().length && !element.closest("[inert]") && ${exact ? `label === ${JSON.stringify(name)}` : `label.includes(${JSON.stringify(name)})`};
  })`,
  );
  browser(
    "find",
    "role",
    role,
    "click",
    "--name",
    name,
    ...(exact ? ["--exact"] : []),
  );
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
    server = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/browser-preview.ts"],
      {
        cwd: fileURLToPath(new URL("../../server/", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
        const line = output
          .split("\n")
          .find((value) => value.startsWith('{"url":'));
        if (line) {
          clearTimeout(timeout);
          resolve(JSON.parse(line));
        }
      });
    });
    browser("open", fixture.url);
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
      const stopped = new Promise<void>((resolve) =>
        server!.once("exit", () => resolve()),
      );
      server.kill("SIGTERM");
      await stopped;
    }
  }
});

test("earlier issue conversations open the correct persisted session", () => {
  open(agentPath(`issues/${fixture.reviewIssueId}`));
  browser("wait", "--text", "Run history & issue events");
  browser("find", "text", "Run history & issue events", "click");
  browser("find", "text", "Run 1 · succeeded", "click");
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
  browser("wait", '[role="tab"][aria-selected="true"]');
  assert.match(snapshot(), /tab "Needs you" \[selected/);
  assert.equal(value('[aria-label="Search issues"]'), "guide");
  assert.match(
    browser<{ url: string }>("get", "url").url,
    /filter=attention&q=guide$/,
  );
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
  browser(
    "find",
    "label",
    "Instructions or feedback",
    "fill",
    "Please verify the setup commands",
  );
  click("link", "Tasks");
  open(agentPath(`issues/${fixture.reviewIssueId}`));
  browser("wait", "#issue-reply");
  assert.equal(value("#issue-reply"), "Please verify the setup commands");
  click("button", "Save note");
  browser(
    "wait",
    "--fn",
    'document.querySelector("#issue-reply").value === ""',
  );
  assert.equal(value("#issue-reply"), "");
});

test("long task titles and controls fit mobile; creation controls have accessible labels", () => {
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
  browser("find", "label", "Prompt", "fill", "Check the guide");
  assert.equal(value("#task-name"), "A labelled task");
  assert.equal(
    evaluate<boolean>(
      'Boolean(document.querySelector("#task-repeats").labels.length)',
    ),
    true,
  );
  const audit = browser<{ violations: { id: string }[] }>(
    "a11y",
    "--tags",
    "wcag2a,wcag2aa",
  );
  assert.deepEqual(audit.violations, []);
  click("button", "Cancel");
  browser("set", "viewport", "1440", "900");
});

test("existing tasks can be edited without changing their paused state", () => {
  open(agentPath("tasks"));
  click("button", `Edit ${fixture.taskName}`);
  assert.equal(value("#task-prompt"), "Review the guide.");
  assert.equal(value("#task-schedule"), "1440");
  browser(
    "find",
    "label",
    "Prompt",
    "fill",
    "Review the guide and verify backups.",
  );
  click("button", "Save task");
  browser("wait", "--fn", '!document.querySelector("#task-name")');
  click("button", `Edit ${fixture.taskName}`);
  assert.equal(value("#task-prompt"), "Review the guide and verify backups.");
  assert.match(browser<{ snapshot: string }>("snapshot").snapshot, /Paused/);
  click("button", "Cancel");
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
    assert.equal(
      evaluate<boolean>('document.body.innerText.includes("No queued work")'),
      false,
    );
  } finally {
    browser("network", "unroute", url);
  }
  click("button", "Retry");
  browser(
    "wait",
    "--fn",
    '!document.body.innerText.includes("Unable to load issues")',
  );
  click("tab", "Backlog");
  assert.match(snapshot(), /Explain backups/);
});

test("failed task loading can be retried and successful edits are not reported as failures when refresh fails", () => {
  const url = `${fixture.url}/api/agents/${fixture.agentId}/tasks`;
  browser("network", "route", url, "--abort");
  try {
    open(agentPath("tasks"));
    browser("wait", "--text", "Unable to load tasks");
    assert.equal(
      evaluate<boolean>(
        'document.body.innerText.includes("No scheduled tasks")',
      ),
      false,
    );
  } finally {
    browser("network", "unroute", url);
  }
  click("button", "Retry");
  browser("wait", "--text", fixture.taskName);
  click("button", `Edit ${fixture.taskName}`);
  browser(
    "find",
    "label",
    "Prompt",
    "fill",
    "An edit accepted before refresh fails.",
  );
  browser("network", "route", url, "--abort");
  try {
    click("button", "Save task");
    browser("wait", "--text", "Unable to load tasks");
    assert.equal(
      evaluate<boolean>(
        'document.body.innerText.includes("Unable to save task")',
      ),
      false,
    );
    assert.equal(
      evaluate<boolean>('Boolean(document.querySelector("#task-name"))'),
      false,
    );
  } finally {
    browser("network", "unroute", url);
  }
  click("button", "Retry");
  browser(
    "wait",
    "--fn",
    '!document.body.innerText.includes("Unable to load tasks")',
  );
  click("button", `Edit ${fixture.taskName}`);
  assert.equal(value("#task-prompt"), "An edit accepted before refresh fails.");
  click("button", "Cancel");
});
