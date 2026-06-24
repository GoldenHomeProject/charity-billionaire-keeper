# Charity Billionaire — Weekly Draw Keeper (public heartbeat)

This repository is the **public, verifiable trigger** for the Charity Billionaire weekly
prize draw. Once a week it sends a single transaction that tells the smart contract
"it's time" — nothing more.

## What this does and does *not* do

**It does:** run a scheduled GitHub Action that calls the contract's permissionless
`requestDraw()` when the draw is due.

**It does NOT decide anything.** Every meaningful rule is enforced on-chain by the smart
contract, not here:

| Concern | Enforced by |
|---|---|
| **When** a draw can happen | The contract: `requestDraw()` reverts unless it's past `nextDrawTime` (Thursday 21:00 America/New_York, DST-aware). |
| **Who wins** | Chainlink VRF — verifiable on-chain randomness. This keeper has zero influence. |
| **The split** (90% winner / 5% charity / 5% company) | Fixed in the contract. |
| **Which charity** | A deterministic weekly rotation in the contract. |

So this keeper cannot pick winners, change timing, redirect funds, or stop a draw. It is
pure convenience automation. **Anyone** can fire the draw — `requestDraw()` is
permissionless — so even if this repo vanished, the draw can always be triggered by
anyone, and the prize (accrued yield) simply keeps growing until it is.

## The signing key is harmless

The Action signs with a **gas-only wallet that has no contract authority**. The only
functions it calls (`requestDraw`, `cancelStaleDraw`) are permissionless — callable by
anyone — so the key grants no special power. Worst case if it leaked: a few dollars of gas.
It can never touch the vault, the prize pool, or any real funds.

## Schedule (DST handling)

The contract draws every **Thursday 9:00 PM Eastern** — 9 PM EDT in summer, 9 PM EST in
winter. GitHub cron is fixed-UTC, so the workflow fires at **both** equivalent UTC times
(Fri 01:00 UTC and Fri 02:00 UTC); whichever isn't due that week is a harmless no-op
because `requestDraw()` reverts when called early. GitHub scheduled runs can start a few
minutes late; the contract has a small late-fire bounty that lets anyone backstop a missed
run, so a draw is never skipped.

## On-chain contracts (Base mainnet, chainId 8453)

- **CharityPrizeVault:** [`0x3993bD557E0d4a1E5A8Ec09a005E7Eee3E032f70`](https://basescan.org/address/0x3993bD557E0d4a1E5A8Ec09a005E7Eee3E032f70) (verified source)

All draws, winners, charity donations, and splits are visible on-chain via the contract's
events.

## Setup (one time)

1. Create a fresh **gas-only** wallet (e.g. `cast wallet new`). Keep its key private.
2. Fund it with a small amount of ETH on Base (~$5) for gas.
3. In this repo: **Settings → Secrets and variables → Actions → Secrets**, add
   `KEEPER_PRIVATE_KEY` = that wallet's private key. (Optional: add a repo **Variable**
   `BASE_RPC_URL` to override the default public RPC.)
4. The workflow runs automatically on schedule; use **Actions → weekly-draw-keeper → Run
   workflow** to test it manually.
