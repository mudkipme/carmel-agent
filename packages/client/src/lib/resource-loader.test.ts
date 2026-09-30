import assert from "node:assert/strict";
import { test } from "node:test";
import { createResourceLoader } from "./resource-loader.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("overlapping polls share a request; explicit refresh supersedes a stale response", async () => {
  const requests: {
    signal: AbortSignal;
    result: ReturnType<typeof deferred<string>>;
  }[] = [];
  const published: unknown[] = [];
  const loader = createResourceLoader(
    (signal) => {
      const result = deferred<string>();
      requests.push({ signal, result });
      return result.promise;
    },
    (result) => published.push(result),
  );
  const old = loader.refresh();
  assert.equal(loader.refresh(), old);
  await Promise.resolve();
  const fresh = loader.refresh(true);
  await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.signal.aborted, true);
  requests[1]!.result.resolve("Updated");
  await fresh;
  requests[0]!.result.resolve("Stale");
  await old;
  assert.deepEqual(published, [{ data: "Updated" }]);
  loader.dispose();
});

test("disposing a resource cancels the request and never publishes after navigation", async () => {
  const result = deferred<string>();
  let signal: AbortSignal | undefined;
  const published: unknown[] = [];
  const loader = createResourceLoader(
    (requestSignal) => {
      signal = requestSignal;
      return result.promise;
    },
    (value) => published.push(value),
  );
  const pending = loader.refresh();
  await Promise.resolve();
  loader.dispose();
  result.resolve("Late response");
  await pending;
  assert.equal(signal?.aborted, true);
  assert.deepEqual(published, []);
  assert.equal(await loader.refresh(), undefined);
});

test("a failed read reports an error and can be retried without rejecting a successful mutation", async () => {
  let attempt = 0;
  const failure = new Error("Offline");
  const published: unknown[] = [];
  const loader = createResourceLoader(
    async () => {
      if (++attempt === 1) throw failure;
      return "Recovered";
    },
    (value) => published.push(value),
  );
  assert.equal(await loader.refresh(), undefined);
  assert.equal(await loader.refresh(true), "Recovered");
  assert.deepEqual(published, [{ error: failure }, { data: "Recovered" }]);
  loader.dispose();
});
