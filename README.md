# SOLANA RADAR — Smart Wallet Monitor

One screen, five things:

1. **Monthly wallet ranking**: the best-performing wallets over the last 30 days (realized profit, ROI, win rate, trade count). Source: MadeOnSol **alpha wallets** (early buyers of Pump.fun tokens, bots excluded by the source). Only the wallets that fit the Helius credit budget are watched.
2. **Synchronized buy radar**: an alert when **3 or more distinct wallets** from the ranking buy the **same token** within **5 minutes**. The latest alert stays on screen until a newer one arrives.
3. **Synchronized sell radar**: the same rule for **sells** (a group exiting together).
4. **Recurring co-buyers**: pairs of monitored wallets that keep buying the same tokens together (counted in distinct tokens, last 30 days).
5. **Alert track record**: how the price moved 5 min / 15 min / 1 h / 4 h after past alerts, plus the price change since the first wallet's trade.

History is stored in a local **SQLite** file (built into Node 22, no npm dependencies), so alerts, windows in progress and co-buyer stats survive restarts.

> Possible opportunity for analysis only. Not financial advice and no guarantee of gains.

## How it works

```
MadeOnSol alpha leaderboard (3 calls / 6 h) --> ~170 eligible wallets --> budget picks the ones to watch (<= 50)
                                                          |
                                         Helius webhook (enhanced, ~3 s delay)
                                                          |
        buy  = token balance went up AND the wallet spent SOL
        sell = token balance went down AND the wallet received SOL
                                                          |
                      SQLite history  <--  5-minute sliding window per token, unique wallets
                                                          |
                                alert (buy/sell) -->  dashboard (SSE)
                                                          |
                    DexScreener prices --> since-first-trade %, 5m/15m/1h/4h track record
```

- **Candidates**: `GET madeonsol.com/api/v1/alpha/leaderboard?period=30d&sort=pnl&limit=100&offset=…`, 3 pages (free plan: 200 calls/day; this uses ~12/day). Wallets with no profit, or not seen trading for more than `MAX_INACTIVE_DAYS` (14), are dropped. `RANKING_SOURCE=kol` switches to the KOL leaderboard (mostly scalper bots; a minimum hold time filters them).
- **Radar**: one Helius webhook watching the 50 wallets. The server creates/updates **only its own webhook** (identified by its URL) and only edits it when the list changed (each create/edit costs 100 credits).
- **Trade classification**: Helius' `type` field is often wrong for Pump.fun transactions (they show up as `TRANSFER`/`UNKNOWN`), so it is ignored. Trades come from balance changes in `accountData`, validated against MadeOnSol's feed.
- **Deduplication**: by transaction signature, persisted, so a webhook redelivery after a restart does not raise a second alert.
- **After a restart**: the last alerts are restored, the last 10 minutes of trades are re-loaded into the detector (a wave in progress continues) and already-sent alerts are not sent again.
- **Prices / symbols**: DexScreener (public API, no key). Prices are SOL per token (only pairs quoted in SOL). An unknown price is stored as unknown, never as zero. A checkpoint missed by more than 30 min (e.g. downtime) is skipped, not faked.
- **Retention**: trades and alerts older than `RETENTION_DAYS` (90) are deleted automatically.

## Configuration

1. Copy `.env.example` to `.env` and fill in:

| Variable | What it is |
|---|---|
| `MADEONSOL_API_KEY` | free key from https://madeonsol.com/developer |
| `HELIUS_API_KEY` | free key from https://dashboard.helius.dev (only needed with `PUBLIC_URL`) |
| `WEBHOOK_SECRET` | long random text (min. 16 chars). Helius sends it in the `Authorization` header; without it the server answers 401 |
| `PUBLIC_URL` | public URL of the server, e.g. `https://your-app.up.railway.app`. **Empty = local mode** (ranking works, radar off) |

   Generate a secret: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

2. Requires **Node 22.13+**. Run: `npm start` and open http://localhost:3000
3. Tests: `npm test` (the history tests are skipped on older Node versions)

Keys stay on the backend only (`.env` is in `.gitignore`); nothing is sent to the browser, and errors/logs have keys masked.

### Live radar (needs a public URL)

Helius delivers events over HTTP, so the server must be reachable from the internet: deploy it (e.g. on Railway) and set `PUBLIC_URL` to the deployed domain (no trailing slash). On startup the server registers the webhook by itself. On Railway set the variables in the service's **Variables** tab and expose port 8080 (set `PORT=8080`).
To stop spending credits: delete the webhook at https://dashboard.helius.dev/webhooks.

### Keeping history on Railway (Volume)

A container's disk is wiped on every deploy/restart, so the SQLite file must live on a **Volume**:

1. Open the service, then create a **Volume** (right-click on the canvas, or **+ New → Volume**).
2. Attach it to this service with mount path `/data`.

Railway exposes the mount path as `RAILWAY_VOLUME_MOUNT_PATH`, which the app picks up automatically (or set `DATA_DIR` yourself). Without a volume the app still works, but the dashboard shows a warning that history is lost on redeploy. Locally the file is `./data/radar.db` (git-ignored).

## Credit budget (making the Helius free plan last the whole month)

Helius charges 1 credit per webhook event (and 100 per webhook edit); the free plan has 1,000,000 per cycle. Wallets differ enormously in how many events they generate, so the app measures instead of guessing:

- Every delivered transaction is attributed to the watched wallets it touches, per hour, and stored. This gives a measured events/day per wallet.
- Until a wallet has been measured, its load is estimated from the leaderboard trade count times a calibration factor (default 10, re-measured from real data as it accumulates).
- Every 10 minutes the app computes the **daily allowance** = (credits left in the cycle × `BUDGET_FRACTION` 0.9) / days left (never more than 1.5x an even daily share), then watches the best wallets that fit in 85% of it. A wallet that alone would use more than 15% of the allowance (`MAX_WALLET_SHARE`) is skipped as too noisy. At least `MIN_TRACKED` wallets are always kept.
- If the measured load goes over the allowance the list is trimmed immediately; otherwise the webhook is only edited for a real change (max 6 edits/day, 30 min apart), because each edit costs 100 credits.
- **Hard stop**: past `HARD_STOP_FRACTION` (97%) of the plan the webhook is **deleted** and the radar pauses (the dashboard says so); it resumes by itself when the cycle resets.
- Set `BILLING_DAY` to the day your Helius cycle resets, and `CREDITS_USED_OFFSET` to the credits already used this cycle before the app started counting (see Helius dashboard, Usage).
- MadeOnSol calls are counted too, with our own cap (`MADEONSOL_DAILY_LIMIT`, 150/day) below the 200/day free quota.

The app counts events it receives; Helius may count retries or listing calls differently, so keep a margin and check the Helius Usage page occasionally.

## Optional settings (`.env`)

`RANKING_SOURCE` (alpha) · `POOL_SIZE` (300) · `MAX_INACTIVE_DAYS` (14) · `MIN_HOLD_MINUTES` (5, kol only) · `HELIUS_PLAN_CREDITS` (1000000) · `BUDGET_FRACTION` (0.9) · `HARD_STOP_FRACTION` (0.97) · `BILLING_DAY` (1) · `CREDITS_USED_OFFSET` (0) · `CALIBRATION_DEFAULT` (10) · `MIN_TRACKED` (5) · `MAX_WALLET_SHARE` (0.15) · `MAX_WEBHOOK_EDITS_PER_DAY` (6) · `MADEONSOL_DAILY_LIMIT` (150) · `PORT` (3000) · `DATA_DIR` · `RETENTION_DAYS` (90) · `RANKING_SIZE` (50) · `RANKING_REFRESH_HOURS` (6) · `WINDOW_MINUTES` (5) · `MIN_WALLETS` (3) · `MIN_BUY_SOL` (0.01) · `PAIRS_DAYS` (30) · `PAIRS_MIN_COUNT` (2) · `DAILY_EVENT_WARN` (30000)

## Confirmed / known limitations

- **MadeOnSol free plan**: 200 calls/day; live feeds are delayed 5 min (that is why the radar uses Helius). The leaderboard is not delayed.
- **Helius free plan**: 1M credits/cycle, 1 credit per webhook event. The top-50 KOL wallets (scalper bots) produced ~270 events/min (~11M credits/month) in a live measurement, which is why the default source is now the alpha leaderboard and the credit budget above exists.
- **Measured webhook latency**: median 3 s (2–6 s) between the transaction and the notification.
- **ROI**: MadeOnSol's docs do not define the unit of `avg_roi`; it is displayed as a percentage. Profit (`pnl`) is in SOL, per the docs.
- **Only wallets in the current ranking are tracked.** A wallet that drops out of the top 50 stops being recorded; its past trades stay in the history until retention deletes them.
- **Track record is descriptive, not predictive.** Early on the samples are tiny. The price comes from DexScreener and some brand-new tokens are not indexed yet (shown as unavailable).
- **Co-buyer pairs** only count trades the radar saw, so they start empty and fill up over time.
- **MadeOnSol terms**: the free plan is for personal use. Read the terms before opening the dashboard to the public (a Business plan with an embed license and attribution exists).
- If a ranked wallet is a bot with thousands of swaps/day it consumes credits; lower `RANKING_SIZE` if needed.

## Layout

```
src/buyParser.js   Helius event -> buy/sell trades (from balance changes)
src/detector.js    sliding window, unique wallets, deduplication, no spam, restore after restart
src/budget.js      credit budget maths: cycle, daily allowance, calibration, wallet selection
src/store.js       SQLite history (trades, alerts, prices, tokens, usage, wallet activity), pairs and track-record queries
src/prices.js      DexScreener symbols and prices (batched)
src/madeonsol.js   normalized ranking (missing = null, never 0)
src/helius.js      creates/updates the webhook (only ours)
src/app.js         wires everything together, background jobs
src/server.js      HTTP: dashboard, /api/state, /events (SSE), /webhook/helius
public/            dashboard (plain HTML/CSS/JS, third-party text always via textContent)
test/              automated tests (npm test), with real captured transactions as fixtures
```
