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

RPC="${BASE_RPC_URL:-https://mainnet.base.org}"
VAULT="0x3993bD557E0d4a1E5A8Ec09a005E7Eee3E032f70"   # CharityPrizeVault, Base mainnet (chainId 8453)

# cast prints uints like "1782435600 [1.782e9]" — keep the first field only.
u() { cast call "$VAULT" "$1" --rpc-url "$RPC" | awk '{print $1}'; }

now=$(date -u +%s)
nextDrawTime=$(u 'nextDrawTime()(uint256)')
drawPending=$(cast call "$VAULT" 'drawPending()(bool)' --rpc-url "$RPC")

echo "now=$now  nextDrawTime=$nextDrawTime  drawPending=$drawPending"

# 1) If a prior randomness request is stuck past the stale timeout, recover it first.
if [ "$drawPending" = "true" ]; then
  pendingSince=$(u 'pendingSince()(uint256)')
  staleTimeout=$(u 'STALE_DRAW_TIMEOUT()(uint256)')
  if [ "$now" -ge "$((pendingSince + staleTimeout))" ]; then
    echo "VRF request is stale -> cancelStaleDraw()"
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
  cast send "$VAULT" 'requestDraw()' --rpc-url "$RPC" --private-key "$KEEPER_PRIVATE_KEY"
  echo "Draw fired. Chainlink VRF will deliver the winner within ~a minute."
else
  echo "Not due yet -> nothing to do."
fi
