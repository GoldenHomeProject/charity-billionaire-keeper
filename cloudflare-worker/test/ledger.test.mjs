// Tests for the keeper's winners ledger (src/ledger.js).
//
// The ledger replaced history-scanning as the source of the public winners list after that design
// broke the list repeatedly (RPC range caps, Base's 2 s -> 0.2 s block change, rate limits). These
// tests pin the parts that must never regress: finding a block by timestamp WITHOUT assuming a
// block time, reading the draw from that block's receipts, never inventing entries, and the
// watchdog that makes any future outage loud instead of silent.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findFirstBlockAt, readDrawAt, forwardsFromReceipt, mergeInto, emptyLedger, syncLedger,
  recordForward, loadLedger, newestSettled, findGaps, winnersProblems, rpcChain,
  LEDGER_KEY, VAULT, FORWARDER, TOPIC_PRIZE, TOPIC_SKIPPED, TOPIC_FORWARDED,
} from "../src/ledger.js";

const hex = (n) => "0x" + Number(n).toString(16);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const topicAddr = (a) => "0x" + "0".repeat(24) + a.slice(2);
const TX = (i) => "0x" + String(i).padStart(64, "a");

/// A fake chain whose block time changes partway (2 s, then 0.2 s with five blocks per second),
/// like Base in Nov 2026. `events` maps block number -> logs.
function fakeChain({ switchAt = 1_000_000, head = 1_400_000, t0 = 1_700_000_000, events = {} } = {}) {
  const ts = (n) => (n <= switchAt ? t0 + n * 2 : t0 + switchAt * 2 + Math.floor((n - switchAt) / 5));
  const calls = { block: 0, receipts: 0, receipt: 0 };
  return {
    calls, ts,
    async block(n) {
      calls.block++;
      const k = n === undefined ? head : n;
      if (k > head) throw new Error("past head");
      return { number: k, timestamp: ts(k) };
    },
    async blockReceipts(n) {
      calls.receipts++;
      const logs = events[n] || [];
      return logs.map((l) => ({ status: "0x1", transactionHash: l.transactionHash, blockNumber: hex(n), logs: [l] }));
    },
    async receipt(hash) {
      calls.receipt++;
      for (const [n, logs] of Object.entries(events)) {
        const l = logs.find((x) => x.transactionHash === hash);
        if (l) return { status: "0x1", transactionHash: hash, blockNumber: hex(n), logs: [l] };
      }
      return null;
    },
  };
}

const WINNER = "0x602ac3231946d7d8bb5015a5e6c4f130c7cf671e";
const prizeLog = (n, i = 18, tx = TX(1)) => ({
  address: VAULT, topics: [TOPIC_PRIZE, topicAddr(WINNER), topicAddr(FORWARDER)],
  data: "0x" + word(34984) + word(1943) + word(1943), transactionHash: tx, blockNumber: hex(n), logIndex: hex(i),
});

test("findFirstBlockAt: exact first block of a second, after a 2 s -> 0.2 s block-time change", async () => {
  const c = fakeChain();
  for (const n of [1_200_003, 1_200_000, 1_000_000, 999_999, 500_000, 1_399_999, 1_000_001]) {
    const r = await findFirstBlockAt(c, c.ts(n));
    assert.equal(c.ts(r.n), c.ts(n));
    assert.ok(r.n === 0 || c.ts(r.n - 1) < c.ts(n), `block ${r.n} is not the first of its second`);
    assert.ok(r.probes <= 30);
  }
});

test("findFirstBlockAt: a timestamp after the head throws instead of guessing", async () => {
  const c = fakeChain();
  await assert.rejects(findFirstBlockAt(c, c.ts(1_400_000) + 5), /after the chain head/);
});

test("readDrawAt: finds the prize in the 3rd block of its second, decodes it, corroborates it", async () => {
  const drawBlock = 1_200_002; // blocks 1_200_000..1_200_004 share one second
  const c = fakeChain({ events: { [drawBlock]: [prizeLog(drawBlock)] } });
  const got = await readDrawAt(c, c.ts(drawBlock));
  assert.equal(got.draws.length, 1);
  assert.deepEqual(got.draws[0], {
    block: drawBlock, index: 18, tx: TX(1), ts: c.ts(drawBlock),
    winner: WINNER, charity: FORWARDER, winnerAmount: "34984", charityAmount: "1943",
  });
  assert.equal(got.times[drawBlock], c.ts(drawBlock));
  assert.equal(c.calls.receipt, 1, "every recorded event is confirmed by its own receipt");
  assert.equal(got.blocksRead, 3, "stops at the block that has the event");
});

test("readDrawAt: records a skipped week (DrawSkipped) as a skip, not a draw", async () => {
  const n = 1_300_000;
  const skip = { address: VAULT, topics: [TOPIC_SKIPPED], data: "0x" + word(32) + word(7) + "6e6f207969656c64".padEnd(64, "0"), transactionHash: TX(2), blockNumber: hex(n), logIndex: hex(3) };
  const c = fakeChain({ events: { [n]: [skip] } });
  const got = await readDrawAt(c, c.ts(n));
  assert.equal(got.draws.length, 0);
  assert.equal(got.skips.length, 1);
});

test("readDrawAt: ignores foreign and malformed logs, and a log the receipt does not confirm throws", async () => {
  const n = 1_250_000;
  const foreign = { ...prizeLog(n, 5, TX(3)), address: "0x" + "1".repeat(40) };
  const short = { ...prizeLog(n, 6, TX(4)), data: "0x" + word(1) };
  const c = fakeChain({ events: { [n]: [foreign, short] } });
  const got = await readDrawAt(c, c.ts(n));
  assert.equal(got.draws.length + got.skips.length, 0);

  const c2 = fakeChain({ events: { [n]: [prizeLog(n)] } });
  c2.receipt = async () => ({ status: "0x1", blockNumber: hex(n), logs: [] }); // RPC disagrees
  await assert.rejects(readDrawAt(c2, c2.ts(n)), /receipt check/);
});

test("forwardsFromReceipt: decodes CharityForwarded; a reverted forward yields nothing", () => {
  const r = {
    status: "0x1", transactionHash: TX(5), blockNumber: hex(62773934),
    logs: [{ address: FORWARDER, topics: [TOPIC_FORWARDED, "0x39352d3138333131313600000000000000000000000000000000000000000000", topicAddr("0x081f2b4a06aeb311e54ad9115519883060de0b1e")], data: "0x" + word(1943), logIndex: hex(118) }],
  };
  assert.deepEqual(forwardsFromReceipt(r), [{
    block: 62773934, index: 118, tx: TX(5),
    orgId: "0x39352d3138333131313600000000000000000000000000000000000000000000",
    org: "0x081f2b4a06aeb311e54ad9115519883060de0b1e",
  }]);
  assert.deepEqual(forwardsFromReceipt({ ...r, status: "0x0" }), []);
});

function fakeKV(initial = null) {
  const store = new Map(initial ? [[LEDGER_KEY, JSON.stringify(initial)]] : []);
  return { store, puts: 0, async get(k) { return store.get(k) ?? null; }, async put(k, v) { this.puts++; store.set(k, v); } };
}

test("syncLedger: records the missing draw once; a second run writes nothing", async () => {
  const n = 1_200_002;
  const c = fakeChain({ events: { [n]: [prizeLog(n)] } });
  const kv = fakeKV();
  const r1 = await syncLedger(kv, c, c.ts(n));
  assert.equal(r1.ok, true);
  assert.ok(r1.recorded > 0);
  assert.equal(kv.puts, 1);
  const r2 = await syncLedger(kv, c, c.ts(n));
  assert.equal(r2.recorded, 0);
  assert.equal(kv.puts, 1, "an up-to-date ledger costs one read and no write");
  const l = await loadLedger(kv);
  assert.equal(newestSettled(l), c.ts(n));
});

test("syncLedger: no event at lastDrawTime -> not ok, nothing written (never invents a draw)", async () => {
  const c = fakeChain();
  const kv = fakeKV();
  const r = await syncLedger(kv, c, c.ts(1_200_000));
  assert.equal(r.ok, false);
  assert.equal(kv.puts, 0);
});

test("recordForward: waits for the receipt, then appends the forward without touching the draws", async () => {
  const kv = fakeKV({ ...emptyLedger(), draws: [{ block: 1, index: 1, tx: TX(9), ts: 5 }], times: { 1: 5 } });
  let n = 0;
  const chain = {
    async receipt() {
      if (++n < 2) return null; // not mined on the first poll
      return { status: "0x1", transactionHash: TX(6), blockNumber: hex(10), logs: [{ address: FORWARDER, topics: [TOPIC_FORWARDED, "0x" + "3".repeat(64), topicAddr("0x" + "2".repeat(40))], data: "0x" + word(9), logIndex: hex(2) }] };
    },
  };
  const r = await recordForward(kv, chain, TX(6), { attempts: 3, delayMs: 1 });
  assert.equal(r.ok, true);
  const l = await loadLedger(kv);
  assert.equal(l.forwards.length, 1);
  assert.equal(l.draws.length, 1);
});

test("mergeInto: dedupes by tx:index and ignores bad timestamps", () => {
  const a = emptyLedger();
  const e = { block: 7, index: 1, tx: TX(7) };
  assert.equal(mergeInto(a, { draws: [e], times: { 7: 100, 8: undefined, 9: "x" } }), 2);
  assert.equal(mergeInto(a, { draws: [{ ...e, tx: TX(7).toUpperCase().replace("0X", "0x") }] }), 0);
  assert.deepEqual(a.times, { 7: 100 });
});

test("findGaps: weekly cadence and a one-day-late draw are fine; a missing week is flagged", () => {
  const W = 7 * 86400;
  assert.deepEqual(findGaps([0, W, 2 * W + 86400, 3 * W]), []);
  assert.deepEqual(findGaps([0, W, 3 * W]), [[W, 3 * W]]);
});

test("winnersProblems: quiet when healthy, specific when not", () => {
  const ldt = 1_795_744_830;
  const W = 7 * 86400;
  const healthy = { latestMissing: false, draws: [ldt, ldt - W, ldt - 2 * W].map((d) => ({ date: d, charity: "0x" + "9".repeat(40), viaForwarder: true })) };
  assert.deepEqual(winnersProblems({ lastDrawTime: ldt, nowSec: ldt + 7200 + 1, ledgerNewest: ldt, publicBody: healthy }), []);

  // Inside the first hour nothing is "late" yet.
  assert.deepEqual(winnersProblems({ lastDrawTime: ldt, nowSec: ldt + 600, ledgerNewest: ldt - W, publicBody: { ...healthy, latestMissing: true } }), []);

  const p = winnersProblems({
    lastDrawTime: ldt, nowSec: ldt + 3 * 3600, ledgerNewest: ldt - W,
    publicBody: { latestMissing: true, draws: [{ date: ldt, charity: FORWARDER, viaForwarder: true }, { date: null }, { date: ldt - 3 * W }] },
  });
  assert.equal(p.length, 5, p.join("\n"));
  assert.match(p.join("\n"), /keeper has not recorded/);
  assert.match(p.join("\n"), /missing the .* draw/);
  assert.match(p.join("\n"), /no charity name/);
  assert.match(p.join("\n"), /no date/);
  assert.match(p.join("\n"), /a week is missing/);

  assert.match(winnersProblems({ lastDrawTime: ldt, nowSec: ldt + 7200, ledgerNewest: ldt, publicBody: null }).join(), /could not be read/);
});

test("winnersProblems: the launch-era Jul 10 -> Jul 20 2026 gap never alarms", () => {
  const jul10 = 1783645549, jul20 = 1784539833, jul24 = 1784854833;
  const body = { latestMissing: false, draws: [jul24, jul20, jul10].map((d) => ({ date: d })) };
  assert.deepEqual(winnersProblems({ lastDrawTime: jul24, nowSec: jul24 + 86400, ledgerNewest: jul24, publicBody: body }), []);
});

test("rpcChain: fails over on ANY error, including the 'invalid params' viem would stop at", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(new URL(url).host);
    if (url.includes("a.test")) return { ok: true, text: async () => JSON.stringify({ error: { message: "Invalid parameters" } }) };
    if (url.includes("b.test")) return { ok: false, status: 429, text: async () => "" };
    return { ok: true, text: async () => JSON.stringify({ result: { number: "0x10", timestamp: "0x20" } }) };
  };
  const c = rpcChain(["https://a.test", "https://b.test", "https://c.test"], fetchImpl);
  assert.deepEqual(await c.block(16), { number: 16, timestamp: 32 });
  assert.deepEqual(seen, ["a.test", "b.test", "c.test"]);
});

test("rpcChain: block receipts without the vault address skip the parse; with it, they parse", async () => {
  const body = (s) => ({ ok: true, text: async () => s });
  const miss = rpcChain(["https://x.test"], async () => body('{"jsonrpc":"2.0","id":1,"result":[{"logs":[]}]}'));
  assert.deepEqual(await miss.blockReceipts(5, VAULT), []);
  const hit = rpcChain(["https://x.test"], async () => body(JSON.stringify({ result: [{ logs: [{ address: VAULT }] }] })));
  assert.equal((await hit.blockReceipts(5, VAULT)).length, 1);
  // An error body must not be mistaken for "no vault logs here".
  const err = rpcChain(["https://x.test"], async () => body('{"error":{"message":"limit"}}'));
  await assert.rejects(err.blockReceipts(5, VAULT), /limit/);
});

// ---- Vault V2 ----------------------------------------------------------------------------
import { settlementsFromReceipt, recordSettle, TOPIC_PAYOUT_RECORDED, TOPIC_PAYOUT_SETTLED } from "../src/ledger.js";
const V2 = "0x" + "5e".repeat(20);
const ORG = "0x" + "0e".repeat(20);
const v2Logs = (n, tx, { paid = 15, id = 4 } = {}) => [
  { address: V2, topics: [TOPIC_PAYOUT_RECORDED, "0x" + word(id), topicAddr(WINNER)], data: "0x" + "39".repeat(32), transactionHash: tx, blockNumber: hex(n), logIndex: hex(10) },
  { address: V2, topics: [TOPIC_PRIZE, topicAddr(WINNER), topicAddr(ORG)], data: "0x" + word(34984) + word(1943) + word(1943), transactionHash: tx, blockNumber: hex(n), logIndex: hex(11) },
  { address: V2, topics: [TOPIC_PAYOUT_SETTLED, "0x" + word(id)], data: "0x" + word(paid), transactionHash: tx, blockNumber: hex(n), logIndex: hex(14) },
];
function fakeChainMulti(events) {
  const c = fakeChain();
  c.blockReceipts = async (n) => {
    const logs = events[n] || [];
    const byTx = new Map();
    for (const l of logs) { if (!byTx.has(l.transactionHash)) byTx.set(l.transactionHash, []); byTx.get(l.transactionHash).push(l); }
    return [...byTx].map(([h, ls]) => ({ status: "0x1", transactionHash: h, blockNumber: hex(n), logs: ls }));
  };
  c.receipt = async (hash) => {
    for (const [n, logs] of Object.entries(events)) {
      const ls = logs.filter((x) => x.transactionHash === hash);
      if (ls.length) return { status: "0x1", transactionHash: hash, blockNumber: hex(n), logs: ls };
    }
    return null;
  };
  return c;
}

test("V2: a finalizeDraw is recorded from the V2 address with its payout id and paid status", async () => {
  const n = 1_200_001;
  const c = fakeChainMulti({ [n]: v2Logs(n, TX(8), { paid: 13 }) });
  const got = await readDrawAt(c, c.ts(n), V2);
  assert.equal(got.draws.length, 1);
  assert.equal(got.draws[0].charity, ORG, "V2 names the Endaoment org directly, no forwarder");
  assert.equal(got.draws[0].payoutId, 4);
  assert.equal(got.draws[0].paid, 13);
  // The V1 address finds nothing in a V2 block.
  assert.equal((await readDrawAt(c, c.ts(n))).draws.length, 0);
});

test("V2: settle() receipts only ever ADD paid bits to the matching payout", async () => {
  const kv = fakeKV({ ...emptyLedger(), draws: [{ block: 1, index: 11, tx: TX(8), ts: 5, payoutId: 4, paid: 13 }, { block: 2, index: 11, tx: TX(9), ts: 6, payoutId: 5, paid: 15 }], times: { 1: 5, 2: 6 } });
  const receipt = (paid, id = 4) => ({ status: "0x1", logs: [{ address: V2, topics: [TOPIC_PAYOUT_SETTLED, "0x" + word(id)], data: "0x" + word(paid) }] });
  assert.deepEqual(settlementsFromReceipt(receipt(15), V2), [{ payoutId: 4, paid: 15 }]);
  assert.deepEqual(settlementsFromReceipt({ ...receipt(15), status: "0x0" }, V2), []);
  assert.deepEqual(settlementsFromReceipt(receipt(15), VAULT), [], "another vault's event is ignored");
  let r = await recordSettle(kv, { receipt: async () => receipt(15) }, TX(7), V2, { attempts: 1 });
  assert.equal(r.updated, 1);
  assert.equal((await loadLedger(kv)).draws[0].paid, 15);
  r = await recordSettle(kv, { receipt: async () => receipt(1) }, TX(7), V2, { attempts: 1 }); // stale replay
  assert.equal(r.updated, 0);
  assert.equal((await loadLedger(kv)).draws[0].paid, 15);
});

test("readDrawAt: a vault event earlier in the same second (deposit / V2 requestDraw) does not stop the search", async () => {
  // Found in the cutover rehearsal: requestDraw and finalizeDraw shared a timestamp, and the scan
  // stopped at the first block holding ANY vault log, so the draw was never recorded.
  const first = 1_200_000, drawBlock = 1_200_003;
  const other = { address: VAULT, topics: ["0x" + "77".repeat(32)], data: "0x", transactionHash: TX(11), blockNumber: hex(first), logIndex: hex(0) };
  const c = fakeChain({ events: { [first]: [other], [drawBlock]: [prizeLog(drawBlock)] } });
  const got = await readDrawAt(c, c.ts(drawBlock));
  assert.equal(got.draws.length, 1);
  assert.equal(got.draws[0].block, drawBlock);
});

test("readDrawAt: the draw in the newest block (nothing after it yet) is still found", async () => {
  const head = 1_400_000;
  const c = fakeChain({ head, events: { [head]: [prizeLog(head)] } });
  const got = await readDrawAt(c, c.ts(head));
  assert.equal(got.draws.length, 1);
});
