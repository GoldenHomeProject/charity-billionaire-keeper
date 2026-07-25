// Unit tests for the keeper's action-selection logic.
//
// This is the safety-critical part of the Worker: it decides whether a tick fires the draw, heals a
// stalled VRF request, or sweeps the charity slice — and it must never pick the wrong one or spin.
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAction } from "../src/index.js";

const HOUR = 3600n;
const DAY = 86400n;

// A quiet baseline: draw not due for another day, nothing pending, no slice waiting.
const base = {
  now: 1_000_000n,
  nextDrawTime: 1_000_000n + DAY,
  lastDrawTime: 1_000_000n - DAY,
  pendingSince: 0n,
  staleTimeout: DAY,
  slice: 0n,
  drawPending: false,
  utcMinutes: 30,
};
const at = (o) => decideAction({ ...base, ...o });

test("quiet tick does nothing", () => {
  assert.equal(at({}).name, null);
});

test("fires the draw the moment it is due, and not a second before", () => {
  assert.equal(at({ nextDrawTime: base.now + 1n }).name, null);
  assert.equal(at({ nextDrawTime: base.now }).name, "requestDraw");
  assert.equal(at({ nextDrawTime: base.now - 1n }).name, "requestDraw");
});

test("requestDraw goes DIRECT to the vault so the bounty reaches the keeper wallet", () => {
  // Regression guard for the finding this rewrite fixes: routing the draw through DrawUpkeep2
  // made the CONTRACT the drawStarter, and it can never move an ERC-20 — every late-draw bounty
  // would be permanently stranded.
  assert.equal(at({ nextDrawTime: base.now }).on, "vault");
});

test("never re-requests while a VRF request is still in flight", () => {
  const s = { drawPending: true, pendingSince: base.now - HOUR, nextDrawTime: base.now - DAY };
  assert.equal(at(s).name, null, "a pending, not-yet-stale request must be left alone");
});

test("clears a stale VRF request exactly at the timeout", () => {
  const s = { drawPending: true, nextDrawTime: base.now - DAY };
  assert.equal(at({ ...s, pendingSince: base.now - DAY + 1n }).name, null);
  assert.equal(at({ ...s, pendingSince: base.now - DAY }).name, "cancelStaleDraw");
});

test("the draw outranks a waiting charity slice", () => {
  // The draw is time-critical; the forward can always wait for the next 5-minute tick.
  const d = at({ nextDrawTime: base.now, slice: 5_000n });
  assert.equal(d.name, "requestDraw");
});

test("forwards the charity slice on every tick for the first hour after a draw", () => {
  const d = at({ slice: 5_000n, lastDrawTime: base.now - 60n, utcMinutes: 37 });
  assert.equal(d.name, "forward");
  assert.equal(d.on, "forwarder");
});

test("backs off to hourly once the fast window closes", () => {
  // The bug this prevents: a forward that keeps reverting would otherwise retry 288x/day, draining
  // the gas wallet the DRAW also spends from — coupling the two failure domains.
  const stale = { slice: 5_000n, lastDrawTime: base.now - 3n * HOUR };
  assert.equal(at({ ...stale, utcMinutes: 37 }).name, null, "mid-hour tick must not retry");
  assert.equal(at({ ...stale, utcMinutes: 0 }).name, "forward", "top-of-hour tick retries");
  assert.equal(at({ ...stale, utcMinutes: 4 }).name, "forward");
  assert.equal(at({ ...stale, utcMinutes: 5 }).name, null);
});

test("raises the stuck alert once a slice has sat past the alert threshold", () => {
  assert.equal(at({ slice: 5_000n, lastDrawTime: base.now - HOUR }).stuck, false);
  assert.equal(at({ slice: 5_000n, lastDrawTime: base.now - 3n * HOUR }).stuck, true);
});

test("alerts even on a backed-off tick that takes no action", () => {
  // Otherwise a stuck slice would only page during the one retry tick per hour.
  const d = at({ slice: 5_000n, lastDrawTime: base.now - 3n * HOUR, utcMinutes: 37 });
  assert.equal(d.name, null);
  assert.equal(d.stuck, true);
});

test("a zero slice is never forwarded", () => {
  // forward() reverts with NothingToForward on an empty balance; spending gas to learn that is waste.
  assert.equal(at({ slice: 0n, lastDrawTime: base.now - 60n }).name, null);
});
