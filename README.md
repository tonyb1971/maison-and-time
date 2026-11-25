# Maison & Time — Auction Marketplace

A deployable auction marketplace website for high-value watches and
jewellery. Classy ivory / charcoal / gold design with Playfair Display headings.

## What it does

- Browse, search, filter (Watches / Jewellery) and sort 14 seeded luxury lots
  (Rolex Submariner $21,400, Patek Philippe Calatrava $42,300, Audemars Piguet
  Royal Oak $54,200, 1.82ct diamond solitaire $27,800, Tiffany tennis bracelet,
  Cartier Tank, sapphire and pearl pieces, and more).
- Live countdowns to each lot's closing time, lot detail pages with bid history.
- Place a bid with minimum-increment validation ($25 under $1,000, $100 under
  $10,000, $250 under $50,000, $500 above), Buy Now, watchlist, a Sell form
  to add your own listing, and a My Auctions view (winning / outbid / watching /
  selling / won).
- **Buyer's premium: 16.5%** — added to every hammer price and Buy Now price,
  shown everywhere as hammer + premium = total due.
- **Checkout:** winners and Buy Now buyers enter delivery details and get a
  PayPal payment link pre-filled with the exact total due (AUD), lot name and
  order number, addressed to the seller's PayPal account.
- **Orders:** tracked as *awaiting payment* / *paid*, with a PayPal link and a
  mark-as-paid button.

## Shared bidding — the backend (new)

The site now has a small backend server (`server.js`, Node.js + Express +
SQLite) so **bids are shared between all visitors**, not stored only in each
visitor's browser:

- One SQLite database file (`data/maison.db`, created automatically) holds the
  shared record of listings, bids, watchlists and orders. It is seeded with
  the same 14 lots on first start.
- The front-end (`index.html`) tries the backend first — same origin when
  served by `npm start`, or the URL in `CONFIG.backendUrl` when the front-end
  is hosted separately — and re-syncs every 30 seconds, so every visitor sees
  the same live bids. If no backend answers, it falls back to the
  localStorage copy in that visitor's browser.
- The server also enforces the bid rules: a bid must be at least the current
  bid + the minimum increment, and the lot must still be open. A winning
  checkout closes the lot for everyone.

### Run it locally

```bash
npm install
npm start
# open http://localhost:3000
```

The server serves the front-end itself, so one command runs the whole site.
The database is created at `data/maison.db` on first start.

### Deploy it so anyone can use it (free / cheap)

The backend needs a host that runs Node.js — a static host (Netlify Drop,
GitHub Pages) cannot run it. Two easy options:

**Option A — Render (free tier)**
1. Push this folder to a GitHub repository (include `server.js`,
   `package.json`, `package-lock.json` and `index.html`; `node_modules/` and
   `data/` are git-ignored and must not be committed).
2. Go to https://dashboard.render.com → New → Web Service → pick the repo.
3. Build command: `npm install` — Start command: `npm start`.
   Render sets `PORT` automatically; the free tier sleeps after inactivity
   and wakes on the first visit (allow ~30 seconds for the first load).
4. Note: on Render's free tier the disk is ephemeral — the SQLite file is
   reset when the service restarts or redeploys, so bids/listings are lost.
   For a permanent database, add Render's persistent disk (paid) or switch
   the storage to a hosted database later.
5. Your site is live at the Render URL, e.g.
   `https://maison-and-time.onrender.com` — front-end and backend together,
   nothing else to configure.

**Option B — Railway**
1. Push the folder to GitHub as above.
2. Go to https://railway.app → New Project → Deploy from GitHub repo.
3. Railway detects the Node app and runs `npm start`. Add a volume if you
   want the SQLite file to survive restarts.
4. Your site is live at the Railway URL.

**Option C — split hosting (front-end static + backend separate)**
1. Deploy the backend as in Option A or B and note its public URL.
2. Deploy `index.html` on a static host as before (Netlify Drop, GitHub
   Pages, Vercel).
3. In `index.html`, set `backendUrl` in the `CONFIG` block to the backend
   URL, e.g. `"https://maison-and-time.onrender.com"`.
4. The static front-end will then use the shared backend. The server sends
   permissive CORS headers (`Access-Control-Allow-Origin: *` by default; set
   the `CORS_ORIGIN` env var to your front-end origin to lock it down).

## How to change the PayPal email and the premium

**When the backend is running (the normal case), change them on the server**
— the front-end reads them from `/api/settings` on load:

- Environment variables: `PAYPAL_EMAIL` and `PREMIUM_RATE`
  (e.g. `PREMIUM_RATE=0.10` for 10%), plus `CURRENCY` (default `AUD`).
- On Render / Railway, set them in the service's Environment settings and
  redeploy. On a local run:
  ```bash
  PAYPAL_EMAIL=you@example.com PREMIUM_RATE=0.10 npm start
  ```

**When running front-end only (no backend),** edit the `CONFIG` block near
the top of the `<script>` in `index.html`:

```js
const CONFIG = {
  premiumRate: 0.165,                 // 16.5% buyer's premium
  paypalEmail: "tonybornholm@gmail.com",
  currency: "AUD",
  backendUrl: ""                       // set to your backend URL to share bids
};
```

Every price, breakdown and PayPal link on the site is calculated from these
values.

## API reference

All endpoints return JSON. Amounts are in dollars (AUD unless configured
otherwise); the database stores cents internally.

| Method | Endpoint | What it does |
| ------ | -------- | ------------ |
| GET | `/api/health` | Server status, lot count, premium rate |
| GET | `/api/settings` | `{ premiumRate, paypalEmail, currency }` |
| GET | `/api/listings` | All lots, each with bids, `currentBid`, `bidCount`, `closed` |
| GET | `/api/listings/:id` | One lot with its bid history |
| POST | `/api/listings` | Create a listing: `{ title, cat, desc, start, buynow?, hours?, seller? }` |
| GET | `/api/listings/:id/bids` | Bid history for a lot |
| POST | `/api/listings/:id/bids` | Place a bid: `{ bidder, amount }` — validated against the minimum increment and closing time |
| GET | `/api/watchlist?visitorId=…` | Listing IDs on a visitor's watchlist |
| POST | `/api/watchlist` | Toggle: `{ visitorId, listingId }` |
| GET | `/api/orders` | All orders, newest first |
| POST | `/api/orders` | Create an order: `{ lotId, kind, name, email, address }` — premium and PayPal link calculated server-side |
| POST | `/api/orders/:id/mark-paid` | Mark an order paid |

## Limitations — please read

- **No user accounts or authentication yet.** Bids are attributed to the
  display name the visitor types when bidding, and a per-browser visitor ID
  identifies watchlists. Anyone who can open the site can bid under any name,
  so treat bids as indicative until payment is confirmed via PayPal. Adding
  accounts would be the next step for a production marketplace.
- **No real-time push.** The front-end polls the backend every 30 seconds,
  so another visitor's bid can take up to 30 seconds to appear on your screen.
- **No payment verification.** The server generates the PayPal payment link
  with the exact total due, but PayPal does not tell the server when a buyer
  has paid — the seller marks orders paid manually after checking PayPal.
  (Automatic confirmation needs PayPal IPN / webhooks, which is a future step.)
- **Free-tier hosting resets the database.** On Render's free tier (and any
  host without a persistent disk), the SQLite file is wiped on restart or
  redeploy. Keep a backup of `data/maison.db`, or add a persistent disk /
  volume, if the bid history matters.
- **Static-only mode still works.** With no backend configured and no backend
  reachable, the site falls back to localStorage in each visitor's browser —
  bids are then not shared between visitors. Set `backendUrl` or serve the
  site from the backend to get shared bidding.

## Files

- `index.html` — the whole front-end (HTML, CSS and JavaScript in one file)
- `server.js` — Express + SQLite backend (API + serves the front-end)
- `package.json` / `package-lock.json` — Node dependencies (`express` only;
  SQLite uses Node's built-in `node:sqlite`, no native build needed)
- `README.md` — this file
- `data/maison.db` — created automatically on first start (git-ignored)
