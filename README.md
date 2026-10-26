# SOLANA RADAR — Smart Wallet Monitor

One screen, five things:

1. **Monthly wallet ranking**: the best-performing wallets over the last 30 days (realized profit, ROI, win rate, trade count).
2. **Synchronized buy radar**: an alert when **3 or more distinct wallets** from the ranking buy the **same token** within **5 minutes**. The latest alert stays on screen until a newer one arrives.
3. **Synchronized sell radar**: the same rule for **sells** (a group exiting together).
4. **Recurring co-buyers**: pairs of monitored wallets that keep buying the same tokens together (counted in distinct tokens, last 30 days).
5. **Alert track record**: how the price moved 5 min / 15 min / 1 h / 4 h after past alerts, plus the price change since the first wallet's trade.

History is stored in a local **SQLite** file (built into Node 22, no npm dependencies), so alerts, windows in progress and co-buyer stats survive restarts.

> Possible opportunity for analysis only. Not financial advice and no guarantee of gains.

## How it works

```
MadeOnSol  --(1 call every 6 h)-->  top-50 ranking  --> wallet list
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

- **Ranking**: `GET madeonsol.com/api/v1/kol/leaderboard?period=30d&sort=pnl&limit=50` (free plan: 200 calls/day; this uses ~4/day).
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

## Optional settings (`.env`)

`PORT` (3000) · `DATA_DIR` · `RETENTION_DAYS` (90) · `RANKING_SIZE` (50) · `RANKING_REFRESH_HOURS` (6) · `WINDOW_MINUTES` (5) · `MIN_WALLETS` (3) · `MIN_BUY_SOL` (0.01) · `PAIRS_DAYS` (30) · `PAIRS_MIN_COUNT` (2) · `DAILY_EVENT_WARN` (30000)

## Confirmed / known limitations

- **MadeOnSol free plan**: 200 calls/day; live feeds are delayed 5 min (that is why the radar uses Helius). The leaderboard is not delayed.
- **Helius free plan**: 1M credits/month, 1 credit per webhook event. The top 50 generate ~9,600 events/day (~290k credits/month). The dashboard warns when a day's volume exceeds `DAILY_EVENT_WARN`.
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
src/store.js       SQLite history (trades, alerts, prices, tokens), pairs and track-record queries
src/prices.js      DexScreener symbols and prices (batched)
src/madeonsol.js   normalized ranking (missing = null, never 0)
src/helius.js      creates/updates the webhook (only ours)
src/app.js         wires everything together, background jobs
src/server.js      HTTP: dashboard, /api/state, /events (SSE), /webhook/helius
public/            dashboard (plain HTML/CSS/JS, third-party text always via textContent)
test/              automated tests (npm test), with real captured transactions as fixtures
```
