// Oracle Watchlist — "Alert on Entry Grade" (v9.3)
// Monitors WATCH_VOL tokens every 60s. Fires a priority alert the moment
// Adjusted Vol/Liq >= 5.0 AND Holder Health >= 50% are simultaneously met.
// Persists pending alerts to watchlist.json — survives restarts.

const fs   = require('fs');
const path = require('path');
const { fetchForensic } = require('./fetcher');
const { recordScan }    = require('./audit');
const { formatEt, formatUtc } = require('./time');

// Prefer /data (Railway persistent volume) over local file — same pattern as hunters.json.
// Falls back to the local bot/ directory when /data is not writable (dev/Replit).
function resolveWatchlistFile() {
  if (process.env.WATCHLIST_FILE) return process.env.WATCHLIST_FILE;
  try { fs.accessSync('/data', fs.constants.W_OK); return '/data/watchlist.json'; } catch (_) {}
  return path.join(__dirname, 'watchlist.json');
}
const PERSIST_FILE = resolveWatchlistFile();
console.log(`[watchlist] persist file: ${PERSIST_FILE}`);
const POLL_INTERVAL = 60 * 1000;
const MAX_AGE_MS    = 6 * 60 * 60 * 1000; // auto-expire after 6 hours
const VOL_LIQ_MIN   = 5.0;
const HEALTH_MIN    = 50; // holderHealth.healthPct

// Map: ca -> { ca, chatId, symbol, mc, addedAt }
const pending = new Map();

// ── Persistence ───────────────────────────────────────────────────────────────

function saveToDisk() {
  try {
    const arr = [...pending.values()];
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(arr, null, 2));
  } catch (e) { console.error('[watchlist] save error:', e.message); }
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
    if (!Array.isArray(raw)) return;
    const now = Date.now();
    for (const entry of raw) {
      if (!entry.ca || !entry.chatId) continue;
      if (now - (entry.addedAt || 0) > MAX_AGE_MS) continue; // expired
      pending.set(entry.ca, entry);
    }
    console.log(`[watchlist] loaded ${pending.size} pending alert(s) from disk`);
  } catch (e) { console.error('[watchlist] load error:', e.message); }
}

// ── Holder health (mirrors scanner.js logic — 400 holders per $100K MC) ──────

function holderHealthPct(holderCount, marketCap) {
  if (!holderCount || !marketCap || marketCap <= 0) return null;
  const target = (marketCap / 100000) * 400;
  if (target <= 0) return null;
  return Math.round((holderCount / target) * 100);
}

// ── Public API ────────────────────────────────────────────────────────────────

function add(ca, chatId, symbol, mc) {
  if (pending.has(ca)) return false;
  pending.set(ca, { ca, chatId, symbol: symbol || '???', mc: mc || 0, addedAt: Date.now() });
  saveToDisk();
  console.log(`[watchlist] added ${ca.slice(0,8)}... symbol=${symbol} chatId=${chatId}`);
  return true;
}

function remove(ca) {
  const removed = pending.delete(ca);
  if (removed) saveToDisk();
  return removed;
}

function list() { return [...pending.values()]; }

function has(ca) { return pending.has(ca); }

// ── Monitoring loop ───────────────────────────────────────────────────────────

async function checkEntry(entry, bot) {
  try {
    const sig = await fetchForensic(entry.ca);
    if (!sig) return;

    const volLiq      = sig.adjustedVolLiq ?? 0;
    const healthPct   = holderHealthPct(sig.holderCount, sig.marketCap);
    const mc          = sig.marketCap || 0;
    const px          = sig.priceUsd  || 0;
    const shortCa     = `${entry.ca.slice(0,6)}...${entry.ca.slice(-4)}`;

    const volOk    = volLiq  >= VOL_LIQ_MIN;
    const healthOk = healthPct != null ? healthPct >= HEALTH_MIN : false;

    console.log(`[watchlist] ${entry.ca.slice(0,8)}... volLiq=${volLiq.toFixed(2)}x health=${healthPct ?? 'N/A'}% volOk=${volOk} healthOk=${healthOk}`);

    if (!volOk || !healthOk) return;

    // Conditions met — fire priority alert and remove from pending
    pending.delete(entry.ca);
    saveToDisk();

    const fmtUsd = (n) => n >= 1e6 ? `$${(n/1e6).toFixed(2)}M` : n >= 1000 ? `$${(n/1000).toFixed(1)}K` : `$${n.toFixed(0)}`;
    const fmtPx  = (n) => n < 0.001 ? n.toExponential(3) : n < 1 ? n.toFixed(5) : n.toFixed(4);

    const metLines = [];
    if (volOk)    metLines.push(`Vol/Liq hit *${volLiq.toFixed(2)}x* (≥5x threshold met)`);
    if (healthOk) metLines.push(`Holder Health *${healthPct}%* (≥50% threshold met)`);

    const msg =
      `🕒 *Action Time:* ${formatEt()} | ${formatUtc()}\n\n` +
      `🚀 *ORACLE UPDATE: ${entry.symbol} IS NOW ENTRY GRADE*\n` +
      `CA: \`${shortCa}\`\n\n` +
      `── *CONDITIONS MET* ──\n` +
      metLines.map(l => `• ${l}`).join('\n') + '\n\n' +
      `── *CURRENT LEVELS* ──\n` +
      `• *MC:* ${fmtUsd(mc)}\n` +
      `• *Price:* $${fmtPx(px)}\n` +
      `• *Vol/Liq:* ${volLiq.toFixed(2)}x\n\n` +
      `→ *Execute Entry Grade Position (1.0x)*`;

    await bot.telegram.sendMessage(entry.chatId, msg, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '📈 VIEW CHART',   url: `https://dexscreener.com/solana/${entry.ca}` },
          { text: '➕ TRACK',        callback_data: `track:${entry.ca}:${Math.floor(mc)}` },
          { text: '🐦 X SEARCH',    url: `https://x.com/search?q=${entry.ca}&src=typed_query` },
        ]],
      },
    });

    // Audit watchlist fires — these are WATCH_VOL tokens that hit entry grade;
    // /audit will track whether they ultimately ran or rugged.
    recordScan({
      ca:             entry.ca,
      symbol:         entry.symbol,
      verdict:        'WATCHLIST_FIRED',
      entryTier:      'BASELINE_ENTRY',
      mc,
      adjustedVolLiq: volLiq,
      top10Pct:       null,
      washPct:        null,
      isEliteDev:     false,
      successRatePct: null,
      devLaunches:    null,
      source:         'watchlist',
    });

    console.log(`[watchlist] FIRED alert for ${entry.ca.slice(0,8)}... — conditions met`);
  } catch (e) {
    console.error(`[watchlist] check error for ${entry.ca.slice(0,8)}:`, e.message);
  }
}

function start(bot) {
  loadFromDisk();

  // Expire stale entries on start
  const now = Date.now();
  for (const [ca, entry] of pending) {
    if (now - entry.addedAt > MAX_AGE_MS) { pending.delete(ca); }
  }
  saveToDisk();

  setInterval(async () => {
    if (pending.size === 0) return;
    console.log(`[watchlist] polling ${pending.size} pending alert(s)`);
    const snapshot = [...pending.values()];
    for (const entry of snapshot) {
      // Re-check expiry on each cycle
      if (Date.now() - entry.addedAt > MAX_AGE_MS) { pending.delete(entry.ca); saveToDisk(); continue; }
      await checkEntry(entry, bot);
      await new Promise(r => setTimeout(r, 2000));
    }
  }, POLL_INTERVAL);

  console.log(`[watchlist] Entry Grade alerting started — ${pending.size} pending, polling every 60s`);
}

module.exports = { start, add, remove, list, has };
