// ── Oracle v14.0 Predator Hunt Mode ─────────────────────────────────────────
// Persistent WebSocket to wss://pumpportal.fun/api/data. Subscribes to
// new-token + migration events. Each event triggers a full Oracle scan in
// a concurrency-limited queue. Verdicts with Adj Vol/Liq ≥ MIN_VOLLIQ_BROADCAST
// (default 3x) are broadcast to every chat that has opted in via /hunt.
//
// v10.2.3: DexScreener fallback poller arms automatically when PumpPortal WS
// is stale or disconnected. Robust message normalization handles payload-shape
// changes. Full per-frame diagnostics exposed via /huntstatus.
//
// v10.2.4: Reconnect watchdog hammer — fires every RECONNECT_HAMMER_MS when
// disconnected, ensuring the bot never stays dark. WS handshake timeout and
// User-Agent header added. hardReconnect() consolidates all reconnect paths.
// pollDexFallback() accepts { force } to bypass stale-check on demand.
//
// v14.0: bonding-curve pipeline (LP=0 MC proxy, pump.fun API), Grok reasoning,
// HTML escape on symbol header, age gate on Dex-fallback stale candidates.

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const WS    = require('ws');          // explicit import — never rely on global WebSocket
const { fetchAll, fetchDeFadeVerification, fetchSocialData } = require('./fetcher');
const { scan }             = require('./scanner');
const { formatVerdict }    = require('./verdict');
const { getSoulVerdict }   = require('./reasoning');
const { recordScan, getPatternMemory } = require('./audit');
const { actionTimeLine } = require('./time');
const { getApiStats, markApi } = require('./telemetry');
const config               = require('./config');

const WS_BASE_URL      = 'wss://pumpportal.fun/api/data';
const DEX_PROFILES_URL = 'https://api.dexscreener.com/token-profiles/latest/v1';
const DEX_CTO_URL      = 'https://api.dexscreener.com/community-takeovers/latest/v1';
// v10.2.7: persist on Railway volume if available so /hunt survives redeploys.
function resolveHuntersFile() {
  if (process.env.HUNTERS_FILE) return process.env.HUNTERS_FILE;
  try { fs.accessSync('/data', fs.constants.W_OK); return '/data/hunters.json'; } catch (_) {}
  return path.join(__dirname, 'hunters.json');
}
const HUNTERS_FILE = resolveHuntersFile();
console.log(`[hunt] hunters file: ${HUNTERS_FILE}`);
const MIN_VOLLIQ_BROADCAST = Number.isFinite(config.MIN_VOLLIQ_BROADCAST) ? config.MIN_VOLLIQ_BROADCAST : 3.0;
const MIN_MARKET_CAP_SOL_PRESCAN = 30;   // skip dust launches (~$4K)
const WS_STALE_MS           = Number.isFinite(config.HUNT_WS_STALE_MS)            ? config.HUNT_WS_STALE_MS            : 120_000;
const FALLBACK_ENABLED      = config.HUNT_FALLBACK_ENABLED !== false;
const FALLBACK_POLL_MS      = Number.isFinite(config.HUNT_FALLBACK_POLL_MS)       ? config.HUNT_FALLBACK_POLL_MS       : 90_000;
const FALLBACK_MAX_PER_POLL = Number.isFinite(config.HUNT_FALLBACK_MAX_PER_POLL)  ? config.HUNT_FALLBACK_MAX_PER_POLL  : 10;
const RECONNECT_HAMMER_MS   = Number.isFinite(config.HUNT_RECONNECT_HAMMER_MS)    ? config.HUNT_RECONNECT_HAMMER_MS    : 15_000;
const WS_HANDSHAKE_TIMEOUT_MS = Number.isFinite(config.HUNT_WS_HANDSHAKE_TIMEOUT_MS) ? config.HUNT_WS_HANDSHAKE_TIMEOUT_MS : 15_000;
const WS_USER_AGENT         = config.HUNT_WS_USER_AGENT || 'OracleBot/10.2.4 Railway NodeWS';
const QUEUE_CONCURRENCY  = 2;
const SCAN_STALE_MS      = 30_000;
const RECONNECT_BASE_MS  = 2_000;
const RECONNECT_MAX_MS   = 60_000;
const PER_CA_COOLDOWN_MS = 5 * 60 * 1000; // don't re-broadcast same CA inside 5min
const READY_STATE_OPEN   = 1;
const HEARTBEAT_MS       = 20 * 1000;     // ping every 20s — Railway proxy cuts idle at ~30s

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildWsUrl() {
  const key = config.PUMPPORTAL_API_KEY || process.env.PUMPPORTAL_API_KEY || '';
  return key
    ? `${WS_BASE_URL}?api-key=${encodeURIComponent(key)}`
    : WS_BASE_URL;
}

function getAllowedHuntVerdicts() {
  if (config.HUNT_ALERT_VERDICTS) {
    return config.HUNT_ALERT_VERDICTS
      .split(',')
      .map(v => v.trim().toUpperCase())
      .filter(Boolean);
  }
  const mode = String(config.HUNT_ALERT_MODE || 'strict').toLowerCase();
  if (mode === 'all') {
    return ['BUY', 'RISKY_RUNNER', 'WATCH_VOL', 'WATCH_WASH', 'AVOID', 'NO_GO', 'SKIP'];
  }
  if (mode === 'watch') {
    return ['BUY', 'RISKY_RUNNER', 'WATCH_VOL', 'WATCH_WASH'];
  }
  return ['BUY'];
}

function shouldBroadcastHuntResult(result) {
  const allowed = getAllowedHuntVerdicts();
  const verdict = String(result?.verdict || '').toUpperCase();
  if (!allowed.includes(verdict)) {
    return { ok: false, reason: `verdict ${verdict || 'UNKNOWN'} not allowed in Hunt alert mode` };
  }
  const mode = String(config.HUNT_ALERT_MODE || 'strict').toLowerCase();
  if (mode === 'strict') {
    if (verdict !== 'BUY') {
      return { ok: false, reason: `strict mode requires BUY; got ${verdict}` };
    }
    if (!result.entryTier) {
      return { ok: false, reason: 'strict mode requires BUY with entryTier' };
    }
    if (result.noGoReason) {
      return { ok: false, reason: `strict mode blocked noGoReason: ${result.noGoReason}` };
    }
    if (result.watchReason) {
      return { ok: false, reason: `strict mode blocked watchReason: ${result.watchReason}` };
    }
  }
  return { ok: true, reason: null };
}

function markSuppressed(ca, result, reason) {
  stats.skipped++;
  stats.lastSkipReason = reason;
  stats.lastSkippedCA = ca;
  stats.lastSkippedVerdict = result?.verdict ?? null;
  stats.lastSkippedAt = Date.now();
  console.log(`[hunt] suppressed ${ca.slice(0, 8)} — ${reason}`);
}

function isSolanaCA(text) { return typeof text === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(text.trim()); }

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
    // v10.2.7: if persistence was wiped (Railway redeploy w/o volume) and an
    // owner is configured, auto-register them so the bot doesn't go blind.
    const ownerId = parseInt(config.OWNER_TELEGRAM_ID, 10);
    if (hunters.size === 0 && Number.isFinite(ownerId) && ownerId > 0) {
      hunters.add(ownerId);
      console.log(`[hunt] auto-registered OWNER_TELEGRAM_ID=${ownerId} as default hunter (list was empty)`);
      try { fs.writeFileSync(HUNTERS_FILE, JSON.stringify([...hunters], null, 2)); } catch (_) {}
    }
  } catch (e) { console.error('[hunt] loadHunters error:', e.message); }
}

function ensureHuntersLoaded() {
  if (!huntersLoaded) loadHunters();
}

function saveHunters() {
  try { fs.writeFileSync(HUNTERS_FILE, JSON.stringify([...hunters], null, 2)); }
  catch (e) { console.error('[hunt] saveHunters error:', e.message); }
}

function addHunter(chatId) {
  ensureHuntersLoaded();
  const had = hunters.has(chatId);
  hunters.add(chatId);
  saveHunters();

  // If the bot booted with zero hunters, fallback may have skipped itself.
  // Probe immediately when a chat enables /hunt (not unreffed — must fire).
  if (!had && savedBroadcaster) {
    setTimeout(() => pollDexFallback(savedBroadcaster, { force: true }), 0);
  }
  return !had;
}

function removeHunter(chatId) { ensureHuntersLoaded(); const had = hunters.has(chatId); hunters.delete(chatId); saveHunters(); return had; }
function hunterCount()        { ensureHuntersLoaded(); return hunters.size; }
function isHunter(chatId)     { ensureHuntersLoaded(); return hunters.has(chatId); }
function listHunters()        { ensureHuntersLoaded(); return [...hunters]; }

// ── Scan queue (bounded concurrency) ────────────────────────────────────────

const queue = [];
let active = 0;
const recentlyBroadcast = new Map(); // ca -> ts
const seenFallback      = new Map(); // ca -> ts
let fallbackTimer = null;
const stats = {
  scanned: 0,
  // v10.2.10: split broadcast accounting — candidates vs confirmed deliveries
  broadcast: 0,              // legacy alias kept for /huntping delta compat (= broadcastCandidates)
  broadcastCandidates: 0,    // passed vol/liq filter and entered broadcaster
  broadcastAttempts: 0,      // total sendMessage calls made
  broadcastDelivered: 0,     // confirmed Telegram deliveries (sendMessage resolved)
  broadcastFailed: 0,        // sendMessage threw (non-block error)
  lastBroadcastCA: null,
  lastBroadcastVerdict: null,
  lastBroadcastAt: null,
  lastBroadcastError: null,
  lastDeliveredAt: null,
  lastSkipReason: null,
  lastSkippedCA: null,
  lastSkippedVerdict: null,
  lastSkippedAt: null,
  skipped: 0,
  errors: 0,
  rawEvents: 0,
  ignoredEvents: 0,
  lastRawEvent: null,
  lastEvent: null,
  lastSource: null,
  lastIgnoredReason: null,
  fallbackPolls: 0,
  fallbackEnqueued: 0,
  fallbackErrors: 0,
  hardReconnects: 0,
  lastReconnectReason: null,
  lastWsClose: null,
};

// Ring buffer of last N candidates that passed the Hunt vol/liq filter.
// Persists in memory only — used by /huntlast to show delivery status.
const lastCandidates = [];
const MAX_LAST_CANDIDATES = 5;

function enqueue(job, broadcaster) {
  job.enqueuedAt = Date.now();
  queue.push({ job, broadcaster });
  pump();
}

function markIgnored(reason, msg) {
  stats.ignoredEvents++;
  stats.lastIgnoredReason = reason;
  if (stats.ignoredEvents <= 10 || stats.ignoredEvents % 100 === 0) {
    let sample = '';
    try { sample = JSON.stringify(msg).slice(0, 500); } catch (_) { sample = '[unserializable]'; }
    console.log(`[hunt] ignored WS frame (${reason}): ${sample}`);
  }
}

function cleanupMaps() {
  const now = Date.now();
  const broadcastTtl = PER_CA_COOLDOWN_MS * 3;
  for (const [ca, ts] of recentlyBroadcast) {
    if (now - ts > broadcastTtl) recentlyBroadcast.delete(ca);
  }
  const fallbackTtl = 30 * 60 * 1000;
  for (const [ca, ts] of seenFallback) {
    if (now - ts > fallbackTtl) seenFallback.delete(ca);
  }
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
  const { ca, eventType, source = 'unknown' } = job;
  try {
    // Per-CA cooldown — avoid spamming the same token across new + migration events
    const last = recentlyBroadcast.get(ca);
    if (last && Date.now() - last < PER_CA_COOLDOWN_MS) { stats.skipped++; return; }

    stats.scanned++;
    const [data, social] = await Promise.all([
      fetchAll(ca, { quickFilter: true }),
      fetchSocialData(ca),
    ]);
    if (!data?.codex) { stats.skipped++; return; }
    data.social = social;

    const result = scan(data);
    result.social = social;
    result.scannedAt = Date.now();
    const adjustedVolLiq = result.signals?.adjustedVolLiq ?? 0;

    // Pro/Elite dev floor: 2.0x — see proven devs before they move, not after.
    // Standard floor (MIN_VOLLIQ_BROADCAST = 3.0x) applies to everyone else.
    const isPilotDev     = result.signals?.isEliteDev || result.signals?.isProPilot;
    const broadcastFloor = isPilotDev ? 2.0 : MIN_VOLLIQ_BROADCAST;
    if (adjustedVolLiq < broadcastFloor) { stats.skipped++; return; }

    // Age gate for Dex-fallback candidates: DexScreener token-profiles and
    // community-takeovers endpoints return tokens of ANY age.
    const ageMinutes = data.codex?.ageMinutes ?? null;
    const AGE_MAX_FALLBACK = (config.AGE_MAX_MIN || 60) * 3; // 3h for profile/CTO
    if (source?.startsWith('dexscreener') && ageMinutes !== null && ageMinutes > AGE_MAX_FALLBACK) {
      console.log(`[hunt] ${ca} age-gated: ${ageMinutes}m > ${AGE_MAX_FALLBACK}m (${source})`);
      stats.skipped++; return;
    }

    const rawSym = data.codex?.symbol || data.pump?.symbol || '???';

    // DeFade must run before final broadcast gate so HARD_SKIP can suppress alerts.
    if (result.verdict === 'BUY') {
      const v = await fetchDeFadeVerification(ca, { lp: result.signals?.lp });
      result.deFadeVerification = v;
      if (v.action === 'HARD_SKIP') {
        result.verdict = 'NO_GO';
        result.entryTier = null;
        result.noGoReason = `DeFade verification: ${v.reason}`;
      }
    } else {
      markApi('DeFade', { skipped: true, meta: { reason: 'non_buy_verdict', verdict: result.verdict } });
      result.deFadeVerification = {
        action: 'SKIPPED',
        reason: `Skipped because verdict was ${result.verdict}; DeFade only runs on BUY to preserve quota.`,
        verified: false,
      };
    }

    // Audit every candidate that clears the Hunt vol floor, even when Telegram is suppressed.
    recordScan({
      ca,
      symbol:         rawSym,
      verdict:        result.verdict,
      entryTier:      result.entryTier,
      mc:             result.signals?.marketCap,
      adjustedVolLiq: result.signals?.adjustedVolLiq,
      top10Pct:       result.signals?.top10Pct,
      washPct:        result.signals?.washPct,
      isEliteDev:     result.signals?.isEliteDev,
      successRatePct: result.signals?.successRatePct,
      devLaunches:    result.signals?.totalLaunches,
      source:         'hunt',
    });

    const finalGate = shouldBroadcastHuntResult(result);
    if (!finalGate.ok) {
      markSuppressed(ca, result, finalGate.reason);
      return;
    }

    // Grok Soul reasoning is additive only; it never flips scanner verdicts.
    result.soulVerdict = await getSoulVerdict(result, { ...data, patternMemory: getPatternMemory() }).catch(err => ({
      available: false,
      verdict: null,
      reasoning: `⚪ OFFLINE — Grok call failed: ${String(err.message).slice(0, 120)}. Scanner verdict only.`,
    }));
    result.soulReasoning = result.soulVerdict?.reasoning ?? null;

    result.dataUsed = {
      dex: !!data.codex,
      pump: !!data.pump,
      birdeye: !!data.birdeye,
      solanaTracker: !!data.stToken || !!data.stDeployer || data.holders?.source === 'solanatracker-holders',
      socialData: !!social?.available,
      helius: data.holders?.source === 'helius',
      codex: data.holders?.source === 'codex',
      deFade: !!result.deFadeVerification && result.deFadeVerification.action !== 'SKIPPED',
      grok: !!result.soulReasoning,
    };

    const message = formatVerdict(result, ca);
    const mc     = result.signals?.marketCap || 0;
    // Escape HTML — token symbols can contain <, >, & which break Telegram HTML parse mode.
    const symbol = rawSym.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const header = `🎯 <b>HUNT MODE — ${eventType.toUpperCase()}</b>
` +
                   `${actionTimeLine('Detected At', result.scannedAt)}
` +
                   `Detected: <code>${symbol}</code> | Adj Vol/Liq: <b>${adjustedVolLiq.toFixed(1)}x</b>
` +
                   `Source: <code>${source}</code>

`;

    stats.broadcastCandidates++;
    stats.broadcast = stats.broadcastCandidates; // keep legacy alias in sync
    stats.lastBroadcastCA      = ca;
    stats.lastBroadcastVerdict = result.verdict;
    stats.lastBroadcastAt      = Date.now();

    const delivery = await broadcaster(ca, mc, header + message, result.verdict);
    recentlyBroadcast.set(ca, Date.now());

    const candidateEntry = {
      ca,
      symbol,
      adjustedVolLiq,
      verdict:   result.verdict,
      mc,
      attempted: delivery.attempted,
      delivered: delivery.delivered,
      failed:    delivery.failed,
      error:     delivery.errors[0] || null,
      ts:        Date.now(),
    };
    lastCandidates.unshift(candidateEntry);
    if (lastCandidates.length > MAX_LAST_CANDIDATES) lastCandidates.pop();

    console.log(`[hunt] broadcast ${ca.slice(0,8)} — delivered:${delivery.delivered} failed:${delivery.failed}${delivery.errors[0] ? ` err:${delivery.errors[0]}` : ''}`);
  } catch (e) {
    stats.errors++;
    console.error(`[hunt] scan error for ${ca}:`, e?.stack || e.message);
  }
}

// ── WebSocket client ────────────────────────────────────────────────────────

let ws = null;
let reconnectMs = RECONNECT_BASE_MS;
let intentionallyStopped = false;    // true only during shutdown via stop()
let connectedAt = null;
let heartbeatTimer = null;
let reconnectTimer = null;           // pending reconnect (cancelled on new connect)
let reconnectWatchdogTimer = null;   // v10.2.4 reconnect hammer
let socketGen = 0;                   // bumped per connect; stale handlers no-op
let wasEverConnected = false;        // first connect ≠ "restored"
let wasDisconnected = false;         // outage epoch flag — gates dedupe of RESTORED
let savedBroadcaster = null;         // for forceReconnect() + restoration ping
let savedBotRef = null;              // for sending restoration alert to hunters

// v10.2.6 deep diagnostics — surfaces internal lifecycle state in /huntstatus
// so we can debug Railway without log access. These tell us:
//   startedAt          → did start() actually run? (null = NO)
//   watchdogArmedAt    → did the watchdog setInterval get registered?
//   watchdogTicks      → is the watchdog interval ACTUALLY firing?
//   connectAttempts    → how many times has connect() been called?
//   lastConnectAt      → when was the most recent connect() call?
//   lastConstructError → did the WS constructor throw? (network/DNS issue)
let startedAt          = null;
let watchdogArmedAt    = null;
let watchdogTicks      = 0;
let connectAttempts    = 0;
let lastConnectAt      = null;
let lastConstructError = null;

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === READY_STATE_OPEN) {
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

function terminateSocket(reason = 'unknown') {
  const s = ws;
  ws = null;
  if (!s) return;
  try {
    if (typeof s.terminate === 'function') s.terminate();
    else s.close();
    console.log(`[hunt] socket terminated (${reason})`);
  } catch (e) {
    console.error(`[hunt] socket terminate failed (${reason}):`, e.message);
  }
}

function hardReconnect(broadcaster, reason) {
  if (!broadcaster) return false;
  stats.hardReconnects++;
  stats.lastReconnectReason = reason;
  reconnectMs = RECONNECT_BASE_MS;
  socketGen++;
  connectedAt = null;
  cancelPendingReconnect();
  stopHeartbeat();
  terminateSocket(reason);
  if (wasEverConnected) wasDisconnected = true;

  // Poll fallback immediately while PumpPortal is being recovered.
  pollDexFallback(broadcaster, { force: true }).catch(e => {
    console.error('[hunt] fallback during hardReconnect failed:', e?.message || e);
  });

  // NOT unreffed — reconnect must complete even if event loop is otherwise idle.
  setTimeout(() => connect(broadcaster), 250);
  return true;
}

function startReconnectWatchdog(broadcaster) {
  stopReconnectWatchdog();
  watchdogArmedAt = Date.now();
  watchdogTicks = 0;
  // NOTE: deliberately NOT unreffed — this must fire on Railway even if all
  // other timers are unreffed. It is the last-resort reconnect guarantee.
  reconnectWatchdogTimer = setInterval(() => {
    watchdogTicks++;
    if (intentionallyStopped) return;
    const disconnected = !connectedAt || !ws || ws.readyState === WS.CLOSED || ws.readyState === WS.CLOSING;
    if (disconnected) {
      console.error(`[hunt] reconnect watchdog tick #${watchdogTicks}: WS is disconnected; hard reconnecting`);
      hardReconnect(broadcaster, 'watchdog-disconnected');
      return;
    }
    if (wsIsStale()) {
      pollDexFallback(broadcaster, { force: true }).catch(() => {});
    }
  }, RECONNECT_HAMMER_MS);
  console.log(`[hunt] reconnect watchdog armed — ${Math.floor(RECONNECT_HAMMER_MS / 1000)}s`);
}

function stopReconnectWatchdog() {
  if (reconnectWatchdogTimer) { clearInterval(reconnectWatchdogTimer); reconnectWatchdogTimer = null; }
}

// Normalise a raw PumpPortal WS frame into { ok, ca, eventType, mcSol }.
// Handles any payload envelope (msg.data, msg.result, msg.payload, or root).
// Robust to PumpPortal changing field names — tries every known CA path.
function normalizeWsMessage(msg) {
  const payload = msg?.data || msg?.result || msg?.payload || msg;
  const ca =
    payload?.mint ||
    payload?.tokenAddress ||
    payload?.address ||
    payload?.ca ||
    payload?.contractAddress ||
    payload?.token?.mint ||
    payload?.token?.address ||
    payload?.baseToken?.address;

  if (!isSolanaCA(ca)) return { ok: false, reason: 'NO_VALID_CA' };

  const rawType = String(payload?.txType || payload?.type || payload?.event || payload?.method || '').toLowerCase();
  const eventType =
    rawType.includes('create') || rawType.includes('new')
      ? 'new'
      : rawType.includes('migration') || rawType.includes('migrate') || payload?.pool || payload?.raydiumPool
        ? 'migration'
        : 'event';

  const mcSolRaw = payload?.marketCapSol ?? payload?.mcSol ?? null;
  const mcSol    = mcSolRaw == null ? null : Number(mcSolRaw);

  return {
    ok: true,
    ca,
    eventType,
    mcSol: Number.isFinite(mcSol) ? mcSol : null,
  };
}

// Fires WS_STALE_MS after each connect. If no usable launch events arrived,
// logs a diagnostic (so Railway logs show the stale condition immediately).
function warnIfWsStale(myGen) {
  setTimeout(() => {
    if (myGen !== socketGen || !connectedAt) return;
    const stale = !stats.lastEvent || Date.now() - stats.lastEvent > WS_STALE_MS;
    if (stale) {
      const rawLine = stats.lastRawEvent
        ? `raw frames seen ${Math.floor((Date.now() - stats.lastRawEvent) / 1000)}s ago`
        : 'no raw frames seen';
      console.error(`[hunt] WS connected but no usable launch events (${rawLine}). PumpPortal may require API key, be stale, blocked, or changed payload shape.`);
    }
  }, WS_STALE_MS);
}

function connect(broadcaster) {
  cancelPendingReconnect();
  savedBroadcaster = broadcaster;
  // Bump generation BEFORE constructing — any stale close/open from a prior
  // socket will see myGen !== socketGen and no-op. This is the fix for the
  // forceReconnect → old-close-after-new-connect race.
  const myGen = ++socketGen;
  connectAttempts++;
  lastConnectAt = Date.now();
  let mySocket;
  try {
    const url = buildWsUrl();
    mySocket = new WS(url, {
      handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
      perMessageDeflate: false,
      followRedirects: true,
      headers: {
        'User-Agent': WS_USER_AGENT,
        'Origin':     'https://pumpportal.fun',
      },
    });
    ws = mySocket;
    lastConstructError = null;
    console.log(`[hunt] connect attempt #${connectAttempts} → PumpPortal WS (${config.PUMPPORTAL_API_KEY ? 'API key configured' : 'no API key'})`);
  }
  catch (e) {
    lastConstructError = { msg: e.message, ts: Date.now() };
    console.error('[hunt] WS construct error:', e.message);
    scheduleReconnect(broadcaster);
    return;
  }

  mySocket.addEventListener('open', () => {
    if (myGen !== socketGen) { try { mySocket.close(); } catch (_) {} return; } // stale
    const wasDown = wasDisconnected;        // fires once per outage epoch
    connectedAt = Date.now();
    reconnectMs = RECONNECT_BASE_MS;
    console.log(`[hunt] WS connected → subscribing${wasDown ? ' (RESTORED)' : ''}`);
    mySocket.send(JSON.stringify({ method: 'subscribeNewToken' }));
    mySocket.send(JSON.stringify({ method: 'subscribeMigration' }));
    startHeartbeat();
    warnIfWsStale(myGen);
    if (wasDown) { wasDisconnected = false; broadcastRestored().catch(() => {}); }
    wasEverConnected = true;
  });

  mySocket.addEventListener('message', (ev) => {
    if (myGen !== socketGen) return;        // ignore stale frames
    try {
      const msg = JSON.parse(ev.data);
      stats.rawEvents++;
      stats.lastRawEvent = Date.now();

      const normalized = normalizeWsMessage(msg);
      if (!normalized.ok) { markIgnored(normalized.reason, msg); return; }

      const { ca, eventType, mcSol } = normalized;
      stats.lastEvent = Date.now();
      stats.lastSource = 'pumpportal-ws';
      // If marketCapSol is missing, do NOT skip. Old code treated missing as 0
      // and could silently drop every new-token event if PumpPortal changed fields.
      if (eventType === 'new' && mcSol != null && mcSol < MIN_MARKET_CAP_SOL_PRESCAN) { stats.skipped++; return; }

      enqueue({ ca, eventType, mcSol, source: 'pumpportal-ws' }, broadcaster);
    } catch (e) { markIgnored('MALFORMED_JSON', ev?.data || ''); }
  });

  mySocket.addEventListener('close', (ev) => {
    if (myGen !== socketGen) return;        // stale — a newer socket owns the state
    connectedAt = null;
    stopHeartbeat();
    if (intentionallyStopped) return;       // process shutdown — don't reconnect
    if (wasEverConnected) wasDisconnected = true; // mark outage for RESTORED dedupe
    stats.lastWsClose = {
      code:   ev?.code   ?? null,
      reason: ev?.reason ? String(ev.reason).slice(0, 120) : '',
      ts:     Date.now(),
    };
    console.log(`[hunt] WS closed code=${ev.code} reason="${stats.lastWsClose.reason}" → reconnect in ${reconnectMs}ms`);
    pollDexFallback(broadcaster, { force: true }).catch(() => {});
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
  stopReconnectWatchdog();
  stopDexFallback();
  stopHeartbeat();
  terminateSocket('stop');
}

// Manual reconnect — fires when user taps [🔄 RECONNECT] in /huntstatus.
// Delegates to hardReconnect() which handles all bookkeeping atomically.
function forceReconnect() {
  if (!savedBroadcaster) return false;
  return hardReconnect(savedBroadcaster, 'manual-forceReconnect');
}

// ── DexScreener fallback poller ───────────────────────────────────────────────
// Polls two public DexScreener endpoints (no key required) when PumpPortal WS
// is stale or disconnected. Prevents total blindness during WS outages.
// Each CA is deduplicated via seenFallback (30m TTL) to avoid repeated scans.

function wsIsStale() {
  return !stats.lastEvent || Date.now() - stats.lastEvent > WS_STALE_MS;
}

function asArray(x) {
  if (Array.isArray(x)) return x;
  return x ? [x] : [];
}

function normalizeDexCandidate(item, source) {
  const ca = item?.tokenAddress || item?.baseToken?.address || item?.address || item?.mint;
  if (!isSolanaCA(ca)) return null;
  if (item?.chainId && item.chainId !== 'solana') return null;
  return { ca, eventType: source, source };
}

async function pollDexFallback(broadcaster, { force = false } = {}) {
  stats.fallbackAttempts = (stats.fallbackAttempts || 0) + 1;
  if (!FALLBACK_ENABLED || hunters.size === 0) return;
  // Fallback only activates when PumpPortal is stale or disconnected.
  // It is not a replacement for the firehose; it prevents total blindness.
  if (!force && connectedAt && !wsIsStale()) return;

  stats.fallbackPolls++;
  cleanupMaps();

  try {
    const [profilesRes, ctoRes] = await Promise.all([
      fetch(DEX_PROFILES_URL, { headers: { Accept: 'application/json' }, timeout: 8000 }).catch(e => ({ ok: false, _err: e })),
      fetch(DEX_CTO_URL,      { headers: { Accept: 'application/json' }, timeout: 8000 }).catch(e => ({ ok: false, _err: e })),
    ]);

    const candidates = [];
    if (profilesRes.ok) {
      const data = await profilesRes.json();
      for (const item of asArray(data)) {
        const c = normalizeDexCandidate(item, 'dexscreener-profile');
        if (c) candidates.push(c);
      }
    } else {
      console.error('[hunt] Dex fallback profiles HTTP error:', profilesRes.status || profilesRes._err?.message);
    }

    if (ctoRes.ok) {
      const data = await ctoRes.json();
      for (const item of asArray(data)) {
        const c = normalizeDexCandidate(item, 'dexscreener-cto');
        if (c) candidates.push(c);
      }
    } else {
      console.error('[hunt] Dex fallback CTO HTTP error:', ctoRes.status || ctoRes._err?.message);
    }

    let enqueued = 0;
    for (const c of candidates) {
      if (enqueued >= FALLBACK_MAX_PER_POLL) break;
      if (seenFallback.has(c.ca)) continue;
      seenFallback.set(c.ca, Date.now());
      enqueue(c, broadcaster);
      enqueued++;
    }
    stats.fallbackEnqueued += enqueued;
    if (enqueued > 0) {
      stats.lastSource = 'dexscreener-fallback';
      console.log(`[hunt] Dex fallback enqueued ${enqueued} candidate(s)`);
    }
  } catch (e) {
    stats.fallbackErrors++;
    console.error('[hunt] Dex fallback poll error:', e?.stack || e.message);
  }
}

function startDexFallback(broadcaster) {
  stopDexFallback();
  if (!FALLBACK_ENABLED) {
    console.log('[hunt] Dex fallback disabled by HUNT_FALLBACK_ENABLED=false');
    return;
  }
  // NOT unreffed — fallback polling is the safety net when PumpPortal WS fails.
  fallbackTimer = setInterval(() => pollDexFallback(broadcaster), FALLBACK_POLL_MS);
  // Start immediately. If there are no hunters, addHunter() forces another probe.
  setTimeout(() => pollDexFallback(broadcaster, { force: true }), 0);
  // Give PumpPortal a short first chance, then probe again if it is still stale.
  setTimeout(() => pollDexFallback(broadcaster, { force: true }), Math.min(15_000, FALLBACK_POLL_MS));
  console.log(`[hunt] Dex fallback armed — poll ${Math.floor(FALLBACK_POLL_MS / 1000)}s, max ${FALLBACK_MAX_PER_POLL}/poll`);
}

function stopDexFallback() {
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
}

// ── Status ───────────────────────────────────────────────────────────────────

function status() {
  const staleWs = connectedAt !== null && wsIsStale();
  const apiStats = getApiStats();
  return {
    alertMode: config.HUNT_ALERT_MODE || 'strict',
    allowedVerdicts: getAllowedHuntVerdicts(),
    socialDataKeyConfigured: !!process.env.SOCIALDATA_API_KEY,
    socialDataCalls: apiStats.SocialData?.calls ?? 0,
    grokKeyConfigured: !!process.env.XAI_API_KEY,
    grokCalls: apiStats.Grok?.calls ?? 0,
    grokFails: apiStats.Grok?.fail ?? 0,
    connected:  connectedAt !== null,
    staleWs,
    uptimeMs:   connectedAt ? Date.now() - connectedAt : 0,
    queueDepth: queue.length,
    activeScans: active,
    hunters:    hunterCount(),
    hunterIds:  listHunters(),
    pumpPortalApiKeyConfigured: !!config.PUMPPORTAL_API_KEY,
    fallbackEnabled: FALLBACK_ENABLED,
    reconnectHammerMs: RECONNECT_HAMMER_MS,
    hardReconnects: stats.hardReconnects,
    lastReconnectReason: stats.lastReconnectReason,
    lastWsClose: stats.lastWsClose,
    // v10.2.6 deep diagnostics
    startedAt,
    watchdogArmedAt,
    watchdogTicks,
    connectAttempts,
    lastConnectAt,
    lastConstructError,
    wsReadyState: ws ? ws.readyState : null,
    lastCandidates: [...lastCandidates],
    ...stats,
  };
}

// ── Public init ─────────────────────────────────────────────────────────────

function start(bot, buildKeyboard) {
  startedAt = Date.now();
  loadHunters();
  savedBotRef = bot;
  // v10.2.10: broadcaster returns { attempted, delivered, failed, errors }.
  // Only increments broadcastDelivered when sendMessage resolves. HTML parse
  // failures are retried once with plain text before counting as failed.
  const broadcaster = async (ca, mc, html, verdict = null) => {
    if (hunters.size === 0) return { attempted: 0, delivered: 0, failed: 0, errors: [] };
    const reply_markup = buildKeyboard(ca, mc, verdict);
    let attempted = 0, delivered = 0, failed = 0;
    const errors = [];

    for (const chatId of hunters) {
      attempted++;
      try {
        await bot.telegram.sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup });
        delivered++;
        stats.broadcastDelivered++;
        stats.lastDeliveredAt = Date.now();
      } catch (e) {
        const errMsg   = e.description || e.message || 'unknown';
        const isBlock  = e.code === 403 || /blocked|chat not found|user is deactivated/i.test(errMsg);
        const isHtmlFail = /can't parse entities|parse error|bad request.*parse/i.test(errMsg);

        if (isBlock) {
          console.log(`[hunt] dropping unreachable chat ${chatId}: ${errMsg}`);
          hunters.delete(chatId); saveHunters();
          failed++;
          stats.broadcastFailed++;
          const note = `chat ${chatId}: blocked/deactivated`;
          errors.push(note);
          stats.lastBroadcastError = note;
          continue;
        }

        if (isHtmlFail) {
          // Retry once with plain text — strips all HTML tags
          try {
            const plain = html.replace(/<[^>]*>/g, '');
            await bot.telegram.sendMessage(chatId, plain, { reply_markup });
            delivered++;
            stats.broadcastDelivered++;
            stats.lastDeliveredAt = Date.now();
            console.warn(`[hunt] HTML_PARSE_FAIL_RETRIED_PLAIN_TEXT for chat ${chatId}`);
            continue;
          } catch (e2) {
            const note2 = `chat ${chatId}: HTML fail + plain retry fail — ${e2.description || e2.message}`;
            errors.push(note2);
            stats.lastBroadcastError = note2;
            console.error('[hunt] broadcast error (plain fallback):', e2.message);
          }
        } else {
          const note = `chat ${chatId}: ${errMsg}`;
          errors.push(note);
          stats.lastBroadcastError = note;
          console.error('[hunt] broadcast error:', errMsg);
        }
        failed++;
        stats.broadcastFailed++;
      }
    }

    stats.broadcastAttempts += attempted;
    return { attempted, delivered, failed, errors };
  };
  connect(broadcaster);
  startDexFallback(broadcaster);
  startReconnectWatchdog(broadcaster);
  console.log(`[hunt] hunt mode started — ${hunters.size} hunter(s) registered`);
}

// v10.2.7: /huntping forces one Dex fallback poll and returns the stats delta
// so users can verify the fallback path is alive without waiting for the next
// scheduled poll (which may be up to 90s away).
async function pingFallback() {
  if (!savedBroadcaster) return { ok: false, reason: 'start() never called — Hunt engine not initialized' };
  const snap = () => ({
    attempts:  stats.fallbackAttempts  || 0,
    polls:     stats.fallbackPolls     || 0,
    enqueued:  stats.fallbackEnqueued  || 0,
    scanned:   stats.scanned           || 0,
    broadcast: stats.broadcast         || 0,
    skipped:   stats.skipped           || 0,
    errors:    stats.fallbackErrors    || 0,
  });
  const before = snap();
  try {
    await pollDexFallback(savedBroadcaster, { force: true });
  } catch (e) {
    return { ok: false, reason: `pollDexFallback threw: ${e.message}` };
  }
  // Give the queue a beat to drain the immediate ones so the delta is meaningful.
  await new Promise(r => setTimeout(r, 1500));
  const after = snap();
  const delta = Object.fromEntries(Object.keys(before).map(k => [k, after[k] - before[k]]));
  return { ok: true, delta };
}

// v10.2.10: direct test of the broadcast path for /hunttest command.
// Sends a plain test message to a specific chatId using the bot ref from start().
async function testBroadcast(chatId) {
  if (!savedBotRef) return { ok: false, reason: 'Hunt engine not started (savedBotRef is null)' };
  try {
    await savedBotRef.telegram.sendMessage(
      chatId,
      `✅ <b>Hunt broadcaster test delivered to chatId ${chatId}</b>\nBroadcast path is working correctly. If Hunt signals are not arriving, the issue is upstream (filter, WS, or delivery error — check /huntstatus).`,
      { parse_mode: 'HTML' }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.description || e.message || 'unknown Telegram error' };
  }
}

module.exports = { start, stop, addHunter, removeHunter, hunterCount, isHunter, status, listHunters, forceReconnect, pingFallback, testBroadcast, shouldBroadcastHuntResult, getAllowedHuntVerdicts };
