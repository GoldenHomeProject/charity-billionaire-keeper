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

## The primary trigger: the Cloudflare Worker

The GitHub Action above is the **backstop**. The primary trigger is the Cloudflare Worker in
[`cloudflare-worker/`](cloudflare-worker/), which runs **every 5 minutes** so the draw is never
more than ~5 minutes late in either EDT or EST — it reads the vault's own DST-aware
`nextDrawTime`, so there is no UTC-offset math to get wrong.

Each tick takes at most **one** action, in priority order:

| Priority | Condition | Call |
|---|---|---|
| 1 | Draw is due and no VRF request is in flight | `vault.requestDraw()` |
| 2 | A VRF request has been pending past `STALE_DRAW_TIMEOUT` | `vault.cancelStaleDraw()` (next tick re-fires the draw) |
| 3 | A charity slice is waiting on the forwarder | `forwarder.forward()` |

### Why it calls the vault and forwarder directly

The vault pays a small bounty (`drawBounty`) to whoever fires a **late** draw, recorded as
`msg.sender` of `requestDraw()`. Routing the draw through the `DrawUpkeep2` helper contract made
that contract the `drawStarter` — and `DrawUpkeep2` has no function that can move an ERC-20, so
every bounty it earned would have been **permanently stranded**. Because the bounty is capped at
the company slice, a late draw would also have paid the company nothing. Calling the vault
directly sends the bounty to this keeper's own gas wallet, partly self-funding it.

Direct calls also remove a gas-starvation hazard: there is no outer call whose success can mask an
inner failure, so a charity forward that fails **reverts visibly** rather than silently skipping
the donation.

`DrawUpkeep2` is still deployed and permissionless as an on-chain backstop anyone can call. The
Worker uses only its `checkUpkeep()` view, as a cheap one-call gate so a quiet tick costs a single
RPC read instead of seven.

### Charity-forward backoff

A forward that keeps reverting must not retry 288 times a day — that would drain the gas wallet
the **draw** also spends from, coupling two failure domains that the design deliberately keeps
apart. So the Worker retries every tick for the first hour after a draw (the normal case lands on
the first tick), then at most hourly, and raises an alert once a slice has been stuck for two
hours. Retries alone cannot fix a real outage; a human has to look.

### Worker setup

```sh
cd cloudflare-worker
npm install
npm test                                    # unit-tests the action-selection logic
printf '0x…' | npx wrangler secret put KEEPER_PRIVATE_KEY
npx wrangler deploy
curl 'https://<worker>.workers.dev/?check=1'      # verify the signer, send nothing
curl 'https://<worker>.workers.dev/?alert=test'   # verify alerting end-to-end
```

Use `printf`, not `echo` — `echo` appends a newline, which silently corrupts a secret.

### Alerting

Set `ALERT_URL` to page a human when the keeper errors, a charity forward is stuck, or the gas
wallet runs low. Any of these work; the body shape is chosen from the host:

- **ntfy** — `https://ntfy.sh/<topic>`. ⚠️ Anonymous ntfy.sh quota is **per source IP**, and
  Cloudflare Workers egress from a large shared pool, so unauthenticated alerts hit
  `429 daily message quota reached` at unpredictable times — failing precisely when an incident
  needs to page someone. Set `ALERT_AUTH` to an ntfy **account token** (`Bearer tk_…`).
- **Discord / Slack** — paste the webhook URL; no auth needed and no shared-IP quota.

```sh
printf 'https://discord.com/api/webhooks/…' | npx wrangler secret put ALERT_URL
printf 'Bearer tk_…' | npx wrangler secret put ALERT_AUTH   # ntfy only
```

`?alert=test` reports the provider's actual HTTP status, so a rate-limited or misconfigured
channel is visible immediately rather than discovered during an outage.
