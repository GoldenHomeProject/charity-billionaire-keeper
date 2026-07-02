#!/usr/bin/env bash
#
# Charity Billionaire — public weekly-draw keeper (the "heartbeat").
#
# This script fires the weekly draw WHEN IT IS DUE. It decides NOTHING:
#   • the smart contract enforces the schedule (Thursday 21:00 America/New_York,
#     DST-aware) — requestDraw() reverts if called early;
#   • the winner is chosen by Chainlink VRF (verifiable randomness) inside the contract;
#   • the 90% winner / 5% charity / 5% company split is fixed in the contract.
#
# All this script does is send the permissionless "go" transaction. Anyone can read it,
# run it, or fire the draw themselves — this is just the convenience automation. The
# signing key is a GAS-ONLY wallet with ZERO contract authority: the only function it
# calls (requestDraw / cancelStaleDraw) is permissionless, so even if the key leaked the
# worst case is losing a few dollars of gas. It can never touch the vault, the prize, or
# any real funds.
#
# Self-heal: if a previous VRF request got stuck past the contract's stale timeout, this
# also clears it (cancelStaleDraw) so the draw can re-fire.
#
set -euo pipefail

VAULT="0x3993bD557E0d4a1E5A8Ec09a005E7Eee3E032f70"   # CharityPrizeVault, Base mainnet (chainId 8453)

# Reliability: multiple keeper layers hit an RPC within the same minute around
# 9 PM Thursday. A single rate-limited / down endpoint must NOT abort the draw, so we keep
# a fallback list and pick the first healthy one. Override/prepend the primary via
# BASE_RPC_URL (e.g. a dedicated endpoint) as a repo Variable.
RPCS=()
[ -n "${BASE_RPC_URL:-}" ] && RPCS+=("$BASE_RPC_URL")
RPCS+=(
  "https://mainnet.base.org"
  "https://base-rpc.publicnode.com"
  "https://base.llamarpc.com"
  "https://base.drpc.org"
  "https://1rpc.io/base"
)

# Pick the first endpoint that answers with Base's chain id (8453). Sets global RPC.
RPC=""
pick_rpc() {
  local url cid
  for url in "${RPCS[@]}"; do
    cid=$(cast chain-id --rpc-url "$url" 2>/dev/null || echo "")
    if [ "$cid" = "8453" ]; then RPC="$url"; echo "Using RPC: $url"; return 0; fi
    echo "RPC unhealthy, trying next: $url" >&2
  done
  echo "ERROR: no Base RPC reachable from the fallback list" >&2
  exit 1
}

# Read a view function with retry; on failure, re-pick a fresh RPC and retry. Reads are
# what would otherwise abort the whole script under a transient 429 (set -euo pipefail).
cast_call() {  # $1 = signature; prints raw cast output
  local sig="$1" out attempt
  for attempt in 1 2 3; do
    if out=$(cast call "$VAULT" "$sig" --rpc-url "$RPC" 2>/dev/null); then
      printf '%s' "$out"; return 0
    fi
    echo "read '$sig' failed on $RPC (attempt $attempt) — re-selecting RPC" >&2
    sleep $((attempt * 2))
    pick_rpc
  done
  echo "ERROR: read '$sig' failed on every RPC" >&2
  exit 1
}
# cast prints uints like "1782435600 [1.782e9]" — keep the first field only.
u() { cast_call "$1" | awk '{print $1}'; }

# Gas preflight: warn loudly if the gas-only keeper wallet is running low, so it can be
# topped up before it strands a draw. Non-fatal — a draw that can still pay gas must proceed.
gas_preflight() {
  local addr bal
  addr=$(cast wallet address --private-key "$KEEPER_PRIVATE_KEY" 2>/dev/null || echo "")
  [ -z "$addr" ] && { echo "WARN: could not derive keeper address for gas preflight" >&2; return 0; }
  bal=$(cast balance "$addr" --rpc-url "$RPC" 2>/dev/null || echo "0")
  echo "Keeper $addr balance: $(cast from-wei "$bal") ETH"
  # ~0.0002 ETH (2e14 wei) is several draws of Base gas. Below that, shout.
  if [ "$(printf '%s\n' "$bal" "200000000000000" | sort -g | head -1)" = "$bal" ]; then
    echo "WARN: keeper ETH balance is LOW — top up to avoid a missed draw." >&2
  fi
}

pick_rpc

now=$(date -u +%s)
nextDrawTime=$(u 'nextDrawTime()(uint256)')
drawPending=$(cast_call 'drawPending()(bool)')

echo "now=$now  nextDrawTime=$nextDrawTime  drawPending=$drawPending"

# 1) If a prior randomness request is stuck past the stale timeout, recover it first.
if [ "$drawPending" = "true" ]; then
  pendingSince=$(u 'pendingSince()(uint256)')
  staleTimeout=$(u 'STALE_DRAW_TIMEOUT()(uint256)')
  if [ "$now" -ge "$((pendingSince + staleTimeout))" ]; then
    echo "VRF request is stale -> cancelStaleDraw()"
    gas_preflight
    cast send "$VAULT" 'cancelStaleDraw()' --rpc-url "$RPC" --private-key "$KEEPER_PRIVATE_KEY"
    drawPending="false"
  else
    echo "Draw already pending and not yet stale -> nothing to do."
    exit 0
  fi
fi

# 2) Fire the draw if it is due. requestDraw() reverts if called before nextDrawTime,
#    so this is safe to run on a fixed-UTC schedule that covers both EDT and EST.
if [ "$drawPending" = "false" ] && [ "$now" -ge "$nextDrawTime" ]; then
  echo "Draw is due -> requestDraw()"
  gas_preflight
  cast send "$VAULT" 'requestDraw()' --rpc-url "$RPC" --private-key "$KEEPER_PRIVATE_KEY"
  echo "Draw fired. Chainlink VRF will deliver the winner within ~a minute."
else
  echo "Not due yet -> nothing to do."
fi
