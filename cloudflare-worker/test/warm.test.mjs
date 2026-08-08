// Regression tests for warmWinners().
//
// These exist because of a REAL silent failure on the Aug 6 2026 draw. The keeper logged
// {"action":"fired","call":"forward"} at 21:05:49 — proving the warm ran — and the public winners
// list still showed the previous week's draw 2h49m later. The old implementation was:
//
//   try { await fetch(WINNERS_URL + "?warm=1", {...}); } catch {}
//
// which cannot distinguish a 429, a 500, or a 200-that-did-not-actually-scan from success, and
// never retried. Every case below is one the old code would have called a success.

import { test } from "node:test";
import assert from "node:assert/strict";
import { warmWinners } from "../src/index.js";

/// Install a fake global fetch that replays `responses` in order. Returns the call count.
function stubFetch(responses) {
  const state = { calls: 0, urls: [] };
  globalThis.fetch = async (url) => {
    state.urls.push(String(url));
    const r = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.body === undefined) throw new Error("not json");
        return r.body;
      },
    };
  };
  return state;
}

const OK = { status: 200, body: { latestMissing: false, total: 5, complete: true } };
const STALE = { status: 200, body: { latestMissing: true, total: 4, complete: true } };

test("succeeds on the first attempt when the list is already current", async () => {
  const s = stubFetch([OK]);
  const r = await warmWinners(3, 0);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(s.calls, 1, "must not keep calling after success");
  assert.match(s.urls[0], /\/api\/winners\?warm=1$/);
});

test("HTTP 429 is a FAILURE, not a success (the old code called this fine)", async () => {
  stubFetch([{ status: 429 }]);
  const r = await warmWinners(1, 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /429/);
});

test("HTTP 500 is a failure", async () => {
  stubFetch([{ status: 500 }]);
  const r = await warmWinners(1, 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /500/);
});

test("a 200 whose scan did NOT catch the draw is a failure", async () => {
  // The exact Aug 6 shape: the request is served, returns 200, and the endpoint itself reports that
  // the vault has a completed draw it still does not have. Delivery succeeded; the outcome did not.
  stubFetch([STALE]);
  const r = await warmWinners(1, 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /still stale/);
});

test("retries a transient failure and reports the attempt it succeeded on", async () => {
  const s = stubFetch([{ status: 429 }, STALE, OK]);
  const r = await warmWinners(3, 0);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.equal(s.calls, 3);
});

test("gives up after the attempt budget rather than looping forever", async () => {
  const s = stubFetch([STALE]);
  const r = await warmWinners(3, 0);
  assert.equal(r.ok, false);
  assert.equal(s.calls, 3);
});

test("a thrown fetch never escapes — a warm failure must not break the draw", async () => {
  stubFetch([new Error("network down")]);
  const r = await warmWinners(2, 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /network down/);
});

test("an unparseable body is a failure, not a crash", async () => {
  stubFetch([{ status: 200 }]); // body undefined -> json() throws
  const r = await warmWinners(1, 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unparseable/);
});
