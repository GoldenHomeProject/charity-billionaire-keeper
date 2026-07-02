// Charity Billionaire — Cloudflare Worker keeper.
//
// Reliable primary trigger for the weekly draw. On schedule it checks whether the draw is
// due and, if so, sends the PERMISSIONLESS requestDraw(). The contract enforces everything
// (schedule, VRF winner, 90/5/5 split); this only sends the "go" tx.
//
// NO-DUPLICATION (the user's requirement) — three independent layers:
//   1. Pre-check `drawPending`: if any other keeper already fired this draw, we skip.
//   2. Pre-check `nextDrawTime`: once a draw completes it advances 7 days, so we see
//      "not due" and skip.
//   3. On-chain backstop: even in a dead heat, requestDraw() reverts with DrawAlreadyPending
//      / DrawNotDue, so a true double-draw is IMPOSSIBLE. We catch that revert and treat it
//      as a clean no-op (the other keeper won the race).
//
// The signing key is a gas-only wallet with zero contract authority, stored ONLY as the
// encrypted Worker Secret KEEPER_PRIVATE_KEY (never in this file/repo).

import { createPublicClient, createWalletClient, http, fallback } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const VAULT = "0x3993bD557E0d4a1E5A8Ec09a005E7Eee3E032f70";
// Browser/edge-CORS-friendly Base RPCs, fast ones first; viem fails over automatically.
const RPCS = [
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://mainnet.base.org",
];
const ABI = [
  { type: "function", name: "nextDrawTime", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "drawPending", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "requestDraw", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
];

async function poke(env) {
  const transport = fallback(RPCS.map((u) => http(u)));
  const pub = createPublicClient({ chain: base, transport });

  const [nextDrawTime, drawPending, block] = await Promise.all([
    pub.readContract({ address: VAULT, abi: ABI, functionName: "nextDrawTime" }),
    pub.readContract({ address: VAULT, abi: ABI, functionName: "drawPending" }),
    pub.getBlock(),
  ]);
  const now = block.timestamp;

  // Guard #1 — another keeper already fired this draw; do nothing.
  if (drawPending) return { action: "skip", reason: "draw already pending (another keeper fired first)", now: String(now), nextDrawTime: String(nextDrawTime) };
  // Guard #2 — not due yet (covers both "before 9pm" and "already completed → advanced 7d").
  if (now < nextDrawTime) return { action: "skip", reason: "not due yet", now: String(now), nextDrawTime: String(nextDrawTime) };

  const key = env.KEEPER_PRIVATE_KEY;
  if (!key) return { action: "error", reason: "KEEPER_PRIVATE_KEY secret not set" };

  const account = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);
  const wallet = createWalletClient({ account, chain: base, transport });
  try {
    const hash = await wallet.writeContract({ address: VAULT, abi: ABI, functionName: "requestDraw" });
    return { action: "fired", hash, by: account.address };
  } catch (e) {
    // Guard #3 — lost the race between our read and our send: requestDraw reverted because
    // another keeper's tx landed first. That's success for us (draw handled, no duplicate).
    const msg = ((e && (e.shortMessage || e.message)) || "").toLowerCase();
    if (msg.includes("alreadypending") || msg.includes("notdue") || msg.includes("revert") || msg.includes("execution reverted")) {
      return { action: "skip", reason: "reverted — already handled by another keeper (no duplicate)" };
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
      console.error("[charity-draw-keeper] ERROR", e && (e.stack || e.message || e));
      throw e; // surface in Cloudflare logs / wrangler tail
    }
  },
  // Manual HTTP entrypoint. `?check=1` verifies the configured signer (derives the address
  // from the secret WITHOUT sending anything — the address is public on-chain anyway).
  // Otherwise it runs the read/skip logic; safe because it only sends when genuinely due
  // and the same no-dup guards apply, so hitting it when not-due just returns "skip".
  async fetch(req, env) {
    const json = (o) => new Response(JSON.stringify(o, null, 2), { headers: { "content-type": "application/json" } });
    if (new URL(req.url).searchParams.has("check")) {
      const key = env.KEEPER_PRIVATE_KEY;
      if (!key) return json({ keySet: false, signer: null, note: "KEEPER_PRIVATE_KEY secret is NOT set" });
      try {
        const acct = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);
        return json({ keySet: true, signer: acct.address, note: "this should equal your keeper wallet 0x67634201025c9723b47538d9B8923672da1809D5" });
      } catch {
        // Never echo the exception text: a viem parse error on a mis-set secret could
        // include fragments of the value, and this endpoint is anonymous/public.
        return json({ keySet: true, signer: null, error: "key is set but malformed — re-set the KEEPER_PRIVATE_KEY secret" });
      }
    }
    return json(await poke(env));
  },
};
