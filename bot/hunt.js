// ── Oracle v8.1 Predator Hunt Mode ──────────────────────────────────────────
// Persistent WebSocket to wss://pumpportal.fun/api/data. Subscribes to
// new-token + migration events. Each event triggers a full Oracle scan in
// a concurrency-limited queue. Verdicts with Vol/Liq ≥ 5x are broadcast to
// every chat that has opted in via /hunt. Below that, the bot stays silent.

const fs = require('fs');
const path = require('path');
const { fetchAll, fetchDeFadeVerification } = require('./fetcher');
const { scan }     = require('./scanner');
const { formatVerdict } = require('./verdict');

const WS_URL = 'wss://pumpportal.fun/api/data';
const HUNTERS_FILE = path.join(__dirname, 'hunters.json');
const MIN_VOLLIQ_BROADCAST = 5;
const MIN_MARKET_CAP_SOL_PRESCAN = 30;   // skip dust launches (~$4K)
const QUEUE_CONCURRENCY = 2;
const SCAN_STALE_MS = 30_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const PER_CA_COOLDOWN_MS = 5 * 60 * 1000; // don't re-broadcast same CA inside 5min

// ── Hunter registry (persisted) ─────────────────────────────────────────────

let hunters = new Set();
function loadHunters() {
  try {
    if (fs.existsSync(HUNTERS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HUNTERS_FILE, 'utf8'));
      hunters = new Set(Array.isArray(raw) ? raw : []);
    }
  } catch (e) { console.error('[hunt] loadHunters error:', e.message); }
}
function saveHunters() {
  try { fs.writeFileSync(HUNTERS_FILE, JSON.stringify([...hunters], null, 2)); }
  catch (e) { console.error('[hunt] saveHunters error:', e.message); }
}
function addHunter(chatId)    { const had = hunters.has(chatId); hunters.add(chatId);    saveHunters(); return !had; }
function removeHunter(chatId) { const had = hunters.has(chatId); hunters.delete(chatId); saveHunters(); return had; }
function hunterCount()        { return hunters.size; }
function isHunter(chatId)     { return hunters.has(chatId); }

// ── Scan queue (bounded concurrency) ────────────────────────────────────────

const queue = [];
let active = 0;
const recentlyBroadcast = new Map(); // ca -> ts
const stats = { scanned: 0, broadcast: 0, skipped: 0, errors: 0, lastEvent: null };

function enqueue(job, broadcaster) {
  job.enqueuedAt = Date.now();
  queue.push({ job, broadcaster });
  pump();
}

async function pump() {
  while (active < QUEUE_CONCURRENCY && queue.length > 0) {
    const { job, broadcaster } = queue.shift();
    if (Date.now() - job.enqueuedAt > SCAN_STALE_MS) { stats.skipped++; continue; }
    active++;
    runScan(job, broadcaster).finally(() => { active--; pump(); });
  }
}

async function runScan(job, broadcaster) {
  const { ca, eventType } = job;
  try {
    // Per-CA cooldown — avoid spamming the same token across new + migration events
    const last = recentlyBroadcast.get(ca);
    if (last && Date.now() - last < PER_CA_COOLDOWN_MS) { stats.skipped++; return; }

    stats.scanned++;
    const data = await fetchAll(ca);
    if (!data?.codex) { stats.skipped++; return; }

    const result = scan(data);
    const volLiq = result.signals?.volLiq ?? 0;
    if (volLiq < MIN_VOLLIQ_BROADCAST) { stats.skipped++; return; }

    // Post-scan DeFade verification on BUY candidates only (free-plan quota).
    if (result.verdict === 'BUY') {
      const v = await fetchDeFadeVerification(ca, { lp: result.signals?.lp });
      result.deFadeVerification = v;
      if (v.action === 'HARD_SKIP') {
        // Suppress broadcast AND set cooldown so repeated events for this CA
        // (e.g. new + migration in quick succession) don't re-burn quota.
        console.log(`[hunt] ${ca} HARD_SKIP by DeFade: ${v.reason}`);
        recentlyBroadcast.set(ca, Date.now());
        stats.skipped++; return;
      }
    }

    const message = formatVerdict(result, ca);
    const mc = result.signals?.marketCap || 0;
    const symbol = data.codex?.symbol || data.pump?.symbol || '???';
    const header = `🎯 <b>HUNT MODE — ${eventType.toUpperCase()}</b>\n` +
                   `Detected: <code>${symbol}</code> | Vol/Liq: <b>${volLiq.toFixed(1)}x</b>\n\n`;
    await broadcaster(ca, mc, header + message);
    recentlyBroadcast.set(ca, Date.now());
    stats.broadcast++;
  } catch (e) {
    stats.errors++;
    console.error(`[hunt] scan error for ${ca}:`, e.message);
  }
}

// ── WebSocket client ────────────────────────────────────────────────────────

let ws = null;
let reconnectMs = RECONNECT_BASE_MS;
let intentionallyClosed = false;
let connectedAt = null;

function connect(broadcaster) {
  intentionallyClosed = false;
  try { ws = new WebSocket(WS_URL); }
  catch (e) { console.error('[hunt] WS construct error:', e.message); scheduleReconnect(broadcaster); return; }

  ws.addEventListener('open', () => {
    connectedAt = Date.now();
    reconnectMs = RECONNECT_BASE_MS;
    console.log('[hunt] WS connected → subscribing');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    ws.send(JSON.stringify({ method: 'subscribeMigration' }));
  });

  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      stats.lastEvent = Date.now();
      const ca = msg.mint || msg.tokenAddress || msg.address;
      if (!ca || typeof ca !== 'string') return;

      // Cheap pre-filter — skip dust launches before paying for a full scan
      const mcSol = Number(msg.marketCapSol ?? msg.marketCap ?? 0);
      const eventType = msg.txType === 'create' ? 'new'
                      : msg.pool                ? 'migration'
                      : (msg.signature ? 'event' : null);
      if (!eventType) return;
      if (eventType === 'new' && mcSol < MIN_MARKET_CAP_SOL_PRESCAN) { stats.skipped++; return; }

      enqueue({ ca, eventType, mcSol }, broadcaster);
    } catch (e) { /* malformed frame */ }
  });

  ws.addEventListener('close', (ev) => {
    connectedAt = null;
    if (intentionallyClosed) return;
    console.log(`[hunt] WS closed code=${ev.code} → reconnect in ${reconnectMs}ms`);
    scheduleReconnect(broadcaster);
  });

  ws.addEventListener('error', (e) => {
    console.error('[hunt] WS error:', e?.message || 'unknown');
  });
}

function scheduleReconnect(broadcaster) {
  setTimeout(() => connect(broadcaster), reconnectMs);
  reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
}

function stop() {
  intentionallyClosed = true;
  try { ws?.close(); } catch (_) {}
}

function status() {
  return {
    connected:  connectedAt !== null,
    uptimeMs:   connectedAt ? Date.now() - connectedAt : 0,
    queueDepth: queue.length,
    activeScans: active,
    hunters:    hunters.size,
    ...stats,
  };
}

// ── Public init ─────────────────────────────────────────────────────────────

function start(bot, buildKeyboard) {
  loadHunters();
  const broadcaster = async (ca, mc, html) => {
    if (hunters.size === 0) return;
    const reply_markup = buildKeyboard(ca, mc);
    for (const chatId of hunters) {
      try {
        await bot.telegram.sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup });
      } catch (e) {
        // 403 = user blocked the bot → drop them
        if (e.code === 403 || /blocked|chat not found|user is deactivated/i.test(e.description || e.message || '')) {
          console.log(`[hunt] dropping unreachable chat ${chatId}: ${e.description || e.message}`);
          hunters.delete(chatId); saveHunters();
        } else {
          console.error('[hunt] broadcast error:', e.message);
        }
      }
    }
  };
  connect(broadcaster);
  console.log(`[hunt] hunt mode started — ${hunters.size} hunter(s) registered`);
}

module.exports = { start, stop, addHunter, removeHunter, hunterCount, isHunter, status };
