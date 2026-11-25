/**
 * Maison & Time — shared backend server
 *
 * Node.js + Express + SQLite (built-in node:sqlite, no native build needed).
 * One SQLite file (data/maison.db) holds the shared record of listings, bids,
 * watchlists and orders, so every visitor sees the same live bids.
 *
 * Run locally:   npm install && npm start        (http://localhost:3000)
 * Env vars:      PORT (default 3000), DB_PATH (default ./data/maison.db),
 *                PAYPAL_EMAIL, PREMIUM_RATE, CORS_ORIGIN (default *)
 *
 * API (all JSON):
 *   GET  /api/health
 *   GET  /api/settings                        -> { premiumRate, paypalEmail, currency }
 *   GET  /api/listings                        -> lots with currentBid, bidCount, bids
 *   GET  /api/listings/:id
 *   POST /api/listings                        { title, cat, desc, start, buynow?, hours?, ends?, seller? }
 *   GET  /api/listings/:id/bids
 *   POST /api/listings/:id/bids              { bidder, amount }
 *   GET  /api/watchlist?visitorId=...        -> [listingId, ...]
 *   POST /api/watchlist                       { visitorId, listingId } (toggle)
 *   GET  /api/orders
 *   POST /api/orders                          { lotId, kind, name, email, address }
 *   POST /api/orders/:id/mark-paid
 *
 * Bid rules (same as the front-end): minimum increment $25 under $1,000,
 * $100 under $10,000, $250 under $50,000, $500 above. A bid must be at least
 * current bid + increment, and the lot must still be open.
 *
 * No user accounts / auth yet: bids are attributed to the display name the
 * visitor enters at bid time, and a per-browser visitorId identifies a
 * visitor's watchlist and "my bids". Do not use this for real money handling
 * beyond the PayPal links it generates — payment itself happens on PayPal.
 */
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "maison.db");
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const PREMIUM_RATE = Number(process.env.PREMIUM_RATE || 0.165);
const PAYPAL_EMAIL = process.env.PAYPAL_EMAIL || "tonybornholm@gmail.com";
const CURRENCY = process.env.CURRENCY || "AUD";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

// ---------- Schema ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cat TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '⌚',
    description TEXT NOT NULL DEFAULT '',
    start_cents INTEGER NOT NULL,
    buynow_cents INTEGER,
    ends INTEGER NOT NULL,
    seller TEXT NOT NULL DEFAULT 'Maison & Time',
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    bidder TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bids_listing ON bids(listing_id);
  CREATE TABLE IF NOT EXISTS watchlist (
    visitor_id TEXT NOT NULL,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    PRIMARY KEY (visitor_id, listing_id)
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lot_id TEXT NOT NULL,
    lot_title TEXT NOT NULL,
    kind TEXT NOT NULL,
    hammer_cents INTEGER NOT NULL,
    premium_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    buyer_name TEXT NOT NULL,
    buyer_email TEXT NOT NULL,
    address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting',
    paypal_url TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ---------- Helpers ----------
const H = 3600e3;
const NOW = Date.now();
const round = (n) => Math.round(n);
const toDollars = (cents) => cents / 100;
const toCents = (dollars) => Math.round(Number(dollars) * 100);
const minIncrement = (price) => (price < 1000 ? 25 : price < 10000 ? 100 : price < 50000 ? 250 : 500);

function paypalUrl(orderId, lotTitle, totalCents) {
  const p = new URLSearchParams({
    cmd: "_xclick",
    business: PAYPAL_EMAIL,
    amount: toDollars(totalCents).toFixed(2),
    currency_code: CURRENCY,
    item_name: `${lotTitle} — Maison & Time order #${orderId}`,
    invoice: String(orderId),
  });
  return "https://www.paypal.com/cgi-bin/webscr?" + p.toString();
}

function lotWithBids(row) {
  const bids = db.prepare(
    "SELECT bidder, amount_cents AS amount, created AS at FROM bids WHERE listing_id = ? ORDER BY amount_cents DESC"
  ).all(row.id);
  const current = bids.length ? Math.max(...bids.map((b) => b.amount)) : row.start_cents;
  return {
    id: row.id,
    title: row.title,
    cat: row.cat,
    emoji: row.emoji,
    desc: row.description,
    start: toDollars(row.start_cents),
    buynow: row.buynow_cents == null ? null : toDollars(row.buynow_cents),
    ends: row.ends,
    seller: row.seller,
    bids: bids.map((b) => ({ bidder: b.bidder, amount: toDollars(b.amount), at: b.at })),
    currentBid: toDollars(current),
    bidCount: bids.length,
    closed: Date.now() > row.ends,
  };
}

// ---------- Seed: the same 14 lots as index.html ----------
const SEED = [
  { id: "L01", title: "Rolex Submariner Date 41", cat: "Watches", emoji: "⌚", desc: "Stainless steel Oyster, black dial, ceramic bezel. Box & papers, serviced 2025.", start: 21400, buynow: 26800, bids: [{ bidder: "Collector_88", amount: 21400, at: NOW - 5 * H }], ends: NOW + 26 * H },
  { id: "L02", title: "Patek Philippe Calatrava 6119", cat: "Watches", emoji: "⌚", desc: "White gold, hand-wound, cream lacquered dial. Full set, 2023.", start: 42300, buynow: 52000, bids: [{ bidder: "GenevaFan", amount: 42300, at: NOW - 9 * H }], ends: NOW + 50 * H },
  { id: "L03", title: "Audemars Piguet Royal Oak 15500ST", cat: "Watches", emoji: "⌚", desc: "Grey dial, stainless steel bracelet. One owner, full set.", start: 54200, buynow: 68000, bids: [{ bidder: "AP_Lover", amount: 54200, at: NOW - 3 * H }, { bidder: "Collector_88", amount: 53500, at: NOW - 8 * H }], ends: NOW + 74 * H },
  { id: "L04", title: "1.82ct Diamond Solitaire Ring", cat: "Jewellery", emoji: "💎", desc: "Round brilliant, E colour, VS1, set in 18ct white gold. GIA certified.", start: 27800, buynow: 34500, bids: [{ bidder: "SparkleSeeker", amount: 27800, at: NOW - 12 * H }], ends: NOW + 30 * H },
  { id: "L05", title: "Tiffany & Co. Diamond Tennis Bracelet", cat: "Jewellery", emoji: "💎", desc: "5.40ct total weight, 18ct white gold. Tiffany pouch & certificate.", start: 16400, buynow: 21000, bids: [{ bidder: "TiffanyFan", amount: 16400, at: NOW - 6 * H }], ends: NOW + 20 * H },
  { id: "L06", title: "Cartier Tank Must, Large", cat: "Watches", emoji: "⌚", desc: "Steel case, Roman numerals, sapphire cabochon crown. 2024, unworn.", start: 6850, buynow: 8900, bids: [{ bidder: "ParisTime", amount: 6850, at: NOW - 2 * H }], ends: NOW + 44 * H },
  { id: "L07", title: "Sapphire & Diamond Cluster Pendant", cat: "Jewellery", emoji: "🔷", desc: "Ceylon sapphire 3.10ct with diamond halo, 18ct yellow gold chain.", start: 9200, buynow: 12500, bids: [{ bidder: "GemHunter", amount: 9200, at: NOW - 15 * H }], ends: NOW + 58 * H },
  { id: "L08", title: "Akoya Pearl Strand, 8–8.5mm", cat: "Jewellery", emoji: "⚪", desc: "Perfectly matched Akoya pearls, 18ct gold clasp. AAA grade.", start: 3400, buynow: 4800, bids: [{ bidder: "PearlLover", amount: 3400, at: NOW - 4 * H }], ends: NOW + 16 * H },
  { id: "L09", title: "Omega Speedmaster Moonwatch Professional", cat: "Watches", emoji: "⌚", desc: "Hesalite, manual wind, on bracelet. Full set, 2022.", start: 7450, buynow: 9800, bids: [{ bidder: "MoonFan", amount: 7450, at: NOW - 7 * H }, { bidder: "Speedy", amount: 7300, at: NOW - 11 * H }], ends: NOW + 38 * H },
  { id: "L10", title: "Rolex Datejust 36, Fluted Bezel", cat: "Watches", emoji: "⌚", desc: "White gold fluted bezel, champagne dial, Jubilee bracelet.", start: 12800, buynow: 15900, bids: [{ bidder: "DJ_Collector", amount: 12800, at: NOW - 10 * H }], ends: NOW + 66 * H },
  { id: "L11", title: "Emerald & Diamond Earrings, 18ct Gold", cat: "Jewellery", emoji: "💚", desc: "Colombian emeralds 2.40ct total, diamond surrounds.", start: 11200, buynow: 14800, bids: [{ bidder: "EmeraldEye", amount: 11200, at: NOW - 13 * H }], ends: NOW + 52 * H },
  { id: "L12", title: "Jaeger-LeCoultre Reverso Classic", cat: "Watches", emoji: "⌚", desc: "Stainless steel, silvered dial, manual wind. Box & papers.", start: 8900, buynow: 11500, bids: [{ bidder: "ReversoFan", amount: 8900, at: NOW - 1 * H }], ends: NOW + 34 * H },
  { id: "L13", title: "Van Cleef & Arpels Alhambra Necklace", cat: "Jewellery", emoji: "🍀", desc: "Vintage Alhambra, 10 motifs, mother-of-pearl, 18ct yellow gold.", start: 19800, buynow: 24500, bids: [{ bidder: "AlhambraFan", amount: 19800, at: NOW - 18 * H }], ends: NOW + 80 * H },
  { id: "L14", title: "TAG Heuer Carrera Chronograph", cat: "Watches", emoji: "⌚", desc: "Black dial, steel bracelet, automatic chronograph. 2023.", start: 4200, buynow: 5900, bids: [{ bidder: "CarreraFan", amount: 4200, at: NOW - 5 * H }], ends: NOW + 12 * H },
];

const seeded = db.prepare("SELECT COUNT(*) AS n FROM listings").get().n;
if (seeded === 0) {
  const insLot = db.prepare(
    "INSERT INTO listings (id, title, cat, emoji, description, start_cents, buynow_cents, ends, seller, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Maison & Time', ?)"
  );
  const insBid = db.prepare(
    "INSERT INTO bids (listing_id, bidder, amount_cents, created) VALUES (?, ?, ?, ?)"
  );
  try {
    db.exec("BEGIN");
    for (const lot of SEED) {
      insLot.run(lot.id, lot.title, lot.cat, lot.emoji, lot.desc, toCents(lot.start), lot.buynow == null ? null : toCents(lot.buynow), lot.ends, NOW);
      for (const b of lot.bids) insBid.run(lot.id, b.bidder, toCents(b.amount), b.at);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  console.log(`Seeded ${SEED.length} lots.`);
}

// Persist settings so the API is the single source of truth for premium/PayPal.
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('premiumRate', ?)").run(String(PREMIUM_RATE));
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('paypalEmail', ?)").run(PAYPAL_EMAIL);
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('currency', ?)").run(CURRENCY);

// ---------- App ----------
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Serve the front-end from the same folder, so one deployment serves both.
app.use(express.static(__dirname, { index: "index.html" }));

app.get("/api/health", (req, res) => {
  const n = db.prepare("SELECT COUNT(*) AS n FROM listings").get().n;
  res.json({ ok: true, listings: n, premiumRate: PREMIUM_RATE, currency: CURRENCY });
});

app.get("/api/settings", (req, res) => {
  res.json({ premiumRate: PREMIUM_RATE, paypalEmail: PAYPAL_EMAIL, currency: CURRENCY });
});

app.get("/api/listings", (req, res) => {
  const rows = db.prepare("SELECT * FROM listings ORDER BY ends ASC").all();
  res.json(rows.map(lotWithBids));
});

app.get("/api/listings/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM listings WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Lot not found" });
  res.json(lotWithBids(row));
});

app.post("/api/listings", (req, res) => {
  const { title, cat, desc, start, buynow, hours, ends, seller } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: "Title is required" });
  if (!["Watches", "Jewellery"].includes(cat)) return res.status(400).json({ error: "Category must be Watches or Jewellery" });
  const startCents = toCents(start);
  if (!Number.isFinite(startCents) || startCents <= 0) return res.status(400).json({ error: "Starting bid must be a positive amount" });
  const id = "L" + String(Date.now()).slice(-6) + Math.floor(Math.random() * 90 + 10);
  const endsMs = ends ? Number(ends) : Date.now() + (Number(hours) || 72) * H;
  db.prepare(
    "INSERT INTO listings (id, title, cat, emoji, description, start_cents, buynow_cents, ends, seller, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, String(title).trim(), cat, cat === "Watches" ? "⌚" : "💎", String(desc || "Listed by seller."), startCents, buynow ? toCents(buynow) : null, endsMs, String(seller || "You").trim() || "You", Date.now());
  const row = db.prepare("SELECT * FROM listings WHERE id = ?").get(id);
  res.status(201).json(lotWithBids(row));
});

app.get("/api/listings/:id/bids", (req, res) => {
  const row = db.prepare("SELECT * FROM listings WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Lot not found" });
  res.json(lotWithBids(row).bids);
});

app.post("/api/listings/:id/bids", (req, res) => {
  const row = db.prepare("SELECT * FROM listings WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Lot not found" });
  if (Date.now() > row.ends) return res.status(400).json({ error: "This auction has closed" });
  const bidder = String((req.body || {}).bidder || "").trim();
  if (!bidder) return res.status(400).json({ error: "A bidder name is required" });
  const amountCents = toCents((req.body || {}).amount);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: "Bid amount must be a positive number" });
  const lot = lotWithBids(row);
  const minBidCents = toCents(lot.currentBid) + toCents(minIncrement(lot.currentBid));
  if (amountCents < minBidCents) {
    return res.status(400).json({ error: `Bid must be at least $${toDollars(minBidCents).toFixed(2)} (current bid $${lot.currentBid.toFixed(2)} + $${minIncrement(lot.currentBid)} minimum increment)` });
  }
  db.prepare("INSERT INTO bids (listing_id, bidder, amount_cents, created) VALUES (?, ?, ?, ?)").run(row.id, bidder, amountCents, Date.now());
  res.status(201).json(lotWithBids(db.prepare("SELECT * FROM listings WHERE id = ?").get(row.id)));
});

// Watchlist (per-browser visitor id)
app.get("/api/watchlist", (req, res) => {
  const visitorId = String(req.query.visitorId || "");
  if (!visitorId) return res.json([]);
  const rows = db.prepare("SELECT listing_id FROM watchlist WHERE visitor_id = ?").all(visitorId);
  res.json(rows.map((r) => r.listing_id));
});

app.post("/api/watchlist", (req, res) => {
  const { visitorId, listingId } = req.body || {};
  if (!visitorId || !listingId) return res.status(400).json({ error: "visitorId and listingId are required" });
  const exists = db.prepare("SELECT 1 FROM watchlist WHERE visitor_id = ? AND listing_id = ?").get(visitorId, listingId);
  if (exists) {
    db.prepare("DELETE FROM watchlist WHERE visitor_id = ? AND listing_id = ?").run(visitorId, listingId);
    return res.json({ watching: false });
  }
  const lot = db.prepare("SELECT * FROM listings WHERE id = ?").get(listingId);
  if (!lot) return res.status(404).json({ error: "Lot not found" });
  db.prepare("INSERT INTO watchlist (visitor_id, listing_id) VALUES (?, ?)").run(visitorId, listingId);
  res.json({ watching: true });
});

// Orders
function orderJson(row) {
  return {
    id: row.id, lotId: row.lot_id, lotTitle: row.lot_title, kind: row.kind,
    hammer: toDollars(row.hammer_cents), premium: toDollars(row.premium_cents),
    total: toDollars(row.total_cents), name: row.buyer_name, email: row.buyer_email,
    address: row.address, status: row.status, paypal: row.paypal_url, created: row.created,
  };
}

app.get("/api/orders", (req, res) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY id DESC").all();
  res.json(rows.map(orderJson));
});

app.post("/api/orders", (req, res) => {
  const { lotId, kind, name, email, address } = req.body || {};
  const lot = db.prepare("SELECT * FROM listings WHERE id = ?").get(lotId);
  if (!lot) return res.status(404).json({ error: "Lot not found" });
  if (!name || !email || !address) return res.status(400).json({ error: "Name, email and delivery address are required" });
  const full = lotWithBids(lot);
  const hammer = kind === "buynow" ? (lot.buynow_cents == null ? null : toDollars(lot.buynow_cents)) : full.currentBid;
  if (hammer == null) return res.status(400).json({ error: "This lot has no Buy Now price" });
  const hammerCents = toCents(hammer);
  const premiumCents = round(hammerCents * PREMIUM_RATE);
  const totalCents = hammerCents + premiumCents;
  const info = db.prepare(
    "INSERT INTO orders (lot_id, lot_title, kind, hammer_cents, premium_cents, total_cents, buyer_name, buyer_email, address, status, paypal_url, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting', '', ?)"
  ).run(lotId, lot.title, kind === "buynow" ? "buynow" : "win", hammerCents, premiumCents, totalCents, String(name).trim(), String(email).trim(), String(address).trim(), Date.now());
  // A winning checkout closes the lot for every visitor.
  if (kind !== "buynow") db.prepare("UPDATE listings SET ends = ? WHERE id = ?").run(Date.now(), lotId);
  const orderId = Number(info.lastInsertRowid);
  const url = paypalUrl(orderId, lot.title, totalCents);
  db.prepare("UPDATE orders SET paypal_url = ? WHERE id = ?").run(url, orderId);
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  res.status(201).json(orderJson(row));
});

app.post("/api/orders/:id/mark-paid", (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Order not found" });
  db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(row.id);
  res.json(orderJson(db.prepare("SELECT * FROM orders WHERE id = ?").get(row.id)));
});

// Fallback: single-page app — any other path serves index.html.
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => {
  console.log(`Maison & Time backend listening on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Buyer's premium: ${(PREMIUM_RATE * 100).toFixed(1)}% · PayPal: ${PAYPAL_EMAIL} · Currency: ${CURRENCY}`);
});
