import test from "node:test";
import assert from "node:assert/strict";
import { groupSessions, limitGroups, matchesSessionQuery } from "./session-groups.ts";

const now = new Date(2026, 8, 19, 15, 0).getTime();
const at = (month: number, day: number, hour = 12, year = 2026) => new Date(year, month, day, hour).getTime();

test("sessions group into pinned, recency buckets, then months", () => {
  const groups = groupSessions(
    [
      { id: "old", title: "old", updatedAt: at(1, 3, 12, 2025) },
      { id: "today", title: "today", updatedAt: at(8, 19, 9) },
      { id: "pinned", title: "pinned", updatedAt: at(0, 1), pinnedAt: at(8, 1) },
      { id: "yesterday", title: "yesterday", updatedAt: at(8, 18, 23) },
      { id: "week", title: "week", updatedAt: at(8, 14) },
      { id: "month", title: "month", updatedAt: at(8, 1) },
      { id: "june", title: "june", updatedAt: at(5, 10) },
    ],
    now,
  );
  assert.deepEqual(
    groups.map((group) => [group.label, group.sessions.map((session) => session.id)]),
    [
      ["Pinned", ["pinned"]],
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
      ["Previous 7 days", ["week"]],
      ["Previous 30 days", ["month"]],
      ["June", ["june"]],
      ["February 2025", ["old"]],
    ],
  );
});

test("search needs every term, in any case and order", () => {
  assert.ok(matchesSessionQuery({ title: "Fix the Docker build" }, "docker fix"));
  assert.ok(!matchesSessionQuery({ title: "Fix the Docker build" }, "docker podman"));
  assert.ok(matchesSessionQuery({ title: "anything" }, "   "));
});

test("limiting keeps order across groups and counts what it left out", () => {
  const groups = [
    { label: "Today", sessions: [1, 2, 3] },
    { label: "Yesterday", sessions: [4, 5] },
    { label: "June", sessions: [6] },
  ];
  assert.deepEqual(limitGroups(groups, 4), {
    groups: [
      { label: "Today", sessions: [1, 2, 3] },
      { label: "Yesterday", sessions: [4] },
    ],
    hidden: 2,
  });
  assert.deepEqual(limitGroups(groups, 10).hidden, 0);
});
