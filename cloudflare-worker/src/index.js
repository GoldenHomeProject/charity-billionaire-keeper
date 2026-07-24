// Charity Billionaire — Cloudflare Worker keeper.
//
// Reliable trigger for the weekly draw AND the charity forward. On schedule it asks the
// on-chain DrawUpkeep2 keeper contract whether any work is needed (draw due, VRF request
// stale, or a charity slice waiting to be forwarded) and, if so, sends the PERMISSIONLESS
// performUpkeep(). DrawUpkeep2 enforces everything and is internally guarded, so this Worker
// just supplies the "go" tx + gas.
//
// WHY DrawUpkeep2 (0x5c09…FD48) instead of calling vault.requestDraw() directly:
//   • It also self-heals a STALLED VRF request (cancelStaleDraw + re-request) — the direct
//     requestDraw() path could not, which is why a stuck draw previously needed a manual fix.
//   • It sweeps the weekly charity slice to Endaoment via CharityForwarder (forward()), in a
//     try/catch so a charity-side hiccup can never block the draw.
//   • performUpkeep is a no-op when nothing is due, so running it often is safe + cheap.
//
// NO-DUPLICATION (three layers, unchanged in spirit):
//   1. checkUpkeep() gate: we only send when the contract says work is needed.
//   2. DrawUpkeep2 is internally guarded (drawPending / nextDrawTime / stale-timeout).
//   3. On-chain backstop: requestDraw() reverts on a dead heat, caught as a clean no-op.
//
// The signing key is a gas-only wallet with zero contract authority, stored ONLY as the
// encrypted Worker Secret KEEPER_PRIVATE_KEY (never in this file/repo).

import { createPublicClient, createWalletClient, http, fallback } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// On-chain keeper (draw + stale-heal + charity forward). Supersedes the direct-to-vault path.
const KEEPER = "0x5c09c9D0aCF8E00FF1CB54b87b019f780a7cFD48";
const VAULT = "0x3993bD557E0d4a1E5A8Ec09a005E7Eee3E032f70";
const FORWARDER = "0x79f36B9Fba86aC8A020ABBd08B6ee2F201Ab3C77";
// Browser/edge-CORS-friendly Base RPCs, fast ones first; viem fails over automatically.
const RPCS = [
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://mainnet.base.org",
];
const KEEPER_ABI = [
  { type: "function", name: "checkUpkeep", stateMutability: "view", inputs: [{ type: "bytes" }], outputs: [{ type: "bool" }, { type: "bytes" }] },
  { type: "function", name: "performUpkeep", stateMutability: "nonpayable", inputs: [{ type: "bytes" }], outputs: [] },
];
const VIEW_ABI = [
  { type: "function", name: "nextDrawTime", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "drawPending", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
];

async function poke(env) {
  const transport = fallback(RPCS.map((u) => http(u)));
  const pub = createPublicClient({ chain: base, transport });

  // Ask the on-chain keeper if work is needed (draw due / stale VRF / charity slice waiting).
  const res = await pub.readContract({ address: KEEPER, abi: KEEPER_ABI, functionName: "checkUpkeep", args: ["0x"] });
  const needed = Array.isArray(res) ? res[0] : res;
  if (!needed) {
    const [nextDrawTime, drawPending, block] = await Promise.all([
      pub.readContract({ address: VAULT, abi: VIEW_ABI, functionName: "nextDrawTime" }),
      pub.readContract({ address: VAULT, abi: VIEW_ABI, functionName: "drawPending" }),
      pub.getBlock(),
    ]);
    return { action: "skip", reason: "no upkeep needed", now: String(block.timestamp), nextDrawTime: String(nextDrawTime), drawPending };
  }

  const key = env.KEEPER_PRIVATE_KEY;
  if (!key) return { action: "error", reason: "KEEPER_PRIVATE_KEY secret not set" };

  const account = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);
  const wallet = createWalletClient({ account, chain: base, transport });
  try {
    // HARDCODE the gas limit — do NOT let viem auto-estimate. performUpkeep forwards the
    // charity donation inside a try/catch; eth_estimateGas binary-searches for the minimum
    // gas that makes the OUTER call succeed, which is the gas where the inner forward() is
    // starved and its failure is swallowed — the donation would silently never happen while
    // the tx still reports success. A fixed high limit gives forward() the ~360k it needs
    // (deploy-and-donate) plus the draw's ~320k, with headroom. Only gas USED is paid for.
    const hash = await wallet.writeContract({ address: KEEPER, abi: KEEPER_ABI, functionName: "performUpkeep", args: ["0x"], gas: 2_000_000n });
    return { action: "fired", hash, by: account.address };
  } catch (e) {
    // Lost the race between our read and our send (another keeper's tx landed first), or the
    // work became not-needed mid-flight. performUpkeep is idempotent/guarded, so treat a
    // revert as a clean no-op rather than an error.
    const msg = ((e && (e.shortMessage || e.message)) || "").toLowerCase();
    if (msg.includes("alreadypending") || msg.includes("notdue") || msg.includes("revert") || msg.includes("execution reverted")) {
      return { action: "skip", reason: "reverted — already handled (no duplicate)" };
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
  // Manual HTTP entrypoint. `?check=1` verifies the configured signer WITHOUT sending.
  async fetch(req, env) {
    const json = (o) => new Response(JSON.stringify(o, null, 2), { headers: { "content-type": "application/json" } });
    if (new URL(req.url).searchParams.has("check")) {
      const key = env.KEEPER_PRIVATE_KEY;
      if (!key) return json({ keySet: false, signer: null, note: "KEEPER_PRIVATE_KEY secret is NOT set" });
      try {
        const acct = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);
        return json({ keySet: true, signer: acct.address, keeper: KEEPER, forwarder: FORWARDER, note: "signer should equal keeper wallet 0x67634201025c9723b47538d9B8923672da1809D5" });
      } catch {
        return json({ keySet: true, signer: null, error: "key is set but malformed — re-set the KEEPER_PRIVATE_KEY secret" });
      }
    }
    return json(await poke(env));
  },
};
