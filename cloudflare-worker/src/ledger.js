// The keeper's own record of every draw — the PRIMARY source for charitybillionaire.com/api/winners.
//
// WHY THIS EXISTS. Until Nov 2026 the public winners list was rebuilt by scanning eth_getLogs over
// the chain's history from a Cloudflare Pages Function, through free public RPCs. That design broke
// the list four or five times, each time for a different reason outside our control: an RPC cut its
// block-range cap (Sep 2026), Base went from 2 s to 0.2 s blocks (Nov 2026), publicnode started
// rate-limiting Cloudflare's IPs, and the free plan's 50-subrequest limit starved the catch-up.
// None of them raised an error; the list just stopped growing.
//
// The keeper does not need to SEARCH for draws. The vault tells it exactly when the last draw
// completed (lastDrawTime = that block's timestamp), so it finds that block by timestamp with a
// handful of getBlock calls and reads the event from that block's receipts. Then it writes one KV
// entry. No history walk, no eth_getLogs, no range caps, no hard-coded block time.
//
// WHY RECEIPTS AND NOT eth_getLogs (measured 2026-11-27): eth_getLogs is the call free RPCs ration
// hardest. mainnet.base.org answers every eth_getLogs with "request limit reached", publicnode
// rate-limits Cloudflare's IPs, drpc's free tier rate-limits and caps ranges at 100 blocks — and
// publicnode and drpc both refuse blocks older than ~12 weeks without a paid token. Plain block
// reads and eth_getBlockReceipts for a RECENT block work on all three. Reading the draw minutes
// after it happens, from its own block, is the one access pattern every free RPC still serves.
// (It is also why the site keeps a built-in archive of past draws: history older than ~12 weeks
// can no longer be re-read from free RPCs at all.)
//
// The ledger lives in the site's KV namespace under LEDGER_KEY, in the same entry shapes the site's
// scan cache uses, so /api/winners can merge it in directly. The keeper is its only writer.

export const LEDGER_KEY = "winners:ledger";

export const VAULT = "0x3993bd557e0d4a1e5a8ec09a005e7eee3e032f70";
export const FORWARDER = "0x79f36b9fba86ac8a020abbd08b6ee2f201ab3c77";
// PrizeAwarded(address,uint256,address,uint256,uint256) — winner and charity indexed.
export const TOPIC_PRIZE = "0x622b882b6ceb77cf087b0665bd596afc6c398608025481d08667631f42bcf019";
// DrawSkipped(string) — no indexed args.
export const TOPIC_SKIPPED = "0x0ca0fff2f25cdd27156e9100d00b80768a69572e60eef88ca359d80e65236cff";
// CharityForwarded(bytes32,address,uint256) — orgId and org indexed.
export const TOPIC_FORWARDED = "0x73b73668fbd2385e9eab692e091671697ce4ad0813bdea758ec302b0a133c003";
// Vault V2: PayoutRecorded(uint256 indexed payoutId, address indexed winner, bytes32 orgId) is
// emitted with PrizeAwarded in finalizeDraw(); PayoutSettled(uint256 indexed payoutId, uint8 paid)
// follows in the same transaction and again on every settle() retry. paid bitmask: 1 winner,
// 2 charity, 4 company, 8 bounty — 15 is fully paid. A V2 draw is RECORDED before it is paid.
export const TOPIC_PAYOUT_RECORDED = "0x49ab42f6d163eb9c393ecfed314c8378e24a409a2c6bd7c82b6235462a334d77";
export const TOPIC_PAYOUT_SETTLED = "0x42a66cd6d4550c108c4e834fd5344107fe35426fdfafec2919486487121cce9a";

// Bound the timestamp search so a misbehaving RPC cannot burn the Worker's subrequest budget
// (measured: 6-12 probes for real draws).
const MAX_PROBES = 30;
// At most this many blocks can share one timestamp before we stop looking (5 at 0.2 s blocks).
const MAX_SAME_SECOND_BLOCKS = 12;

const hexToNum = (h) => (typeof h === "number" ? h : parseInt(h, 16));
const numToHex = (n) => "0x" + Number(n).toString(16);
const lc = (s) => String(s || "").toLowerCase();
const addrFromTopic = (t) => "0x" + lc(t).slice(26);
const wordAt = (data, i) => BigInt("0x" + String(data).slice(2 + i * 64, 2 + (i + 1) * 64)).toString();
const HASH_RE = /^0x[0-9a-f]{64}$/;

/// Find the FIRST block whose timestamp is >= `ts`. Returns {n, t, probes}.
///
/// `chain.block(n)` returns {number, timestamp} (numbers); `chain.block()` returns the head.
/// No block time is trusted: the first guess assumes the current 0.2 s, and the search then keeps
/// lo.t < ts <= hi.t and narrows by interpolation, falling back to bisection whenever interpolation
/// stalls (several blocks share one timestamp at 0.2 s, which flattens the curve). Works across
/// Base's Nov 2026 change from 2 s to 0.2 s blocks, and across any future change.
export async function findFirstBlockAt(chain, ts) {
  let probes = 0;
  const probe = async (n) => {
    if (++probes > MAX_PROBES) throw new Error("block search exceeded probe budget");
    const b = await chain.block(n);
    return { n: Number(b.number), t: Number(b.timestamp) };
  };
  const head = await probe();
  if (ts > head.t) throw new Error(`timestamp ${ts} is after the chain head`);
  let hi = head;
  let lo = null;
  // Step back assuming `spb` seconds per block, plus a few blocks of margin. If we land at or after
  // ts the chain is faster than assumed: that probe becomes `hi`, and we assume twice as fast.
  let spb = 0.2;
  while (!lo) {
    const n = Math.max(0, hi.n - Math.max(8, Math.ceil((hi.t - ts) / spb) + 8));
    const b = await probe(n);
    if (b.t < ts) lo = b;
    else if (n === 0) throw new Error("timestamp is before genesis");
    else { hi = b; spb /= 2; }
  }
  let lastWidth = Infinity;
  while (hi.n - lo.n > 1) {
    const width = hi.n - lo.n;
    let g;
    if (width * 2 > lastWidth || hi.t === lo.t) {
      g = lo.n + Math.floor(width / 2); // interpolation stalled: bisect
    } else {
      g = lo.n + Math.floor(((ts - lo.t) * width) / Math.max(1, hi.t - lo.t));
    }
    g = Math.min(hi.n - 1, Math.max(lo.n + 1, g));
    lastWidth = width;
    const b = await probe(g);
    if (b.t < ts) lo = b; else hi = b;
  }
  return { ...hi, probes };
}

/// Shape-check one raw log. Same rules as the site's validLog(): a malformed or foreign log must
/// never enter a permanent public record.
function validLog(l, address, topic0, nTopics, nWords) {
  if (!l || lc(l.address) !== address || !Array.isArray(l.topics)) return false;
  if (l.topics.length !== nTopics || lc(l.topics[0]) !== topic0) return false;
  if (nWords !== null && (typeof l.data !== "string" || l.data.length !== 2 + nWords * 64)) return false;
  if (!HASH_RE.test(lc(l.transactionHash))) return false;
  return Number.isInteger(hexToNum(l.blockNumber)) && Number.isInteger(hexToNum(l.logIndex));
}

/// Confirm a log by fetching its transaction receipt (a second, independent read) and requiring
/// the same address/topic0/logIndex in the same block.
async function corroborate(chain, l) {
  const r = await chain.receipt(l.transactionHash);
  const ok = r && Array.isArray(r.logs) && hexToNum(r.blockNumber) === hexToNum(l.blockNumber) &&
    r.logs.some((x) => lc(x.address) === lc(l.address) && Array.isArray(x.topics) &&
      lc(x.topics[0]) === lc(l.topics[0]) && hexToNum(x.logIndex) === hexToNum(l.logIndex));
  if (!ok) throw new Error("log failed receipt check: " + l.transactionHash);
}

/// V2: the payout id recorded with this PrizeAwarded, and the settlement status from the same
/// transaction (finalizeDraw settles once itself). {} for V1, which has neither event.
function v2PayoutIn(logs, prize, vault) {
  const sameTx = logs.filter((x) => lc(x.transactionHash) === lc(prize.transactionHash) && lc(x.address) === vault && Array.isArray(x.topics));
  const rec = sameTx.find((x) => lc(x.topics[0]) === TOPIC_PAYOUT_RECORDED && x.topics.length === 3);
  if (!rec) return {};
  const payoutId = Number(BigInt(rec.topics[1]));
  const st = sameTx.find((x) => lc(x.topics[0]) === TOPIC_PAYOUT_SETTLED && x.topics.length === 2 && Number(BigInt(x.topics[1])) === payoutId);
  const paid = st && typeof st.data === "string" && st.data.length === 66 ? Number(BigInt(st.data)) : 0;
  return { payoutId, paid: paid & 15 };
}

/// V2: the PayoutSettled entries in a settle() (or finalizeDraw) receipt -> [{payoutId, paid}].
export function settlementsFromReceipt(r, vault) {
  if (!r || !Array.isArray(r.logs) || hexToNum(r.status) !== 1) return [];
  const V = lc(vault);
  return r.logs
    .filter((x) => lc(x.address) === V && Array.isArray(x.topics) && x.topics.length === 2 &&
      lc(x.topics[0]) === TOPIC_PAYOUT_SETTLED && typeof x.data === "string" && x.data.length === 66)
    .map((x) => ({ payoutId: Number(BigInt(x.topics[1])), paid: Number(BigInt(x.data)) & 15 }));
}

/// V2: after a settle() this keeper sent, update the ledger's `paid` for that payout. `paid` only
/// ever gains bits (a part, once paid, stays paid), so a stale or replayed receipt cannot regress it.
export async function recordSettle(kv, chain, hash, vault, { attempts = 4, delayMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((res) => setTimeout(res, delayMs));
    let r = null;
    try { r = await chain.receipt(hash); } catch { /* not visible yet */ }
    if (!r) continue;
    const s = settlementsFromReceipt(r, vault);
    if (!s.length) return { ok: false, reason: "receipt has no PayoutSettled log", hash };
    const ledger = await loadLedger(kv);
    let changed = 0;
    for (const { payoutId, paid } of s) {
      for (const d of ledger.draws) {
        if (d.payoutId === payoutId && Number.isInteger(d.paid) && (d.paid | paid) !== d.paid) { d.paid |= paid; changed++; }
      }
    }
    if (changed) { ledger.updatedAt = Math.floor(Date.now() / 1000); await kv.put(LEDGER_KEY, JSON.stringify(ledger)); }
    return { ok: true, updated: changed, settlements: s };
  }
  return { ok: false, reason: `no receipt after ${attempts} tries`, hash };
}

/// Read the draw that completed at `lastDrawTime` straight from the chain.
/// Returns { draws:[...], skips:[...], times:{block:ts} } in the site's cache shapes, or throws.
/// An empty result (no event in the range) is returned as-is; the caller treats it as "not found".
export async function readDrawAt(chain, lastDrawTime, vault = VAULT) {
  const V = lc(vault);
  const first = await findFirstBlockAt(chain, lastDrawTime);
  const out = { draws: [], skips: [], times: {}, probes: first.probes, blocksRead: 0 };
  if (first.t !== lastDrawTime) return out; // no block carries that timestamp: nothing to find
  // lastDrawTime is block.timestamp of the VRF callback, so the event is in one of the (up to ~5)
  // blocks that share that second. Read them in order and stop at the first that has it.
  const logs = [];
  for (let i = 0, n = first.n; i < MAX_SAME_SECOND_BLOCKS; i++, n++) {
    if (i > 0) {
      // Past the chain head (the draw is in the newest block): nothing more to read.
      let b;
      try { b = await chain.block(n); } catch { break; }
      if (Number(b.timestamp) !== lastDrawTime) break;
    }
    const receipts = await chain.blockReceipts(n, V);
    out.blocksRead++;
    if (!Array.isArray(receipts)) throw new Error(`block ${n}: receipts unavailable`);
    for (const r of receipts) {
      if (!r || hexToNum(r.status) !== 1 || !Array.isArray(r.logs)) continue;
      for (const l of r.logs) {
        logs.push({ ...l, transactionHash: l.transactionHash || r.transactionHash, blockNumber: l.blockNumber ?? r.blockNumber ?? numToHex(n) });
      }
    }
    // Stop at the block holding the DRAW event, not merely any vault event: a deposit, a
    // withdrawal or (V2) the draw request can share the same second in an earlier block. Found in
    // the 2026-11-27 cutover rehearsal, where requestDraw and finalizeDraw shared a timestamp.
    if (logs.some((l) => lc(l.address) === V && Array.isArray(l.topics) &&
      (lc(l.topics[0]) === TOPIC_PRIZE || lc(l.topics[0]) === TOPIC_SKIPPED))) break;
  }
  for (const l of logs) {
    const b = hexToNum(l.blockNumber);
    const isPrize = validLog(l, V, TOPIC_PRIZE, 3, 3);
    const isSkip = !isPrize && validLog(l, V, TOPIC_SKIPPED, 1, null);
    if (!isPrize && !isSkip) continue;
    const t = lastDrawTime;
    await corroborate(chain, l);
    const base = { block: b, index: hexToNum(l.logIndex), tx: lc(l.transactionHash), ts: t };
    if (isPrize) {
      out.draws.push({
        ...base,
        winner: addrFromTopic(l.topics[1]),
        charity: addrFromTopic(l.topics[2]),
        winnerAmount: wordAt(l.data, 0),
        charityAmount: wordAt(l.data, 1),
        // V2 only: the payout id and how much of it the same transaction already paid.
        ...v2PayoutIn(logs, l, V),
      });
    } else {
      out.skips.push(base);
    }
    out.times[b] = t;
  }
  return out;
}

/// Pull CharityForwarded entries out of a forward() transaction's receipt.
export function forwardsFromReceipt(r) {
  if (!r || !Array.isArray(r.logs)) return [];
  if (r.status !== undefined && hexToNum(r.status) !== 1 && r.status !== "success") return [];
  return r.logs.filter((l) => validLog({ ...l, transactionHash: l.transactionHash || r.transactionHash, blockNumber: l.blockNumber ?? r.blockNumber }, FORWARDER, TOPIC_FORWARDED, 3, 1))
    .map((l) => ({
      block: hexToNum(l.blockNumber ?? r.blockNumber),
      index: hexToNum(l.logIndex),
      tx: lc(l.transactionHash || r.transactionHash),
      orgId: lc(l.topics[1]),
      org: addrFromTopic(l.topics[2]),
    }));
}

// ---------------------------------------------------------------------------------------------
// Storage

export const emptyLedger = () => ({ v: 1, draws: [], forwards: [], skips: [], times: {} });
const entryKey = (e) => `${lc(e.tx)}:${e.index}`;

export function mergeInto(target, src) {
  let added = 0;
  for (const k of ["draws", "forwards", "skips"]) {
    const seen = new Set(target[k].map(entryKey));
    for (const e of (src && src[k]) || []) {
      if (seen.has(entryKey(e))) continue;
      seen.add(entryKey(e));
      target[k].push(e);
      added++;
    }
  }
  for (const [b, t] of Object.entries((src && src.times) || {})) {
    if (!target.times[b] && Number.isFinite(Number(t)) && Number(t) > 0) { target.times[b] = Number(t); added++; }
  }
  return added;
}

export async function loadLedger(kv) {
  const raw = await kv.get(LEDGER_KEY);
  if (!raw) return emptyLedger();
  const l = JSON.parse(raw);
  const out = emptyLedger();
  mergeInto(out, {
    draws: Array.isArray(l.draws) ? l.draws : [],
    forwards: Array.isArray(l.forwards) ? l.forwards : [],
    skips: Array.isArray(l.skips) ? l.skips : [],
    times: l.times && typeof l.times === "object" ? l.times : {},
  });
  return out;
}

/// Merge `add` into the stored ledger and write it back. Read-merge-write is safe here because the
/// keeper is the only writer and its writes are at least one 5-minute tick apart (well past KV's
/// ~60 s propagation). Returns the number of new entries written (0 = nothing to do, no write).
export async function appendLedger(kv, add) {
  const cur = await loadLedger(kv);
  const n = mergeInto(cur, add);
  if (n === 0) return 0;
  cur.updatedAt = Math.floor(Date.now() / 1000);
  await kv.put(LEDGER_KEY, JSON.stringify(cur));
  return n;
}

/// Newest draw time the ledger holds, paid or skipped.
export function newestSettled(ledger) {
  let m = 0;
  for (const e of [...ledger.draws, ...ledger.skips]) m = Math.max(m, Number(ledger.times[e.block] || e.ts || 0));
  return m;
}

/// Weeks missing from a list of settled draw dates (unix seconds): any consecutive gap longer than
/// 8 days. A draw can run up to ~1 day late (stale-VRF retry), so 8 days never false-alarms on a
/// late week, and a genuinely skipped week is a 14-day gap.
export function findGaps(dates, maxGapSecs = 8 * 86400) {
  const s = [...new Set(dates.filter((d) => Number.isFinite(d) && d > 0))].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > maxGapSecs) gaps.push([s[i - 1], s[i]]);
  return gaps;
}

// ---------------------------------------------------------------------------------------------
// Keeper entry points

/// Make sure the ledger holds the draw the vault says completed at `lastDrawTime`. Does nothing
/// (one KV read) when it already does. Throws on chain/KV failure; the caller logs and retries on
/// a later tick.
export async function syncLedger(kv, chain, lastDrawTime, vault = VAULT) {
  const ledger = await loadLedger(kv);
  const newest = newestSettled(ledger);
  if (!lastDrawTime || lastDrawTime <= newest) return { ok: true, recorded: 0, newest };
  const found = await readDrawAt(chain, lastDrawTime, vault);
  if (!found.draws.length && !found.skips.length) {
    return { ok: false, recorded: 0, newest, reason: `no draw event in the block(s) at ${lastDrawTime}` };
  }
  const recorded = mergeInto(ledger, found);
  ledger.updatedAt = Math.floor(Date.now() / 1000);
  await kv.put(LEDGER_KEY, JSON.stringify(ledger));
  const d = found.draws[0] || found.skips[0];
  return { ok: true, recorded, newest: newestSettled(ledger), block: d.block, tx: d.tx, skipped: !found.draws.length };
}

/// Record the charity forward from a forward() transaction this keeper just sent. Polls for the
/// receipt a bounded number of times (Base includes a transaction in well under a second, but the
/// Worker's subrequest budget is finite). If it is not found, the site's own scan still picks the
/// forward up; nothing here can affect the forward itself.
export async function recordForward(kv, chain, hash, { attempts = 4, delayMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, delayMs));
    let r = null;
    try { r = await chain.receipt(hash); } catch { /* not yet visible on this RPC; retry */ }
    if (!r) continue;
    const forwards = forwardsFromReceipt(r);
    if (!forwards.length) return { ok: false, reason: "receipt has no CharityForwarded log", hash };
    const recorded = await appendLedger(kv, { forwards });
    return { ok: true, recorded, block: forwards[0].block, orgId: forwards[0].orgId };
  }
  return { ok: false, reason: `no receipt after ${attempts} tries`, hash };
}

// Before this date the draw schedule was still being set up (Jul 10 -> Jul 20 2026 was a 10-day
// gap during launch). Gaps before it are history, not an outage.
export const GAP_CHECK_SINCE = 1785000000; // 2026-07-25

/// What is wrong with the public winners record, as plain-English lines for an alert. Pure.
/// @param p.lastDrawTime, p.nowSec  numbers (unix seconds)
/// @param p.ledgerNewest            newest draw time in the keeper's ledger, or null if unknown
/// @param p.publicBody              parsed /api/winners response, or null if it could not be read
export function winnersProblems({ lastDrawTime, nowSec, ledgerNewest, publicBody }) {
  const out = [];
  const since = nowSec - lastDrawTime;
  const when = new Date(lastDrawTime * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  if (since > 3600) {
    if (ledgerNewest !== null && ledgerNewest < lastDrawTime) {
      out.push(`The keeper has not recorded the ${when} draw yet (more than an hour after it paid).`);
    }
    if (!publicBody) out.push("charitybillionaire.com/api/winners could not be read.");
    else if (publicBody.latestMissing) out.push(`The public winners list is missing the ${when} draw.`);
  }
  if (publicBody && Array.isArray(publicBody.draws)) {
    const top = publicBody.draws[0];
    if (top && since > 7200 && top.viaForwarder && lc(top.charity) === FORWARDER && Number(top.date) >= lastDrawTime - 60) {
      out.push("The newest draw on the public list still has no charity name (its donation was not found).");
    }
    const undated = publicBody.draws.filter((d) => !d.date).length;
    if (undated) out.push(`${undated} draw(s) on the public list have no date.`);
    const dates = publicBody.draws.map((d) => Number(d.date)).concat((publicBody.skipDates || []).map(Number));
    for (const [a, b] of findGaps(dates).filter(([, b]) => b > GAP_CHECK_SINCE)) {
      const f = (t) => new Date(t * 1000).toISOString().slice(0, 10);
      out.push(`No draw on the public list between ${f(a)} and ${f(b)} — a week is missing.`);
    }
  }
  return out;
}

/// A minimal JSON-RPC client for the ledger's reads that fails over on ANY error.
///
/// Deliberately not viem's fallback transport: viem stops at the first endpoint when an error looks
/// non-retryable, and drpc's free tier answers some older-block reads with "Invalid parameters" —
/// which ended the attempt instead of trying the next RPC (found testing against Sep 2026 draws).
/// Each call costs at most one fetch per endpoint, so the Worker's subrequest budget stays bounded.
export function rpcChain(urls, fetchImpl = (...a) => fetch(...a)) {
  // `mustContain`: skip JSON.parse when the raw body cannot hold what we want. A Base block's
  // receipts are ~130 KB and the free Workers plan allows 10 ms of CPU, so parsing every same-second
  // block in full would be the expensive part of the whole tick; a substring test is nearly free.
  const call = async (method, params, { order = urls, mustContain = null, emptyOnMiss = null } = {}) => {
    let lastErr;
    for (const url of order) {
      const host = new URL(url).host;
      try {
        const r = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!r.ok) { lastErr = new Error(`${host} HTTP ${r.status}`); continue; }
        const text = await r.text();
        if (mustContain && /"result"\s*:\s*\[/.test(text) && !text.toLowerCase().includes(mustContain)) return emptyOnMiss;
        const j = JSON.parse(text);
        if (j.error) { lastErr = new Error(`${host} ${j.error.message || "rpc error"}`); continue; }
        if (j.result === undefined) { lastErr = new Error(`${host} no result`); continue; }
        return j.result;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("no RPC endpoints");
  };
  return {
    async block(n) {
      const b = await call("eth_getBlockByNumber", [n === undefined ? "latest" : numToHex(n), false]);
      if (!b) throw new Error(`block ${n} not found`);
      return { number: hexToNum(b.number), timestamp: hexToNum(b.timestamp) };
    },
    blockReceipts: (n, mustContain) =>
      call("eth_getBlockReceipts", [numToHex(n)], { mustContain: mustContain ? lc(mustContain).slice(2) : null, emptyOnMiss: [] }),
    // Receipts are read in REVERSE endpoint order, so a log found via one RPC is confirmed by a
    // different one whenever both are up. null = not mined yet (a valid answer, not an error).
    receipt: (hash) => call("eth_getTransactionReceipt", [hash], { order: [...urls].reverse() }),
  };
}
