// Charity Billionaire — Cloudflare Worker keeper.
//
// Fires the weekly draw, heals a stalled VRF request, and sweeps the weekly charity slice to
// Endaoment. Runs every 5 minutes so the draw is never more than ~5 min late in either EDT or
// EST (the vault's own nextDrawTime is DST-aware, so there is no UTC-offset math to get wrong).
//
// WHY IT CALLS THE VAULT AND FORWARDER DIRECTLY (not DrawUpkeep2.performUpkeep):
//   The vault pays a small self-healing bounty (`drawBounty`, currently $1) to whoever fires a
//   LATE draw — `drawStarter` is set to `msg.sender` of requestDraw(). Routing through
//   DrawUpkeep2 made the CONTRACT the starter, and DrawUpkeep2 has no function that can move an
//   ERC-20: every bounty it earned would be permanently stranded, and because the bounty is
//   capped at the company slice, a late draw would also pay the company nothing. Calling the
//   vault directly means our own gas-only keeper wallet collects it instead, which partly
//   self-funds this Worker. DrawUpkeep2 (0x5c09…FD48) remains deployed and permissionless as an
//   on-chain backstop anyone can call; nothing here depends on it.
//
//   Calling directly also removes the gas-starvation hazard that DrawUpkeep2's try/catch created:
//   there is no outer call whose success can hide an inner failure, so a forward that fails
//   REVERTS VISIBLY instead of silently skipping the donation.
//
// NO-DUPLICATION: every function called here is permissionless and guarded on-chain
// (DrawNotDue / DrawAlreadyPending / DrawNotStale / NothingToForward). Losing a race with another
// keeper is a harmless revert, which we classify as a clean no-op. One action per tick keeps
// nonce handling trivial; the next tick is only 5 minutes away.
//
// The signing key is a gas-only wallet with ZERO contract authority, stored only as the encrypted
// Worker Secret KEEPER_PRIVATE_KEY (never in this file or repo).

import { createPublicClient, createWalletClient, http, fallback, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const VAULT = "0x3993bD557E0d4a1E5A8Ec09a005E7Eee3E032f70";
const FORWARDER = "0x79f36B9Fba86aC8A020ABBd08B6ee2F201Ab3C77";
// DrawUpkeep2 stays in the loop for ONE job: its checkUpkeep() view answers "is any work due?"
// (draw due, VRF stale, or a charity slice waiting) in a single eth_call. We use it purely as a
// cheap gate so a quiet tick costs one RPC read instead of seven — 288 ticks a day against free
// public endpoints adds up. The WRITES all go direct to the vault/forwarder (see the note above),
// so performUpkeep is never called and no bounty is ever stranded in this contract.
const DRAW_UPKEEP2 = "0x5c09c9D0aCF8E00FF1CB54b87b019f780a7cFD48";
const UPKEEP_ABI = [
  { type: "function", name: "checkUpkeep", stateMutability: "view", inputs: [{ type: "bytes" }], outputs: [{ type: "bool" }, { type: "bytes" }] },
];

// Browser/edge-CORS-friendly Base RPCs, fast ones first; viem fails over automatically.
const RPCS = [
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://mainnet.base.org",
];

const VAULT_ABI = [
  { type: "function", name: "nextDrawTime", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lastDrawTime", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "drawPending", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "pendingSince", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "STALE_DRAW_TIMEOUT", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "requestDraw", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "cancelStaleDraw", stateMutability: "nonpayable", inputs: [], outputs: [] },
  // The vault's "not due yet" custom errors MUST be declared here. Without them viem cannot decode
  // a revert and reports only a raw 4-byte selector, so isBenignRevert fails to match and every
  // harmless race against the other keepers escalates into a page.
  { type: "error", name: "DrawNotDue", inputs: [] },
  { type: "error", name: "DrawAlreadyPending", inputs: [] },
  { type: "error", name: "DrawNotStale", inputs: [] },
];
const FWD_ABI = [
  { type: "function", name: "pending", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "forward", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "address" }, { type: "uint256" }] },
  { type: "error", name: "NothingToForward", inputs: [] },
  { type: "error", name: "EmptyRotation", inputs: [] },
];

// Fixed gas limits. Only gas USED is paid for, so a generous ceiling costs nothing and removes any
// dependence on eth_estimateGas. Measured worst cases: draw callback ~320k, forward via
// deploy-and-donate ~360k.
const GAS = { requestDraw: 500_000n, cancelStaleDraw: 100_000n, forward: 900_000n };

// A charity forward that keeps failing must not retry 288x/day — that would burn the gas wallet
// and take the DRAW down with it, since both share one balance. Full cadence for the first hour
// after a draw (the normal case lands on the first tick), then at most once an hour.
const FORWARD_FAST_WINDOW = 3600;   // seconds after lastDrawTime to retry every tick
// Page a human once a slice has been stuck this long — retries alone will not fix a real outage.
const FORWARD_STUCK_ALERT = 7200;   // 2 hours
// The DRAW is the thing that matters, and it had no alert of its own — only the forward did. Page
// once a draw that should have happened still hasn't completed. This watches the OUTCOME, so it
// catches a silently-reverting requestDraw, a VRF that never fulfils, and anything else we have not
// thought of. `nextDrawTime` only advances when a draw COMPLETES, so `lastDrawTime < nextDrawTime`
// is exactly "the scheduled draw has not happened yet".
const DRAW_OVERDUE_ALERT = 1800;    // 30 minutes past the scheduled time
// Chainlink VRF v2.5 subscription. If it runs dry, requestDraw() still SUCCEEDS but the coordinator
// never calls back — the draw sits pending for the full 24h stale timeout, is cancelled, re-requested,
// and repeats forever with nobody paid. That failure looks completely healthy from every other angle,
// and nothing was watching it. Subscription id and coordinator are public on-chain data, not secrets.
const VRF_COORDINATOR = "0xd5D517aBE5cF79B7e95eC98dB0f0277788aFF634";
const VRF_SUB_ID = 74476136546825988765658193066269522847079866536369235913794917061671468690805n;
const VRF_COORD_ABI = [{
  type: "function", name: "getSubscription", stateMutability: "view",
  inputs: [{ type: "uint256" }],
  outputs: [{ type: "uint96" }, { type: "uint96" }, { type: "uint64" }, { type: "address" }, { type: "address[]" }],
}];
// Roughly 0.05-0.2 LINK per fulfilment on Base, so this is ~15-60 draws of runway: enough warning to
// top up without urgency, far enough above zero that one expensive week cannot surprise us.
const VRF_LOW_LINK = 3000000000000000000n; // 3 LINK
// Warn while there is still plenty of runway to top up (~hundreds of draws' worth of gas).
const LOW_BALANCE_WEI = 1_000_000_000_000_000n; // 0.001 ETH
// The public record of past draws is served from a cache that only advances when someone REQUESTS
// it — so without this the newest winner could be missing until a visitor happened to warm it. We
// already know exactly when a draw completed, so ping it then. Best-effort and never awaited into
// the critical path: a failure here must not touch the draw.
const WINNERS_URL = "https://charitybillionaire.com/api/winners";
// How long after a draw the hourly quiet-tick backstop keeps checking that the public list caught up.
// The primary warm runs on the tick that forwards the charity slice; after that checkUpkeep goes
// false and the primary is unreachable, so this is the only thing left that can notice. Three hours
// is ~3 checks — enough to ride out a transient failure, short enough that it never becomes a
// standing hourly load on a subrequest-heavy endpoint. warmWinners() returns on the first request
// when the list is already current, so a healthy week costs 3 cheap calls.
const WARM_BACKSTOP_WINDOW = 10800;
// KV write budget. The free Cloudflare plan allows ~1000 writes/day and new sign-ups fail once it is
// gone, so we watch it and upgrade only when the traffic actually justifies it. Needs
// LOGS_READ_TOKEN as a Worker secret to read the site's own usage endpoint.
const KV_USAGE_URL = "https://charitybillionaire.com/api/kv-usage";
const KV_WARN_PERCENT = 60;

/// Decide the ONE action to take this tick, given on-chain state. Pure and exported so the branch
/// order — the safety-critical part of this keeper — is unit-testable without a chain.
///
/// Priority: the draw is time-critical and always wins; a stale VRF request is cleared next (the
/// following tick re-fires it through the draw branch, keeping that re-request a DIRECT call so its
/// bounty still reaches the keeper wallet); the charity forward is last and can always wait 5 min.
///
/// @param s.now, s.nextDrawTime, s.lastDrawTime, s.pendingSince, s.staleTimeout, s.slice — bigints
/// @param s.drawPending — bool;  @param s.utcMinutes — wall-clock minute, for the hourly backoff
export function decideAction(s) {
  if (!s.drawPending && s.now >= s.nextDrawTime) return { name: "requestDraw", on: "vault" };
  if (s.drawPending && s.now >= s.pendingSince + s.staleTimeout) return { name: "cancelStaleDraw", on: "vault" };
  if (s.slice > 0n) {
    const age = Number(s.now - s.lastDrawTime);
    const stuck = age > FORWARD_STUCK_ALERT;
    // Every tick for the first hour after a draw (the normal case lands on the first tick), then
    // at most hourly, so a persistently failing forward cannot drain the shared gas wallet and
    // take the draw down with it.
    if (age < FORWARD_FAST_WINDOW || s.utcMinutes < 5) return { name: "forward", on: "forwarder", stuck };
    return { name: null, stuck };
  }
  return { name: null };
}

// Best-effort alert. Never throws — an alerting outage must not break the keeper.
//
// Channel-agnostic on purpose. ALERT_URL may be an ntfy topic, a Discord webhook, or a Slack
// webhook; the body shape is chosen from the host. ALERT_AUTH, if set, becomes the Authorization
// header (ntfy access token, etc.).
//
// WHY NOT PLAIN ntfy.sh: its anonymous quota is per SOURCE IP, and Cloudflare Workers egress from a
// large shared pool, so an unauthenticated ntfy.sh alert gets HTTP 429 "daily message quota
// reached" at unpredictable times — silently failing precisely when a real incident needs to page
// someone. Use an ntfy ACCOUNT TOKEN (via ALERT_AUTH) or a Discord/Slack webhook instead.
//
// Returns {ok, status, body|error} so callers can distinguish "not configured" from
// "configured but failing" — reporting a rejected alert as success is how monitoring rots.
async function alert(env, title, message, priority = "high") {
  // Trim: piping a secret in with `echo` leaves a trailing newline, which makes the URL invalid and
  // silently disables alerting — exactly the failure this whole alert path exists to prevent.
  const url = ((env && env.ALERT_URL) || "").trim();
  if (!url) return { ok: false, reason: "not-configured" };
  const auth = ((env && env.ALERT_AUTH) || "").trim();

  let host = "";
  try { host = new URL(url).host; } catch { return { ok: false, reason: "unparseable-url" }; }

  let init;
  if (host.includes("discord.com") || host.includes("discordapp.com")) {
    init = { headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `**${title}**\n${message}` }) };
  } else if (host.includes("slack.com")) {
    init = { headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `*${title}*\n${message}` }) };
  } else {
    // ntfy and ntfy-compatible: title/priority as headers, plain-text body.
    init = { headers: { Title: title, Priority: priority, Tags: "warning" }, body: message };
  }
  if (auth) init.headers = { ...init.headers, Authorization: auth };

  try {
    const res = await fetch(url, { method: "POST", ...init });
    const body = (await res.text().catch(() => "")).slice(0, 300);
    if (!res.ok) {
      console.error("[charity-draw-keeper] alert REJECTED", res.status, body);
      return { ok: false, status: res.status, body };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    const error = (e && e.message) || String(e);
    console.error("[charity-draw-keeper] alert failed", error);
    return { ok: false, error };
  }
}

/// Gate for the manual HTTP entrypoint. Accepts `Authorization: Bearer <ADMIN_TOKEN>` or `?token=`.
/// Compares fixed-length SHA-256 digests so neither length nor content leaks through timing.
/// Fails CLOSED when ADMIN_TOKEN is unset — an unset secret must not mean "open to everyone".
async function authorized(req, env) {
  const secret = (env && env.ADMIN_TOKEN) || "";
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  // Header ONLY. A ?token= query param would be written into Workers Logs verbatim
  // (observability.invocation_logs records request URLs), persisting the admin secret.
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!presented) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  const va = new Uint8Array(a), vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// A revert is benign ONLY when it is one of the vault's/forwarder's own "not due" guards — i.e.
// another keeper won the race, or the work stopped being due between our read and our send.
//
// Deliberately NOT a blanket match on "revert": that would classify a genuinely broken draw as
// "already handled" and page nobody. Anything we do not recognise must escalate.
export const BENIGN_ERRORS = ["drawnotdue", "drawalreadypending", "drawnotstale", "nothingtoforward", "emptyrotation"];
export function isBenignRevert(e) {
  const msg = ((e && (e.shortMessage || e.message || "")) + " " + (e && e.metaMessages ? e.metaMessages.join(" ") : "")).toLowerCase();
  return BENIGN_ERRORS.some((name) => msg.includes(name));
}

/// Warm the public winners cache, and CONFIRM it actually caught up.
///
/// The first version of this fired one request and ignored the response entirely. On the Aug 6 draw
/// that produced a silent failure with no trace: the keeper logged {"action":"fired","call":"forward"}
/// at 21:05:49 — proving this ran — yet the public list still showed the previous week's draw 2h49m
/// later, until a visitor happened to trigger the scan. A 429 from the endpoint's own rate limiter, a
/// 500, or a request that was served while its internal RPC scan quietly failed were all
/// indistinguishable from success, so nothing retried and nothing was logged.
///
/// Two rules come out of that, and they are the same two the alert() path already learned:
///   1. `await fetch(...)` resolving means a RESPONSE ARRIVED, not that it worked — check res.ok.
///   2. Confirm the OUTCOME, not the delivery. /api/winners reports `latestMissing`, which is the
///      endpoint's own comparison of the vault's lastDrawTime against what it has cached. That is
///      the only signal that means "the list is now correct"; HTTP 200 does not.
/// Still never throws — a warm failure must not touch the draw — but it now returns a result and
/// leaves a line in the logs either way.
export async function warmWinners(attempts = 3, delayMs = 1500) {
  let last = "no attempt";
  for (let i = 1; i <= attempts; i++) {
    // The scan is bounded per request, so a cold cache can legitimately need a second pass. Give the
    // endpoint a moment rather than hammering it into its own rate limit.
    if (i > 1) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await fetch(WINNERS_URL + "?warm=1", { headers: { "cache-control": "no-cache" } });
      if (!res.ok) { last = "HTTP " + res.status; console.log(`[warm] attempt ${i}: ${last}`); continue; }
      const body = await res.json().catch(() => null);
      if (!body) { last = "unparseable body"; console.log(`[warm] attempt ${i}: ${last}`); continue; }
      if (body.latestMissing === false) {
        console.log(`[warm] ok on attempt ${i}: total=${body.total} complete=${body.complete}`);
        return { ok: true, attempts: i, total: body.total };
      }
      last = `still stale (total=${body.total})`;
      console.log(`[warm] attempt ${i}: ${last}`);
    } catch (e) {
      last = "fetch failed: " + (e && e.message);
      console.log(`[warm] attempt ${i}: ${last}`);
    }
  }
  console.log(`[warm] GAVE UP after ${attempts} attempts: ${last}`);
  return { ok: false, attempts, reason: last };
}

async function poke(env, utcMinutes = new Date().getUTCMinutes()) {
  const transport = fallback(RPCS.map((u) => http(u)));
  const pub = createPublicClient({ chain: base, transport });
  const vault = { address: VAULT, abi: VAULT_ABI };
  const fwd = { address: FORWARDER, abi: FWD_ABI };

  // Cheap gate: one eth_call that is true iff a draw is due, a VRF request is stale, or a charity
  // slice is waiting. The overwhelming majority of the 288 daily ticks stop right here.
  const gate = await pub.readContract({ address: DRAW_UPKEEP2, abi: UPKEEP_ABI, functionName: "checkUpkeep", args: ["0x"] });
  if (!(Array.isArray(gate) ? gate[0] : gate)) {
    // The overdue alert used to sit BELOW this early return, which made it unreachable in the very
    // failure it was written for: while a VRF request is pending-but-not-yet-stale there is no
    // actionable work, so checkUpkeep is FALSE for up to STALE_DRAW_TIMEOUT (24h) — exactly the
    // window in which the draw is overdue because VRF never fulfilled. Check it here, on the
    // top-of-hour tick, at the cost of two extra reads an hour.
    if (utcMinutes < 5) {
      // Hourly VRF-balance check.
      try {
        const sub = await pub.readContract({ address: VRF_COORDINATOR, abi: VRF_COORD_ABI, functionName: "getSubscription", args: [VRF_SUB_ID] });
        const linkBal = Array.isArray(sub) ? sub[0] : (sub && sub[0]);
        if (typeof linkBal === "bigint" && linkBal < VRF_LOW_LINK) {
          const link = (Number(linkBal) / 1e18).toFixed(3);
          await alert(env, "Charity Billionaire - VRF subscription LOW",
            "The Chainlink VRF subscription is down to " + link + " LINK. If it empties, requestDraw " +
            "still succeeds but the callback never comes and NO WINNER IS PAID - the draw just cycles " +
            "every 24h looking healthy. Top it up at vrf.chain.link.", "default");
        }
      } catch { /* a monitoring probe must never break a tick */ }
      // Daily-ish KV budget check, on the 09:00 UTC tick so it pages once a day, not hourly.
      if (new Date().getUTCHours() === 9 && env.LOGS_READ_TOKEN) {
        try {
          const r = await fetch(KV_USAGE_URL, { headers: { Authorization: "Bearer " + env.LOGS_READ_TOKEN.trim() } });
          if (r.ok) {
            const u = await r.json();
            if ((u.percentOfFree || 0) >= KV_WARN_PERCENT) {
              await alert(env, "Charity Billionaire - KV write budget " + u.percentOfFree + "%",
                "Estimated " + u.estimatedDailyWrites + " of " + u.freeDailyWrites + " daily KV writes (" +
                u.percentOfFree + "%). " + (u.advice || "") + " Once the budget is gone, NEW SIGN-UPS FAIL " +
                "(existing users can still sign in and withdraw - challenges are stateless).", "default");
            }
          }
        } catch { /* a budget probe must never break a tick */ }
      }
      try {
        const [ndt, ldt, blk] = await Promise.all([
          pub.readContract({ ...vault, functionName: "nextDrawTime" }),
          pub.readContract({ ...vault, functionName: "lastDrawTime" }),
          pub.getBlock(),
        ]);
        if (ldt < ndt && blk.timestamp >= ndt + BigInt(DRAW_OVERDUE_ALERT)) {
          await alert(env, "Charity Billionaire - weekly draw OVERDUE",
            `The draw scheduled for ${new Date(Number(ndt) * 1000).toISOString()} still has not completed ` +
            `(${Math.floor(Number(blk.timestamp - ndt) / 60)} min late). Nothing is currently actionable on-chain, ` +
            `which usually means Chainlink VRF has not fulfilled — check the subscription balance.`);
        }
        // Backstop for the primary warm, which becomes unreachable the moment the charity slice is
        // forwarded — exactly what left the Aug 6 winner off the public list for 2h49m. Costs no
        // extra RPC: ldt and blk are already read above for the overdue check.
        const sinceDraw = Number(blk.timestamp - ldt);
        if (sinceDraw >= 0 && sinceDraw < WARM_BACKSTOP_WINDOW) {
          const warm = await warmWinners(2);
          if (!warm.ok) console.log(`[warm] backstop failed ${Math.floor(sinceDraw / 60)}min after draw: ${warm.reason}`);
        }
      } catch { /* an alert probe must never break a tick */ }
    }
    return { action: "skip", reason: "nothing due" };
  }

  const [nextDrawTime, lastDrawTime, drawPending, pendingSince, staleTimeout, slice, block] =
    await Promise.all([
      pub.readContract({ ...vault, functionName: "nextDrawTime" }),
      pub.readContract({ ...vault, functionName: "lastDrawTime" }),
      pub.readContract({ ...vault, functionName: "drawPending" }),
      pub.readContract({ ...vault, functionName: "pendingSince" }),
      pub.readContract({ ...vault, functionName: "STALE_DRAW_TIMEOUT" }),
      pub.readContract({ ...fwd, functionName: "pending" }),
      pub.getBlock(),
    ]);

  const now = block.timestamp;
  const state = {
    now: String(now),
    nextDrawTime: String(nextDrawTime),
    lastDrawTime: String(lastDrawTime),
    drawPending,
    pendingSlice: String(slice),
  };

  // The hourly gates use a CLOCK minute, not the block timestamp: a block a few seconds behind real
  // time would read as minute 59 on the top-of-hour tick and skip that hour entirely. `utcMinutes`
  // comes from the cron's SCHEDULED time where available — Cloudflare can run a tick minutes late,
  // and sampling the clock here (after ~2 RPC round-trips) could push a :00 tick past :05 and
  // silently skip both that hour's retry AND its alert.
  const decision = decideAction({
    now, nextDrawTime, lastDrawTime, pendingSince, staleTimeout, slice, drawPending, utcMinutes,
  });

  // THE DRAW ITSELF HAD NO ALERT — only the forward did. Watch the OUTCOME rather than any single
  // mechanism: `nextDrawTime` advances only when a draw COMPLETES, so `lastDrawTime < nextDrawTime`
  // past the scheduled time means the week's draw has not happened, whatever the cause (a silently
  // reverting requestDraw, VRF never fulfilling, a dead keeper). Hourly-throttled.
  if (lastDrawTime < nextDrawTime && now >= nextDrawTime + BigInt(DRAW_OVERDUE_ALERT) && utcMinutes < 5) {
    await alert(
      env,
      "Charity Billionaire - weekly draw OVERDUE",
      `The draw scheduled for ${new Date(Number(nextDrawTime) * 1000).toISOString()} still has not completed ` +
        `(${Math.floor(Number(now - nextDrawTime) / 60)} min late, drawPending=${drawPending}). ` +
        `Check the keeper logs and the Chainlink VRF subscription.`,
    );
  }

  // Alert AT MOST ONCE AN HOUR. This runs every 5 minutes, so an unconditional send here would be
  // 288 pages a day for one stuck slice — enough to exhaust any provider's quota and train the
  // owner to ignore the channel, which is worse than having no alert at all.
  if (decision.stuck && utcMinutes < 5) {
    await alert(
      env,
      "Charity Billionaire - charity forward stuck",
      `The weekly charity slice has been sitting on the forwarder for ${Math.floor(Number(now - lastDrawTime) / 60)} min. ` +
        `forward() keeps failing — check Endaoment and the org for the current rotation entry. ` +
        `Winners were paid normally; only the donation is held up.`,
    );
  }
  // A draw that completed in the last ~15 minutes: make sure the public record has it before any
  // visitor arrives, rather than relying on the first visitor to trigger the scan.
  //
  // This is the PRIMARY warm, and on a normal week it is the only one that runs: the tick that
  // forwards the charity slice is the same tick that lands here. It is also the only warm attempt
  // that gets made on this path, because once the slice is forwarded checkUpkeep goes false and the
  // early return above makes this line unreachable for the rest of the week — hence the retries
  // inside warmWinners(), and the independent hourly backstop on the quiet path.
  const sinceDraw = Number(now - lastDrawTime);
  if (!drawPending && sinceDraw >= 0 && sinceDraw < 900) {
    const warm = await warmWinners();
    if (!warm.ok) {
      console.log(`[warm] primary warm failed after a draw (${warm.reason}); hourly backstop will retry`);
    }
  }

  if (!decision.name) return { action: "skip", reason: "nothing due", ...state };
  const action = decision.on === "vault"
    ? { name: decision.name, target: vault, gas: GAS[decision.name] }
    : { name: decision.name, target: fwd, gas: GAS[decision.name] };

  const key = env.KEEPER_PRIVATE_KEY;
  if (!key) {
    await alert(env, "Charity Billionaire - keeper misconfigured", "KEEPER_PRIVATE_KEY secret is not set; the draw cannot fire.");
    return { action: "error", reason: "KEEPER_PRIVATE_KEY secret not set", ...state };
  }
  // Trim for the same reason ALERT_URL is trimmed: a secret piped in with `echo` carries a trailing
  // newline, which would make privateKeyToAccount throw on every single tick.
  const trimmed = key.trim();
  const account = privateKeyToAccount(trimmed.startsWith("0x") ? trimmed : "0x" + trimmed);

  // Gas check runs only when we are about to spend, so it never costs an RPC call on a quiet tick.
  const balance = await pub.getBalance({ address: account.address });
  // Same hourly ceiling as the stuck-forward alert — a low balance persists until someone tops it
  // up, so an unthrottled send would page continuously until then.
  if (balance < LOW_BALANCE_WEI && utcMinutes < 5) {
    await alert(
      env,
      "Charity Billionaire - keeper wallet low",
      `Keeper ${account.address} is down to ${formatEther(balance)} ETH on Base. Top it up or the weekly draw stops firing.`,
      "default",
    );
  }

  const wallet = createWalletClient({ account, chain: base, transport });
  try {
    // SIMULATE FIRST. Passing an explicit `gas` makes viem skip eth_estimateGas entirely
    // (prepareTransactionRequest only estimates when gas is undefined), and writeContract never
    // simulates — so a call that reverts on-chain still signs, broadcasts and returns a hash, and
    // the tick logs "fired". A permanently reverting requestDraw would then look healthy 288 times a
    // day while nobody was paid. Simulating surfaces the DECODED custom error before we spend gas,
    // which is also the only way isBenignRevert can ever match a contract-level revert.
    await pub.simulateContract({ ...action.target, functionName: action.name, args: [], account, gas: action.gas });
    const hash = await wallet.writeContract({
      ...action.target,
      functionName: action.name,
      args: [],
      gas: action.gas,
    });
    return { action: "fired", call: action.name, hash, by: account.address, ...state };
  } catch (e) {
    if (isBenignRevert(e)) {
      return { action: "skip", call: action.name, reason: "not due after all - another keeper won the race", ...state };
    }
    throw e;
  }
}

export default {
  // Cron-fired entrypoint (the real trigger).
  async scheduled(event, env, ctx) {
    // Use the cron's SCHEDULED minute, not the clock at execution time: a late-firing tick would
    // otherwise miss the top-of-hour window that gates every hourly retry and alert.
    const utcMinutes = new Date(event.scheduledTime ?? Date.now()).getUTCMinutes();
    try {
      const result = await poke(env, utcMinutes);
      console.log("[charity-draw-keeper]", JSON.stringify(result));
    } catch (e) {
      const detail = (e && (e.shortMessage || e.message)) || String(e);
      console.error("[charity-draw-keeper] ERROR", e && (e.stack || detail));
      // A thrown error means the tick did no work for an unexpected reason (all RPCs down, send
      // failure, malformed key). Silence here is how a dead keeper goes unnoticed for a week — but
      // throttle it like every other alert: a sustained outage fires 288 times a day, which
      // exhausts the provider's quota and buries the one page that matters.
      if (utcMinutes < 5) {
        ctx.waitUntil(
          alert(env, "Charity Billionaire - keeper ERROR", `The draw keeper failed a scheduled run: ${detail}`),
        );
      }
      throw e; // still surface in Cloudflare logs / wrangler tail
    }
  },
  // Manual HTTP entrypoint — diagnostics only, and AUTHENTICATED.
  //
  // Everything here is privileged: the bare path runs poke(), which can spend this keeper's gas;
  // `?alert=test` consumes the alert provider's quota; `?check=1` reports configuration. The cron
  // `scheduled` handler is the real trigger and is unaffected by this gate, so locking the HTTP
  // entrypoint costs nothing operationally. Fails CLOSED: with no ADMIN_TOKEN set, there is no way
  // in at all.
  async fetch(req, env) {
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

    if (!(await authorized(req, env))) return json({ error: "unauthorized" }, 401);

    const params = new URL(req.url).searchParams;
    if (params.has("check")) {
      const key = env.KEEPER_PRIVATE_KEY;
      if (!key) return json({ keySet: false, signer: null, alertSet: !!env.ALERT_URL, note: "KEEPER_PRIVATE_KEY secret is NOT set" });
      try {
        const acct = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);
        return json({
          keySet: true,
          signer: acct.address,
          alertSet: !!env.ALERT_URL,
          vault: VAULT,
          forwarder: FORWARDER,
          backstop: DRAW_UPKEEP2,
          note: "signer should equal keeper wallet 0x67634201025c9723b47538d9B8923672da1809D5",
        });
      } catch {
        return json({ keySet: true, signer: null, error: "key is set but malformed — re-set the KEEPER_PRIVATE_KEY secret" });
      }
    }
    // `?alert=test` proves the alert path end-to-end without waiting for a real failure.
    if (params.get("alert") === "test") {
      const raw = (env.ALERT_URL || "").trim();
      const result = await alert(env, "Charity Billionaire - test alert", "Alerting is wired correctly. This is a test.", "default");
      // Report the PROVIDER, never the URL. For a Discord or Slack webhook the path IS the
      // credential (/api/webhooks/<id>/<token>), and an ntfy topic is likewise the only thing
      // guarding that channel — echoing either would hand a caller the ability to post to the
      // owner's alert feed, or to silence it by flooding the quota.
      let provider = null;
      try { provider = new URL(raw).host; } catch { /* leave null */ }
      return json({
        alertSent: result.ok,
        alertConfigured: !!raw,
        authConfigured: !!(env.ALERT_AUTH || "").trim(),
        provider,
        status: result.status || null,
        note: result.ok ? "check your phone"
          : !raw ? "ALERT_URL secret is not set"
          : result.status === 429 ? "rate-limited by the alert provider — anonymous ntfy.sh quota is per source IP and Cloudflare's egress pool is shared. Set ALERT_AUTH to an ntfy account token, or point ALERT_URL at a Discord/Slack webhook."
          : "ALERT_URL is set but the send FAILED — check the Worker logs for the provider's reply",
      });
    }
    try {
      return json(await poke(env));
    } catch (e) {
      // Return JSON rather than a raw runtime exception page for an authenticated diagnostic call.
      return json({ action: "error", error: (e && (e.shortMessage || e.message)) || String(e) }, 500);
    }
  },
};
