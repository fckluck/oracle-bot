// ── Oracle v8.1 Predator Hunt Mode ──────────────────────────────────────────
// Persistent WebSocket to wss://pumpportal.fun/api/data. Subscribes to
// new-token + migration events. Each event triggers a full Oracle scan in
// a concurrency-limited queue. Verdicts with Vol/Liq ≥ 5x are broadcast to
// every chat that has opted in via /hunt. Below that, the bot stays silent.

const fs = require('fs');
const path = require('path');
const WS   = require('ws');          // explicit import — never rely on global WebSocket
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
let huntersLoaded = false;

function loadHunters() {
  try {
    if (fs.existsSync(HUNTERS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HUNTERS_FILE, 'utf8'));
      hunters = new Set(Array.isArray(raw) ? raw : []);
    }
    huntersLoaded = true;
  } catch (e) { console.error('[hunt] loadHunters error:', e.message); }
}

function ensureHuntersLoaded() {
  if (!huntersLoaded) loadHunters();
}

function saveHunters() {
  try { fs.writeFileSync(HUNTERS_FILE, JSON.stringify([...hunters], null, 2)); }
  catch (e) { console.error('[hunt] saveHunters error:', e.message); }
}
function addHunter(chatId)    { ensureHuntersLoaded(); const had = hunters.has(chatId); hunters.add(chatId);    saveHunters(); return !had; }
function removeHunter(chatId) { ensureHuntersLoaded(); const had = hunters.has(chatId); hunters.delete(chatId); saveHunters(); return had; }
function hunterCount()        { ensureHuntersLoaded(); return hunters.size; }
function isHunter(chatId)     { ensureHuntersLoaded(); return hunters.has(chatId); }
function listHunters()        { ensureHuntersLoaded(); return [...hunters]; }

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
    // v10.2 Spine Alignment: use adjustedVolLiq (organic, wash-corrected) — the
    // raw `volLiq` field never existed, so Hunt was silent. 5x floor = Entry Grade.
    const adjustedVolLiq = result.signals?.adjustedVolLiq ?? 0;
    if (adjustedVolLiq < MIN_VOLLIQ_BROADCAST) { stats.skipped++; return; }

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
                   `Detected: <code>${symbol}</code> | Adj Vol/Liq: <b>${adjustedVolLiq.toFixed(1)}x</b>\n\n`;
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
let intentionallyStopped = false;    // true only during shutdown via stop()
let connectedAt = null;
let heartbeatTimer = null;
let reconnectTimer = null;           // pending reconnect (cancelled on new connect)
let socketGen = 0;                   // bumped per connect; stale handlers no-op
let wasEverConnected = false;        // first connect ≠ "restored"
let wasDisconnected = false;         // outage epoch flag — gates dedupe of RESTORED
let savedBroadcaster = null;         // for forceReconnect() + restoration ping
let savedBotRef = null;              // for sending restoration alert to hunters

const HEARTBEAT_MS = 30 * 1000;      // ping every 30s to keep door open

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    // ws (native global / ws lib) — readyState 1 = OPEN
    if (ws && ws.readyState === 1) {
      try {
        if (typeof ws.ping === 'function') ws.ping();          // node-ws lib
        else ws.send(JSON.stringify({ method: 'ping' }));      // browser-style fallback
      } catch (e) { /* next close handler will reconnect */ }
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

async function broadcastRestored() {
  if (!savedBotRef) return;
  loadHunters();
  const msg = `✅ <b>Hunt Mode WebSocket RESTORED.</b>\nWe are back in the trenches.`;
  for (const chatId of hunters) {
    try { await savedBotRef.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' }); }
    catch (e) { /* drop unreachable */ }
  }
}

function cancelPendingReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function connect(broadcaster) {
  cancelPendingReconnect();
  savedBroadcaster = broadcaster;
  // Bump generation BEFORE constructing — any stale close/open from a prior
  // socket will see myGen !== socketGen and no-op. This is the fix for the
  // forceReconnect → old-close-after-new-connect race.
  const myGen = ++socketGen;
  let mySocket;
  try { mySocket = new WS(WS_URL); ws = mySocket; }
  catch (e) { console.error('[hunt] WS construct error:', e.message); scheduleReconnect(broadcaster); return; }

  mySocket.addEventListener('open', () => {
    if (myGen !== socketGen) { try { mySocket.close(); } catch (_) {} return; } // stale
    const wasDown = wasDisconnected;        // fires once per outage epoch
    connectedAt = Date.now();
    reconnectMs = RECONNECT_BASE_MS;
    console.log(`[hunt] WS connected → subscribing${wasDown ? ' (RESTORED)' : ''}`);
    mySocket.send(JSON.stringify({ method: 'subscribeNewToken' }));
    mySocket.send(JSON.stringify({ method: 'subscribeMigration' }));
    startHeartbeat();
    if (wasDown) { wasDisconnected = false; broadcastRestored().catch(() => {}); }
    wasEverConnected = true;
  });

  mySocket.addEventListener('message', (ev) => {
    if (myGen !== socketGen) return;        // ignore stale frames
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

  mySocket.addEventListener('close', (ev) => {
    if (myGen !== socketGen) return;        // stale — a newer socket owns the state
    connectedAt = null;
    stopHeartbeat();
    if (intentionallyStopped) return;       // process shutdown — don't reconnect
    if (wasEverConnected) wasDisconnected = true; // mark outage for RESTORED dedupe
    console.log(`[hunt] WS closed code=${ev.code} → reconnect in ${reconnectMs}ms`);
    scheduleReconnect(broadcaster);
  });

  mySocket.addEventListener('error', (e) => {
    if (myGen !== socketGen) return;
    console.error('[hunt] WS error:', e?.message || 'unknown');
  });
}

function scheduleReconnect(broadcaster) {
  cancelPendingReconnect();
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(broadcaster); }, reconnectMs);
  reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
}

function stop() {
  intentionallyStopped = true;
  socketGen++;                              // invalidate all handlers
  cancelPendingReconnect();
  stopHeartbeat();
  try { ws?.close(); } catch (_) {}
}

// Manual reconnect — fires when user taps [🔄 RECONNECT] in /huntstatus.
// socketGen bump invalidates the old socket's handlers cleanly, so we don't
// need (and must NOT use) the intentionallyStopped global here.
function forceReconnect() {
  if (!savedBroadcaster) return false;
  reconnectMs = RECONNECT_BASE_MS;
  socketGen++;                              // invalidate old socket's close/open
  cancelPendingReconnect();
  stopHeartbeat();
  try { ws?.close(); } catch (_) {}
  // Treat this as an outage so the RESTORED broadcast fires on success.
  if (wasEverConnected) wasDisconnected = true;
  setTimeout(() => connect(savedBroadcaster), 250);
  return true;
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
  savedBotRef = bot;
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

module.exports = { start, stop, addHunter, removeHunter, hunterCount, isHunter, status, listHunters, forceReconnect };
