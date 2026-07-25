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
];
const FWD_ABI = [
  { type: "function", name: "pending", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "forward", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "address" }, { type: "uint256" }] },
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
// Warn while there is still plenty of runway to top up (~hundreds of draws' worth of gas).
const LOW_BALANCE_WEI = 1_000_000_000_000_000n; // 0.001 ETH

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
  const presented = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : new URL(req.url).searchParams.get("token") || "";
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

// A revert here means another keeper won the race, or the work stopped being due between our read
// and our send. Both are clean no-ops, not failures.
function isBenignRevert(e) {
  const msg = ((e && (e.shortMessage || e.message)) || "").toLowerCase();
  return msg.includes("revert")
    || msg.includes("alreadypending")
    || msg.includes("notdue")
    || msg.includes("notstale")
    || msg.includes("nothingtoforward");
}

async function poke(env) {
  const transport = fallback(RPCS.map((u) => http(u)));
  const pub = createPublicClient({ chain: base, transport });
  const vault = { address: VAULT, abi: VAULT_ABI };
  const fwd = { address: FORWARDER, abi: FWD_ABI };

  // Cheap gate: one eth_call that is true iff a draw is due, a VRF request is stale, or a charity
  // slice is waiting. The overwhelming majority of the 288 daily ticks stop right here.
  const gate = await pub.readContract({ address: DRAW_UPKEEP2, abi: UPKEEP_ABI, functionName: "checkUpkeep", args: ["0x"] });
  if (!(Array.isArray(gate) ? gate[0] : gate)) return { action: "skip", reason: "nothing due" };

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

  // The hourly backoff gate uses WALL CLOCK, not the block timestamp: a block a few seconds behind
  // real time would read as minute 59 on the top-of-hour tick and skip that hour's retry entirely.
  const decision = decideAction({
    now, nextDrawTime, lastDrawTime, pendingSince, staleTimeout, slice, drawPending,
    utcMinutes: new Date().getUTCMinutes(),
  });

  // Alert AT MOST ONCE AN HOUR. This runs every 5 minutes, so an unconditional send here would be
  // 288 pages a day for one stuck slice — enough to exhaust any provider's quota and train the
  // owner to ignore the channel, which is worse than having no alert at all.
  if (decision.stuck && new Date().getUTCMinutes() < 5) {
    await alert(
      env,
      "Charity Billionaire — charity forward stuck",
      `The weekly charity slice has been sitting on the forwarder for ${Math.floor(Number(now - lastDrawTime) / 60)} min. ` +
        `forward() keeps failing — check Endaoment and the org for the current rotation entry. ` +
        `Winners were paid normally; only the donation is held up.`,
    );
  }
  if (!decision.name) return { action: "skip", reason: "nothing due", ...state };
  const action = decision.on === "vault"
    ? { name: decision.name, target: vault, gas: GAS[decision.name] }
    : { name: decision.name, target: fwd, gas: GAS[decision.name] };

  const key = env.KEEPER_PRIVATE_KEY;
  if (!key) {
    await alert(env, "Charity Billionaire — keeper misconfigured", "KEEPER_PRIVATE_KEY secret is not set; the draw cannot fire.");
    return { action: "error", reason: "KEEPER_PRIVATE_KEY secret not set", ...state };
  }
  const account = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);

  // Gas check runs only when we are about to spend, so it never costs an RPC call on a quiet tick.
  const balance = await pub.getBalance({ address: account.address });
  // Same hourly ceiling as the stuck-forward alert — a low balance persists until someone tops it
  // up, so an unthrottled send would page continuously until then.
  if (balance < LOW_BALANCE_WEI && new Date().getUTCMinutes() < 5) {
    await alert(
      env,
      "Charity Billionaire — keeper wallet low",
      `Keeper ${account.address} is down to ${formatEther(balance)} ETH on Base. Top it up or the weekly draw stops firing.`,
      "default",
    );
  }

  const wallet = createWalletClient({ account, chain: base, transport });
  try {
    const hash = await wallet.writeContract({
      ...action.target,
      functionName: action.name,
      args: [],
      gas: action.gas,
    });
    return { action: "fired", call: action.name, hash, by: account.address, ...state };
  } catch (e) {
    if (isBenignRevert(e)) {
      return { action: "skip", call: action.name, reason: "reverted — already handled (no duplicate)", ...state };
    }
    throw e;
  }
}

export default {
  // Cron-fired entrypoint (the real trigger).
  async scheduled(event, env, ctx) {
    try {
      const result = await poke(env);
      console.log("[charity-draw-keeper]", JSON.stringify(result));
    } catch (e) {
      const detail = (e && (e.shortMessage || e.message)) || String(e);
      console.error("[charity-draw-keeper] ERROR", e && (e.stack || detail));
      // A thrown error means the tick did no work for an unexpected reason (all RPCs down, send
      // failure, malformed key). Silence here is how a dead keeper goes unnoticed for a week.
      ctx.waitUntil(
        alert(env, "Charity Billionaire — keeper ERROR", `The draw keeper failed a scheduled run: ${detail}`),
      );
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
      const result = await alert(env, "Charity Billionaire — test alert", "Alerting is wired correctly. This is a test.", "default");
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
    return json(await poke(env));
  },
};
