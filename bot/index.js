require('dotenv').config();
const fs       = require('fs');
const http     = require('http');
const { Telegraf } = require('telegraf');
const { fetchAll, fetchDeFadeVerification, fetchSocialData, fetchForensic, fetchMcOnly, runDeFadeTest } = require('./fetcher');
const { scan, evaluateRequiredStack } = require('./scanner');
const { formatVerdict } = require('./verdict');
const { actionTimeLine } = require('./time');
const { apiStatusHtml, markApi } = require('./telemetry');
const config    = require('./config');
const { probeXaiConnection, getSoulVerdict } = require('./reasoning');
const { evaluateHolderCohort, runDeepForensics } = require('./forensics');
const {
  recordScan,
  startAuditLoop,
  getAuditReport,
  getPatternMemory,
  getAuditPendingReport,
  processPendingOnce,
  matchLearnedPattern,
  getMemoryStats: getAuditMemoryStats,
  findOriginalScanEntry,
  saveForcedLearnRecord,
  getLogReport,
  getLogForCa,
} = require('./audit');
const { resolveTraderClass } = require('./trader-ui');

function ensureDataDir() {
  const dataDir = process.env.DATA_DIR || '/data';
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (dataDir === '/data') {
      const rootDev = fs.statSync('/').dev;
      const dataDev = fs.statSync('/data').dev;
      if (rootDev === dataDev) {
        console.warn('[startup] /data exists but appears to share the root filesystem. Configure Railway volume oracle-data mounted at /data for persistence.');
      }
    }
  } catch (e) {
    console.warn(`[startup] failed to prepare ${dataDir}: ${e.message}`);
  }
}

ensureDataDir();

const tracker   = require('./tracker');
const hunt      = require('./hunt');
const watchlist = require('./watchlist');

function canWriteDir(dirPath) {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function logMemoryStartupState() {
  const auditMemory = getAuditMemoryStats();
  const trackerMemory = tracker.getMemoryStats ? tracker.getMemoryStats() : {
    positionsFile: process.env.POSITIONS_FILE || '/data/positions.json',
    trackedPositionsCount: tracker.list().length,
    usingFallbackFile: false,
  };
  const dataDir = process.env.DATA_DIR || '/data';
  const dataDirExists = fs.existsSync(dataDir);
  const dataDirWritable = dataDirExists && canWriteDir(dataDir);

  console.log('[startup] memory state');
  console.log(`[startup] DATA_DIR: ${dataDir} | exists=${dataDirExists} | writable=${dataDirWritable}`);
  console.log(`[startup] AUDIT_FILE: ${auditMemory.auditFile} | queue=${auditMemory.queueCount} | history=${auditMemory.historyCount}`);
  console.log(`[startup] POSITIONS_FILE: ${trackerMemory.positionsFile} | tracked=${trackerMemory.trackedPositionsCount}`);
  if (trackerMemory.usingFallbackFile) {
    console.warn('[startup] Guardian positions file is using repo-local fallback (bot/positions.json).');
  }
}

// ── Railway health check ───────────────────────────────────────────────────────
// Railway treats every service as a web service and kills the process if it
// gets no HTTP 200 on $PORT within the health-check window (~60s). Without
// this listener the bot fires its startup polls, sends a burst of signals, then
// Railway kills it — making Hunt Mode look like it "only works at deploy."
// This tiny server costs nothing and keeps the process alive indefinitely.
const HEALTH_PORT = parseInt(process.env.PORT, 10) || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    bot:    config.ORACLE_VERSION,
    uptime: Math.floor(process.uptime()),
  }));
}).listen(HEALTH_PORT, () => {
  console.log(`[health] HTTP check listening on :${HEALTH_PORT}`);
});

if (!config.TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set. Exiting.');
  process.exit(1);
}

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
const forceFullNextScanChats = new Set();
logMemoryStartupState();

bot.catch((err, ctx) => {
  const updateType = ctx?.updateType || 'unknown';
  console.error(`[telegram] handler error during ${updateType}:`, err?.stack || err.message);
});

function isSolanaCA(text) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(text.trim());
}

// ── Inline keyboard for each scan result ─────────────────────────────────────

function buildKeyboard(ca, currentMc, verdict) {
  const mc = Math.floor(currentMc || 0);
  const rows = [
    [
      { text: '👀 TRACK', callback_data: `track:${ca}:${mc}` },
      { text: '🔔 ALERT', callback_data: `alert:${ca}:${mc}` },
    ],
    [
      { text: '📌 LEARN', callback_data: `learn:${ca}` },
      { text: '🧠 DETAILS', callback_data: `details:${ca}` },
    ],
    [
      { text: '🔎 FORENSICS', callback_data: `forensics:${ca}:${mc}` },
    ],
  ];
  return { inline_keyboard: rows };
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n)) || Number(n) <= 0) return 'N/A';
  const v = Number(n);
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${v.toFixed(2)}`;
}

function summarizeBaseline(sig) {
  if (!sig) return 'pending';
  const fields = [sig.marketCap, sig.lp, sig.holderCount, sig.top10Pct, sig.top50Pct];
  const haveCount = fields.filter(v => v != null).length;
  if (haveCount === 0) return 'pending';
  return haveCount === fields.length ? 'complete' : 'partial';
}

async function beginTrackingAnyCa({ ca, chatId, preferredMc = null }) {
  const shortCa = `${ca.slice(0, 6)}...${ca.slice(-4)}`;
  let sig = null;
  try { sig = await fetchForensic(ca); } catch (_) {}

  const baseline = summarizeBaseline(sig);
  const entryMc = sig?.marketCap ?? preferredMc ?? 0;
  const entryLp = sig?.lp ?? null;
  const holders = sig?.holderCount ?? null;
  const top10 = sig?.top10Pct ?? null;
  const top50 = sig?.top50Pct ?? null;
  const added = tracker.track(ca, chatId, entryMc, 'MANUAL', 'DISCOVERY', null, holders, top10, top50, entryLp);
  if (!added) {
    const reason = tracker.list().length >= 10 ? 'max 10 positions reached' : 'already tracking this token';
    return { ok: false, reason, shortCa };
  }

  if (baseline !== 'complete') tracker.maybeEstablishBaseline(ca, bot);

  const msg =
    `✅ GUARDIAN TRACKING STARTED\n` +
    `CA: ${shortCa}\n` +
    `MC: ${fmtUsd(entryMc)}\n` +
    `LP: ${fmtUsd(entryLp)}\n` +
    `Holders: ${holders ?? 'N/A'}\n` +
    `Top 10: ${top10 != null ? top10.toFixed(1) + '%' : 'N/A'}\n` +
    `Top 50: ${top50 != null ? top50.toFixed(1) + '%' : 'N/A'}\n` +
    `Baseline: ${baseline}\n` +
    `Next poll: 60s`;

  return { ok: true, shortCa, message: msg, baseline };
}

async function executeOracleScan(ca, {
  source = 'scan',
  includeVerification = true,
  includeReasoning = true,
  recordAuditEntry = false,
} = {}) {
  const original = findOriginalScanEntry(ca);
  const [data, social] = await Promise.all([
    fetchAll(ca, {
      manualMode: true,
      skipCodex: config.CODEX_MODE === 'off',
      skipGMGN: true,
    }),
    fetchSocialData(ca),
  ]);

  if (!data.codex && !data.pump) {
    return { ok: false, reason: 'NO_DATA' };
  }

  data.social = social;
  data.firstSeenMc = original?.firstSeenMc ?? original?.scanMc ?? null;
  const result = scan(data);
  const forensic = evaluateHolderCohort({
    ca,
    marketCap: result.signals?.marketCap,
    ageMinutes: result.signals?.ageMinutes,
    holders: data.holders,
    topWallets: data.holders?.topWallets || [],
    bundle: data.bundle,
  });
  result.forensics = forensic;
  result.scannedAt = Date.now();
  result.social = social;

  const memoryMatch = matchLearnedPattern(result);
  result.patternMatch = memoryMatch;
  const currentClass = String(result?.oracleScore?.class || result?.verdict || '').toUpperCase();
  const classEligible = ['NO_GO', 'WATCH', 'WATCH_VOL', 'WATCH_WASH', 'DIRTY_RUNNER_WATCH', 'PEARL_WATCH', 'RISKY_RUNNER', 'SKIP'].includes(currentClass);
  const catastrophic = ['confirmed_sybil', 'wash_over_50', 'malformed_or_missing_market_cap', 'liquidity_malformed'];
  const hasCatastrophic = (result?.oracleScore?.hardBlocks || []).some(b => catastrophic.includes(b));
  if (classEligible && memoryMatch?.matched && !hasCatastrophic) {
    result.verdict = 'MISSED_WINNER_MATCH';
    result.entryTier = null;
    if (result.oracleScore) result.oracleScore.class = 'MISSED_WINNER_MATCH';
    result.missedWinnerMatch = {
      memoryMatched: true,
      confidence: memoryMatch.confidence,
      strong: !!memoryMatch.strong,
      reasons: memoryMatch.reasons || [memoryMatch.reason].filter(Boolean),
    };
    result.watchReason = `WINNER-FAMILY MATCH — ${(memoryMatch.reasons || [memoryMatch.reason]).filter(Boolean).join(', ')}`;
    result.noGoReason = null;
  }

  if (includeVerification && result.oracleScore?.class === 'ORACLE_BUY') {
    const deFade = await fetchDeFadeVerification(ca, { lp: result.signals?.lp }, { manualMode: true, buyCandidate: true });
    result.deFadeVerification = deFade;
    if (deFade?.action === 'HARD_SKIP') {
      result.verdict = 'NO_GO';
      result.entryTier = null;
      result.noGoReason = `DeFade verification: ${deFade.reason}`;
      if (!Array.isArray(result.oracleScore.hardBlocks)) result.oracleScore.hardBlocks = [];
      result.oracleScore.hardBlocks.push('defade_hard_skip');
      result.oracleScore.class = 'NO_GO';
    }
  } else {
    markApi('DeFade', { skipped: true, meta: { reason: includeVerification ? 'not_oracle_buy' : 'verification_skipped', class: result.oracleScore?.class || result.verdict } });
    result.deFadeVerification = {
      action: 'SKIPPED',
      reason: includeVerification
        ? `Skipped because class was ${result.oracleScore?.class || result.verdict}; DeFade only runs on ORACLE_BUY candidates.`
        : 'Skipped in lightweight scan mode.',
      verified: false,
    };
  }
  if (result.oracleScore?.class === 'DIRTY_RUNNER_WATCH') {
    result.verdict = 'DIRTY_RUNNER_WATCH';
    result.entryTier = null;
  }

  result.requiredStack = evaluateRequiredStack(result, data);

  if (includeReasoning) {
    const soul = await getSoulVerdict(result, { ...data, patternMemory: getPatternMemory() });
    result.soulVerdict = soul;
    result.soulReasoning = soul?.reasoning ?? null;
  } else {
    markApi('Grok', { skipped: true, meta: { reason: 'reasoning_skipped_manual_button' } });
    result.soulVerdict = { available: false, verdict: null, reasoning: null };
    result.soulReasoning = null;
  }

  result.dataUsed = {
    dex: { status: data.codex ? 'ok' : 'failed' },
    pump: { status: data.pump ? 'ok' : 'failed' },
    birdeye: data.birdeye ? { status: 'ok' } : { status: 'skipped', reason: 'mode_or_context' },
    solanaTracker: { status: (!!data.stToken || !!data.stDeployer || data.holders?.source === 'solanatracker-holders') ? 'ok' : 'failed' },
    socialData: { status: social?.available ? 'ok' : 'failed' },
    helius: { status: data.holders?.source === 'helius' ? 'ok' : 'skipped', reason: data.holders?.source === 'helius' ? null : 'not_primary_holder_source' },
    codex: { status: data.holders?.source === 'codex' ? 'ok' : (config.CODEX_MODE === 'off' ? 'skipped' : 'failed'), reason: config.CODEX_MODE === 'off' ? 'codex_off' : null },
    deFade: { status: ['PASS', 'FLAG', 'HARD_SKIP'].includes(result.deFadeVerification?.action) ? 'ok' : 'skipped', reason: result.deFadeVerification?.reason },
    grok: { status: result.soulVerdict?.available ? 'ok' : (config.GROK_REQUIRED_FOR_BUY ? 'failed' : 'skipped'), reason: result.soulVerdict?.reasoning || null },
    gmgn: { status: 'skipped', reason: 'audit_only_or_not_wired' },
    rugcheck: { status: 'skipped', reason: 'pre_alert_optional_not_run' },
  };
  result.dataUsed.forensics = result.forensics
    ? { status: result.forensics.status === 'UNKNOWN' ? 'skipped' : 'ok', reason: result.forensics.reason }
    : { status: 'skipped', reason: 'not_run' };

  if (recordAuditEntry) {
    recordScan({
      ca,
      symbol: data.codex?.symbol || data.pump?.symbol,
      verdict: result.oracleScore?.class || result.verdict,
      entryTier: result.entryTier,
      mc: result.signals?.marketCap,
      adjustedVolLiq: result.signals?.adjustedVolLiq,
      rawVolLiq: result.signals?.rawVolLiq,
      lp: result.signals?.lp,
      top10Pct: result.signals?.top10Pct,
      top50Pct: result.signals?.top50Pct,
      holderCount: result.signals?.holderCount,
      holderHealthPct: result.signals?.holderHealth?.healthPct ?? null,
      bundleCount: result.signals?.bundleCount,
      sybilFunded: result.signals?.sybilFunded,
      washPct: result.signals?.washPct,
      isEliteDev: result.signals?.isEliteDev,
      successRatePct: result.signals?.successRatePct,
      devLaunches: result.signals?.totalLaunches,
      peakMultiplier: result.signals?.peakMultiplier,
      ageMinutes: result.signals?.ageMinutes,
      timeWindow: result.timeWindow,
      socialMentions15m: result.social?.mentions15m,
      uniqueAccounts: result.social?.uniqueAccounts,
      narrativeType: result.signals?.narrativeType || result.narrativeType,
      narrativeStrength: result.signals?.narrativeStrength || result.narrativeStrength,
      narrativeReason: result.signals?.narrativeReason || result.narrativeReason,
      noGoReason: result.noGoReason,
      watchReason: result.watchReason,
      headlineType: result.headlineType,
      oracleScoreTotal: result.oracleScore?.total,
      oracleScoreClass: result.oracleScore?.class,
      forensicsStatus: result.forensics?.status,
      forensicsReason: result.forensics?.reason,
      forensicsFeatures: result.forensics?.features,
      source,
    });
  }

  return { ok: true, data, social, result };
}

// ── Commands ──────────────────────────────────────────────────────────────────

const HELP_MENU =
  `🛠️ <b>ORACLE COMMAND CENTER (${config.ORACLE_VERSION})</b>\n` +
  `<i>Reupholster mode active: free Hunt scan, narrow trusted alerts.</i>\n\n` +
  `<b>── CORE ──</b>\n` +
  `• /start — Re-initialize the Oracle interface\n` +
  `• /help — Show this command menu\n` +
  `• /status — API + Guardian health snapshot\n` +
  `• /apistatus — API truth panel (modes/calls/failures/skips)\n` +
  `• /audit — Run audit pass + report\n` +
  `• /auditpending — Show unresolved audit entries\n` +
  `• /auditnow — Force one cheap pending-pass now\n` +
  `• /auditdeep — Deeper learning pass with larger caps\n` +
  `• /memorycheck — Verify audit/guardian memory paths + counts\n` +
  `• /memorybackup — Snapshot /data/audit.json and /data/positions.json\n` +
  `• /defadetest [CA] — DeFade endpoint/cache/action test\n\n` +
  `<b>── HUNT MODE (Automated) ──</b>\n` +
  `• /hunt — 🎯 <b>ACTIVATE 24/7 HUNTER.</b> Trader-grade MONSTER/RUNNER/SCOUT/PEARL alerts\n` +
  `• /unhunt — Disable automated alerts\n` +
  `• /huntstatus — Live hunt diagnostics (scanned/broadcast/queue)\n` +
  `• /huntskips — Rolling 60m skip counters + suppression buffers\n` +
  `• /huntdebug — Deep lifecycle debug (start/watchdog/connect counters)\n` +
  `• /huntping — Force one Dex fallback poll and report results\n` +
  `• /huntmode [strict|watch|all] — Legacy toggle (v38 still enforces class gates)\n` +
  `• /window — Current trading mode (Discovery / Dead Zone / Research)\n\n` +
  `<b>── POSITION TRACKING (Guardian) ──</b>\n` +
  `• /track [CA] — Track any Solana token CA (baseline can be pending)\n` +
  `• +track [CA] — Shortcut alias for /track\n` +
  `• /tracking — List all tracked tokens + live state\n` +
  `• /sync [CA] — Force-sync Guardian baseline if entry was missed\n` +
  `• /untrack [CA] — Stop monitoring a specific token\n\n` +
  `<b>── RESEARCH ──</b>\n` +
  `• /scanfull [CA] or /details [CA] — Force full forensic card\n` +
  `• /forensics [CA] — one-line holder cohort read\n` +
  `• /watchlist — Tokens with active dip/re-entry alerts\n` +
  `• /log — Recent audit log with clean class labels\n` +
  `• /logca [CA] — Recent audit entries for one CA\n` +
  `• <i>[Paste any CA]</i> — Full 10-gate forensic Oracle Scorecard\n\n` +
  `<i>Type /hunt to begin. 🔒🛡️🚀</i>`;

bot.start(ctx => ctx.replyWithHTML(HELP_MENU));
bot.help(ctx  => ctx.replyWithHTML(HELP_MENU));

bot.command('status', ctx => {
  const h = hunt.status();
  const huntLine = h.connected
    ? `🎯 Hunt: <b>${h.staleWs ? 'STALE' : 'ACTIVE'}</b> | ${h.hunters} hunter(s) | scanned ${h.scanned} | broadcast ${h.broadcast} | queue ${h.queueDepth}`
    : `🎯 Hunt: <b>OFFLINE</b> (reconnecting)`;
  return ctx.replyWithHTML(
    `${actionTimeLine('Status Time')}\n\n<b>Bot Status: ONLINE</b>\n\nData: DexScreener | PumpPortal${h.fallbackEnabled ? ' + Dex fallback' : ''} | Birdeye(hunt blocked) | Helius${process.env.DEFADE_API_KEY ? ' | DeFade' : ''}\n` +
    `Guardian: ${tracker.list().length} position(s) tracked\nSession: ${config.SESSION_SIZE_SOL} SOL\n${huntLine}`
  );
});

bot.command('apistatus', ctx => {
  return ctx.replyWithHTML(`${actionTimeLine('API Status Time')}\n\n${apiStatusHtml()}`);
});

bot.command('memorycheck', ctx => {
  const auditMemory = getAuditMemoryStats();
  const trackerMemory = tracker.getMemoryStats ? tracker.getMemoryStats() : {
    positionsFile: process.env.POSITIONS_FILE || '/data/positions.json',
    trackedPositionsCount: tracker.list().length,
    usingFallbackFile: false,
  };
  const dataDir = process.env.DATA_DIR || '/data';
  const exists = fs.existsSync(dataDir);
  const writable = exists && canWriteDir(dataDir);
  const warning = trackerMemory.usingFallbackFile
    ? '\n⚠️ Guardian is using repo-local bot/positions.json fallback.'
    : '';

  return ctx.reply(
    `${actionTimeLine('Memory Check Time')}\n\n` +
    `✅ DATA_DIR: ${dataDir} (exists=${exists}, writable=${writable})\n` +
    `✅ AUDIT_FILE: ${auditMemory.auditFile}\n` +
    `✅ POSITIONS_FILE: ${trackerMemory.positionsFile}\n` +
    `✅ audit queue count: ${auditMemory.queueCount}\n` +
    `✅ audit history count: ${auditMemory.historyCount}\n` +
    `✅ tracked positions count: ${trackerMemory.trackedPositionsCount}` +
    warning
  );
});

bot.command('memorybackup', async ctx => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backups = [
    { from: '/data/audit.json', to: `/data/audit.backup.${ts}.json` },
    { from: '/data/positions.json', to: `/data/positions.backup.${ts}.json` },
  ];
  const lines = [`${actionTimeLine('Memory Backup Time')}`, ''];
  for (const item of backups) {
    try {
      if (!fs.existsSync(item.from)) {
        lines.push(`⚠️ missing: ${item.from}`);
        continue;
      }
      fs.copyFileSync(item.from, item.to);
      lines.push(`✅ backup created: ${item.to}`);
    } catch (e) {
      lines.push(`⚠️ backup failed for ${item.from}: ${e.message}`);
    }
  }
  await ctx.reply(lines.join('\n'));
});

bot.command('hunt', ctx => {
  const added = hunt.addHunter(ctx.chat.id);
  return ctx.replyWithHTML(added
    ? `${actionTimeLine('Hunt Time')}\n\n🎯 <b>Hunt Mode: ON</b>\nFree Hunt scan is active. Alerts now use clean MONSTER / RUNNER / SCOUT / PEARL / ALERT / FAIL classes.\nPumpPortal WS is primary; DexScreener fallback arms automatically if WS goes stale.\nUse /unhunt to stop.`
    : `${actionTimeLine('Hunt Time')}\n\n🎯 Hunt Mode already <b>ON</b> for this chat. Use /unhunt to stop.`);
});

bot.command('unhunt', ctx => {
  const removed = hunt.removeHunter(ctx.chat.id);
  return ctx.replyWithHTML(removed ? `${actionTimeLine('Hunt Time')}\n\n🎯 Hunt Mode: OFF for this chat.` : `${actionTimeLine('Hunt Time')}\n\nHunt Mode was not active for this chat.`);
});

// v10.2.7: forces one Dex fallback poll on demand and reports the stat delta,
// so users can verify the fallback path is alive without waiting up to 90s
// for the next scheduled poll. Distinguishes "fallback never runs" from
// "fallback runs but never finds usable launches".
bot.command('huntping', async ctx => {
  await ctx.replyWithHTML(`${actionTimeLine('Hunt Ping Time')}\n\n🛰️ Forcing one Dex fallback poll...`);
  const r = await hunt.pingFallback();
  if (!r.ok) return ctx.replyWithHTML(`⚠️ /huntping failed: ${r.reason}`);
  const d = r.delta;
  const note = d.enqueued === 0
    ? '⚠️ Fallback polled DexScreener but found no new launches passing dust filter (this is normal in quiet windows).'
    : '✅ Fallback enqueued tokens for scanning.';
  return ctx.replyWithHTML(
    `${actionTimeLine('Hunt Ping Time')}\n\n<b>/huntping result (delta this call)</b>\n` +
    `attempts:  ${d.attempts}\n` +
    `polls:     ${d.polls}\n` +
    `enqueued:  ${d.enqueued}\n` +
    `scanned:   ${d.scanned}\n` +
    `broadcast: ${d.broadcast}\n` +
    `skipped:   ${d.skipped}\n` +
    `errors:    ${d.errors}\n\n${note}`
  );
});

bot.command('huntmode', ctx => {
  const mode = (ctx.message.text.trim().split(/\s+/)[1] || '').toLowerCase();
  if (!['strict', 'watch', 'all'].includes(mode)) {
    return ctx.replyWithHTML(`Usage: <code>/huntmode strict</code> | <code>watch</code> | <code>all</code>
Current: <b>${config.HUNT_ALERT_MODE}</b>`);
  }
  config.HUNT_ALERT_MODE = mode;
  config.HUNT_ALERT_VERDICTS = '';
  return ctx.replyWithHTML(`${actionTimeLine('Hunt Mode Change')}

Hunt alert mode set to <b>${mode}</b>.`);
});

bot.command('huntstatus', ctx => {
  const h   = hunt.status();
  const now = Date.now();
  const ago = ts => ts ? Math.floor((now - ts) / 1000) + 's ago' : 'never';
  const wsLabel   = !h.connected ? '🔴 DISCONNECTED' : h.staleWs ? '🟡 CONNECTED / STALE' : '🟢 CONNECTED';
  const uptime    = h.uptimeMs ? Math.floor(h.uptimeMs / 1000) + 's' : '—';
  // Mask hunter IDs for privacy: show first 3 + last 2 digits, e.g. 123***89
  const maskedIds = (h.hunterIds || []).map(id => {
    const s = String(id);
    return s.length <= 5 ? '****' : s.slice(0, 3) + '***' + s.slice(-2);
  }).join(', ') || 'none';

  const text =
    `<b>Hunt Mode Diagnostics</b>\n\n` +
    `WS:         ${wsLabel}\n` +
    `Uptime:     ${uptime}\n` +
    `Hunters:    ${h.hunters}\n` +
    `Hunter IDs: ${maskedIds}\n` +
    `Your chat:  <code>${ctx.chat.id}</code>\n` +
    `PumpPortal key: ${h.pumpPortalApiKeyConfigured ? 'configured' : 'not configured'}\n` +
    `Last raw frame:    ${ago(h.lastRawEvent)}\n` +
    `Last usable event: ${ago(h.lastEvent)}\n` +
    `Last source: ${h.lastSource || 'none'}\n\n` +
    `<b>Traffic</b>\n` +
    `Raw WS frames: ${h.rawEvents ?? 0}\n` +
    `Ignored:   ${h.ignoredEvents ?? 0}${h.lastIgnoredReason ? ` (${h.lastIgnoredReason})` : ''}\n` +
    `Scanned:   ${h.scanned}\n` +
    `Skipped:   ${h.skipped}\n` +
    `Errors:    ${h.errors}\n\n` +
    `<b>Hunt Alert Gate</b>\n` +
    `Alert mode: ${h.alertMode}\n` +
    `Allowed verdicts: ${(h.allowedVerdicts || []).join(', ') || 'none'}\n` +
    `Last suppressed CA: ${h.lastSkippedCA ? `<code>${h.lastSkippedCA.slice(0,8)}...</code>` : 'none'}\n` +
    `Last suppressed verdict: ${h.lastSkippedVerdict || 'none'}\n` +
    `Last suppressed reason: ${h.lastSkipReason || 'none'}\n` +
    `Last suppressed at: ${ago(h.lastSkippedAt)}\n` +
    `SocialData key configured: ${h.socialDataKeyConfigured ? 'yes' : 'no'} | calls: ${h.socialDataCalls ?? 0}\n` +
    `Grok key configured: ${h.grokKeyConfigured ? 'yes' : 'no'} | calls: ${h.grokCalls ?? 0} | fails: ${h.grokFails ?? 0}\n\n` +
    `<b>Skip Counters (rolling 60m)</b>\n` +
    `below vol/liq floor: ${h.skipCounts60m?.belowVolLiqFloor ?? 0}\n` +
    `market data missing: ${h.skipCounts60m?.marketDataMissing ?? 0}\n` +
    `required stack failed: ${h.skipCounts60m?.requiredStackFailed ?? 0}\n` +
    `class not allowed: ${h.skipCounts60m?.classNotAllowed ?? 0}\n` +
    `dirty runner confidence low: ${h.skipCounts60m?.dirtyRunnerConfidenceTooLow ?? 0}\n` +
    `Pearl Watch sent: ${h.skipCounts60m?.pearlWatchSent ?? 0}\n` +
    `suppressed Pearl candidates: ${h.skipCounts60m?.suppressedPearlCandidates ?? 0}\n` +
    `hard blocks: ${h.skipCounts60m?.hardBlocks ?? 0}\n` +
    `broadcast eligible: ${h.skipCounts60m?.broadcastEligible ?? 0}\n` +
    `delivered: ${h.skipCounts60m?.delivered ?? 0}\n\n` +
    `<b>Broadcast delivery</b>\n` +
    `Candidates (passed filter): ${h.broadcastCandidates ?? h.broadcast ?? 0}\n` +
    `Telegram attempts:  ${h.broadcastAttempts ?? 0}\n` +
    `✅ Delivered:       ${h.broadcastDelivered ?? 0}\n` +
    `❌ Failed:          ${h.broadcastFailed ?? 0}\n` +
    `Last candidate:  ${h.lastBroadcastCA ? `<code>${h.lastBroadcastCA.slice(0,8)}...</code> ${ago(h.lastBroadcastAt)}` : 'none'}\n` +
    `Last delivered:  ${ago(h.lastDeliveredAt)}\n` +
    `Last error:      ${h.lastBroadcastError || 'none'}\n\n` +
    `<b>Infrastructure</b>\n` +
    `Fallback:  ${h.fallbackEnabled ? 'ON' : 'OFF'} | polls ${h.fallbackPolls ?? 0} | enqueued ${h.fallbackEnqueued ?? 0} | errors ${h.fallbackErrors ?? 0}\n` +
    `Reconnects: ${h.hardReconnects ?? 0}${h.lastReconnectReason ? ` (${h.lastReconnectReason})` : ''}\n` +
    `Hammer:    every ${Math.floor((h.reconnectHammerMs || 15000) / 1000)}s if disconnected\n` +
    (h.lastWsClose ? `Last close: code ${h.lastWsClose.code ?? 'n/a'}${h.lastWsClose.reason ? ` | ${h.lastWsClose.reason}` : ''}\n` : '') +
    `Queue:     ${h.queueDepth} pending | ${h.activeScans} running\n\n` +
    (h.staleWs ? `⚠️ <b>PumpPortal unavailable</b> — WS connected but 0 raw frames in 2+ min. Dex fallback active.\n\n` : '') +
    (!h.connected ? `🚨 <b>WS disconnected</b> — reconnect hammer active.\n\n` : '') +
    (h.startedAt == null ? `❌ <b>FATAL:</b> Hunt engine never started. Use /huntdebug.\n\n` : '') +
    `You: ${hunt.isHunter(ctx.chat.id) ? '🎯 hunting' : '⚪ not hunting (/hunt to enable)'}\n` +
    `<i>Run /hunttest to verify delivery path. /huntlast to see last 5 candidates.</i>`;
  const extra = { parse_mode: 'HTML' };
  if (!h.connected || h.staleWs) {
    extra.reply_markup = { inline_keyboard: [[{ text: '🔄 RECONNECT', callback_data: 'hunt:reconnect' }]] };
  }
  return ctx.reply(text, extra);
});

bot.command('huntskips', ctx => {
  const h = hunt.status();
  const scans = (h.lastScans || []).slice(0, 10).map((s, i) =>
    `${i + 1}. ${s.ca ? s.ca.slice(0, 8) + '...' : 'unknown'} | MC ${fmtUsd(s.mc)} | Vol/Liq ${s.adjustedVolLiq != null ? Number(s.adjustedVolLiq).toFixed(2) + 'x' : 'N/A'} | ${s.cls || 'N/A'}${s.skipReason ? ` | skip: ${s.skipReason}` : ''}`
  );
  const suppressed = (h.lastSuppressed || []).slice(0, 10).map((s, i) =>
    `${i + 1}. ${s.ca ? s.ca.slice(0, 8) + '...' : 'unknown'} | MC ${fmtUsd(s.mc)} | Vol/Liq ${s.adjustedVolLiq != null ? Number(s.adjustedVolLiq).toFixed(2) + 'x' : 'N/A'} | ${s.cls || 'N/A'} | ${s.reason || 'suppressed'}`
  );
  const text =
    `<b>Hunt Skips (rolling 60m)</b>\n\n` +
    `below vol/liq floor: ${h.skipCounts60m?.belowVolLiqFloor ?? 0}\n` +
    `market data missing: ${h.skipCounts60m?.marketDataMissing ?? 0}\n` +
    `required stack failed: ${h.skipCounts60m?.requiredStackFailed ?? 0}\n` +
    `class not allowed: ${h.skipCounts60m?.classNotAllowed ?? 0}\n` +
    `dirty runner confidence low: ${h.skipCounts60m?.dirtyRunnerConfidenceTooLow ?? 0}\n` +
    `Pearl Watch sent: ${h.skipCounts60m?.pearlWatchSent ?? 0}\n` +
    `suppressed Pearl candidates: ${h.skipCounts60m?.suppressedPearlCandidates ?? 0}\n` +
    `hard blocks: ${h.skipCounts60m?.hardBlocks ?? 0}\n` +
    `broadcast eligible: ${h.skipCounts60m?.broadcastEligible ?? 0}\n` +
    `delivered: ${h.skipCounts60m?.delivered ?? 0}\n\n` +
    `<b>lastScans (10)</b>\n${scans.length ? scans.join('\n') : 'none'}\n\n` +
    `<b>lastSuppressed (10)</b>\n${suppressed.length ? suppressed.join('\n') : 'none'}`;
  return ctx.replyWithHTML(text);
});

bot.action('hunt:reconnect', async ctx => {
  try { await ctx.answerCbQuery('Reconnecting…'); } catch (_) {}
  const ok = hunt.forceReconnect();
  if (!ok) return ctx.replyWithHTML(`⚠️ Hunt engine has no broadcaster — start() likely never ran. Use /huntdebug.`);
  return ctx.replyWithHTML(`🔄 <b>Manual reconnect triggered.</b>\nRun /huntstatus in ~5s to verify 🟢 CONNECTED.`);
});

// v10.2.10: shows last 5 candidates that passed Hunt filter with delivery status.
bot.command('huntlast', ctx => {
  const h = hunt.status();
  const candidates = h.lastCandidates || [];
  if (!candidates.length) {
    return ctx.replyWithHTML(
      `<b>Hunt Last Candidates</b>\n\nNo candidates recorded yet this session.\n` +
      `<i>Hunt has scanned ${h.scanned ?? 0} token(s) but none reached the active Hunt broadcast gate, or the session just started.</i>`
    );
  }
  const now = Date.now();
  const lines = candidates.map((c, i) => {
    const age    = Math.floor((now - c.ts) / 1000);
    const ageStr = age < 60 ? `${age}s ago` : `${Math.floor(age/60)}m ago`;
    const deliv  = c.delivered > 0 ? `✅ delivered` : c.attempted === 0 ? `⚪ no hunters` : `❌ FAILED`;
    const errStr = c.error ? `\n   ⚠️ <i>${c.error.slice(0, 80)}</i>` : '';
    const classLabel = resolveTraderClass(c.verdict, null).label;
    return (
      `${i+1}. <b>$${c.symbol}</b> — <code>${c.ca.slice(0,8)}...</code>\n` +
      `   ${classLabel} | ${c.adjustedVolLiq.toFixed(1)}x Vol/Liq | MC $${c.mc >= 1000 ? (c.mc/1000).toFixed(1)+'K' : c.mc.toFixed(0)}\n` +
      `   ${ageStr} — ${deliv}${errStr}\n` +
      `   <a href="https://dexscreener.com/solana/${c.ca}">Chart</a>`
    );
  });
  return ctx.replyWithHTML(
    `${actionTimeLine('Hunt Last Time')}\n\n<b>Hunt Last ${candidates.length} Candidate(s)</b>\n\n` + lines.join('\n\n')
  );
});

// v10.2.10: tests the broadcaster path directly — same code path Hunt uses.
bot.command('hunttest', async ctx => {
  const result = await hunt.testBroadcast(ctx.chat.id);
  if (result.ok) {
    return ctx.replyWithHTML(
      `✅ <b>Hunt broadcaster test delivered to chatId <code>${ctx.chat.id}</code></b>\n` +
      `Delivery path is working. If you are still not receiving Hunt alerts, the issue is upstream — check /huntstatus for filter stats and delivery counts.`
    );
  }
  return ctx.replyWithHTML(
    `❌ <b>Hunt broadcaster test FAILED for chatId <code>${ctx.chat.id}</code></b>\n` +
    `Telegram error: <code>${result.reason}</code>\n\n` +
    `This means Hunt cannot deliver to you. Common causes: bot was blocked, chat ID mismatch, or Telegram API error.`
  );
});

// v10.2.6 — surfaces every internal lifecycle counter. Use this when /huntstatus
// looks wrong (e.g. WS disconnected with 0 reconnects) to see if start() ran,
// if the watchdog setInterval is actually ticking, and how many WS attempts
// have been made. Tells us what's broken without needing Railway logs.
bot.command('huntdebug', ctx => {
  const h = hunt.status();
  const now = Date.now();
  const ago = ts => ts ? Math.floor((now - ts) / 1000) + 's ago' : 'never';
  const ready = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][h.wsReadyState ?? -1] || 'no-socket';
  const verdict =
    h.startedAt == null               ? '❌ start() NEVER ran — try /unhunt then /hunt, or check Railway logs for tracker/watchlist crash' :
    h.connectAttempts === 0           ? '❌ connect() never called inside start()' :
    h.watchdogArmedAt == null         ? '❌ watchdog never armed' :
    h.watchdogTicks === 0 && (now - h.watchdogArmedAt) > 20_000 ? '❌ watchdog setInterval is NOT firing (event loop issue)' :
    h.lastConstructError              ? `❌ WS constructor failed: ${h.lastConstructError.msg}` :
    h.connected                       ? '✅ WS is connected' :
    h.fallbackAttempts > 0            ? '🟡 WS down but fallback is polling — alerts should still flow if launches occur' :
    '🟡 WS down, fallback not yet attempted';
  return ctx.replyWithHTML(
    `<b>Hunt Engine Deep Debug</b>\n\n` +
    `<b>Lifecycle</b>\n` +
    `start() called:     ${ago(h.startedAt)}\n` +
    `watchdog armed:     ${ago(h.watchdogArmedAt)}\n` +
    `watchdog ticks:     ${h.watchdogTicks} ${h.watchdogTicks === 0 && h.watchdogArmedAt ? '⚠️ (should be ≥1 every 15s)' : ''}\n` +
    `connect() attempts: ${h.connectAttempts}\n` +
    `last connect():     ${ago(h.lastConnectAt)}\n` +
    `WS readyState:      ${ready} (${h.wsReadyState ?? 'null'})\n` +
    `last construct err: ${h.lastConstructError ? `${h.lastConstructError.msg} (${ago(h.lastConstructError.ts)})` : 'none'}\n` +
    `\n<b>Traffic</b>\n` +
    `raw frames seen:    ${h.rawEvents ?? 0}\n` +
    `fallback attempts:  ${h.fallbackAttempts ?? 0}\n` +
    `fallback polls:     ${h.fallbackPolls ?? 0} (gated on hunters>0 + WS stale)\n` +
    `hard reconnects:    ${h.hardReconnects ?? 0}\n` +
    `\n<b>Diagnosis</b>\n${verdict}`
  );
});

// v10.2.7: real /untrack <CA> command. Previously only worked as inline button.
bot.command('untrack', ctx => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const ca    = parts[1];
  if (!ca || !isSolanaCA(ca)) {
    const lst = tracker.list();
    if (!lst.length) return ctx.reply('Usage: /untrack <CA>\n(No positions currently tracked.)');
    const lines = lst.map((p,i) => `${i+1}. <code>${p.ca}</code>`).join('\n');
    return ctx.replyWithHTML(`Usage: <code>/untrack &lt;CA&gt;</code>\n\n<b>Tracked positions:</b>\n${lines}`);
  }
  const pos = tracker.list().find(p => p.ca === ca);
  if (!pos) return ctx.reply(`Not currently tracking ${ca.slice(0,6)}...${ca.slice(-4)}.`);
  if (pos.chatId !== ctx.chat.id) return ctx.reply('You can only untrack your own positions.');
  const removed = tracker.untrack(ca);
  return ctx.replyWithHTML(removed
    ? `❌ Stopped tracking <code>${ca.slice(0,6)}...${ca.slice(-4)}</code>. Guardian poll halted.`
    : `Untrack failed for <code>${ca.slice(0,6)}...${ca.slice(-4)}</code>.`);
});

bot.command('watchlist', ctx => {
  const all = watchlist.list();
  const mine = all.filter(e => e.chatId === ctx.chat.id);
  if (!mine.length) return ctx.reply('No tokens on your dip-alert watchlist. Use 🔔 ALERT from a signal card.');
  const now = Date.now();
  const lines = mine.map((e, i) => {
    const ageMin = Math.floor((now - e.addedAt) / 60000);
    const expiresIn = Math.max(0, Math.floor((e.addedAt + 12 * 60 * 60 * 1000 - now) / 60000));
    return `${i + 1}. <code>${e.ca.slice(0, 8)}...</code> $${e.symbol} — added ${ageMin}m ago, expires in ${expiresIn}m`;
  });
  return ctx.replyWithHTML(
    `<b>Your Dip Alert Watchlist (${mine.length})</b>\n` +
    `<i>Waiting for high-quality retrace/retest confirmation</i>\n\n` +
    lines.join('\n') +
    `\n\n<i>Alerts auto-expire after 12 hours.</i>`
  );
});

bot.command('forensics', async ctx => {
  const ca = (ctx.message.text.split(/\s+/)[1] || '').trim();
  if (!isSolanaCA(ca)) return ctx.replyWithHTML('Usage: <code>/forensics [CA]</code>');

  const wait = await ctx.replyWithHTML(`🔎 Running deep forensics on <code>${ca}</code>...`);
  try {
    const sig = await fetchForensic(ca).catch(() => null);
    const forensic = await runDeepForensics(ca, {
      marketCap: sig?.marketCap ?? null,
      ageMinutes: sig?.ageMinutes ?? null,
      holders: {
        holderCount: sig?.holderCount ?? null,
        top10Pct: sig?.top10Pct ?? null,
        top20Pct: sig?.top20Pct ?? null,
        top50Pct: sig?.top50Pct ?? null,
      },
      topWallets: sig?.topWallets || [],
    });

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      wait.message_id,
      undefined,
      forensic.oneLine,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      wait.message_id,
      undefined,
      `🔎 Forensics: 🟡 Unknown — deep check failed: ${String(e.message).slice(0, 90)}`,
      { parse_mode: 'HTML' }
    );
  }
});

bot.command('track', async ctx => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const ca = parts[1];
  if (!ca || !isSolanaCA(ca)) {
    return ctx.reply('Usage: /track [CA]');
  }
  const tracked = await beginTrackingAnyCa({ ca, chatId: ctx.chat.id });
  if (!tracked.ok) {
    return ctx.reply(`⚠️ TRACK FAILED — ${tracked.reason}`);
  }
  return ctx.reply(tracked.message);
});

bot.command('audit', async ctx => {
  const processed = await processPendingOnce(fetchMcOnly, {
    limit: config.AUDIT_BIRDEYE_MAX_PER_RUN,
    allowBirdeye: true,
    deepMode: false,
  });
  await ctx.replyWithHTML(
    `${actionTimeLine('Audit Time')}\n\n` +
    `<b>/audit pass complete</b>\n` +
    `Checked: ${processed.checked} | Resolved: ${processed.resolved}\n\n` +
    `${getAuditReport()}`
  );
});


bot.command('auditdeep', async ctx => {
  const processed = await processPendingOnce(fetchMcOnly, {
    limit: config.AUDITDEEP_BIRDEYE_MAX_PER_RUN,
    allowBirdeye: true,
    deepMode: true,
  });
  await ctx.replyWithHTML(
    `${actionTimeLine('Audit Deep Time')}

` +
    `<b>/auditdeep pass complete</b>
` +
    `Checked: ${processed.checked} | Resolved: ${processed.resolved}
` +
    `Caps: Birdeye ${config.AUDITDEEP_BIRDEYE_MAX_PER_RUN}, Grok ${config.AUDITDEEP_GROK_MAX_PER_RUN}

` +
    `${getAuditReport()}`
  );
});

bot.command('auditnow', async ctx => {
  const processed = await processPendingOnce(fetchMcOnly, {
    limit: 10,
    allowBirdeye: false,
    deepMode: false,
  });
  await ctx.replyWithHTML(
    `${actionTimeLine('Audit Now Time')}

` +
    `<b>/auditnow cheap pass complete</b>
` +
    `Checked: ${processed.checked} | Resolved: ${processed.resolved}
` +
    `Birdeye calls: disabled for this forced cheap pass.`
  );
});

bot.command('auditpending', async ctx => {
  await ctx.replyWithHTML(`${actionTimeLine('Audit Pending Time')}

${getAuditPendingReport()}`);
});

bot.command('log', async ctx => {
  await ctx.replyWithHTML(
    `${actionTimeLine('Log Time')}\n\n<b>Oracle Log (latest)</b>\n\n${getLogReport(20)}`
  );
});

bot.command('logca', async ctx => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const ca = parts[1];
  if (!ca || !isSolanaCA(ca)) {
    return ctx.replyWithHTML('Usage: <code>/logca &lt;CA&gt;</code>');
  }
  await ctx.replyWithHTML(
    `${actionTimeLine('Log CA Time')}\n\n<b>Oracle Log for ${ca.slice(0, 8)}...</b>\n\n${getLogForCa(ca, 10)}`
  );
});

bot.command('defadetest', async ctx => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const ca = parts[1];
  if (!ca || !isSolanaCA(ca)) {
    return ctx.replyWithHTML('Usage: <code>/defadetest &lt;CA&gt;</code>');
  }
  const r = await runDeFadeTest(ca);
  return ctx.replyWithHTML(
    `${actionTimeLine('DeFade Test Time')}

` +
    `<b>DeFade Test</b>
` +
    `CA: <code>${ca}</code>
` +
    `Endpoint: ${r.endpoint}
` +
    `HTTP: ${r.httpStatus ?? 'n/a'}
` +
    `Cache: ${r.cache}
` +
    `Rug score: ${r.rugScore ?? 'n/a'}
` +
    `Action: ${r.action}
` +
    `Reason: ${r.reason}`
  );
});

bot.command('tracking', ctx => {
  const positions = tracker.list();
  if (!positions.length) return ctx.reply('No positions currently tracked.');
  const lines = positions.map((p, i) => {
    const baselineOk = p.entryTop50Pct !== null && p.entryHolderCount !== null;
    return `${i+1}. <code>${p.ca.slice(0,8)}...</code> — entry MC: $${(p.entryMc/1000).toFixed(1)}K | peak: $${(p.peakMc/1000).toFixed(1)}K${baselineOk ? '' : ' ⚠️ baseline pending'}`;
  });
  return ctx.replyWithHTML(`${actionTimeLine('Tracking Time')}\n\n<b>Tracked Positions (${positions.length}):</b>\n\n${lines.join('\n')}\n\n<i>Use /sync &lt;CA&gt; to re-establish a pending baseline.</i>`);
});

bot.command('sync', async ctx => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const ca    = parts[1];
  if (!ca || !isSolanaCA(ca)) {
    // Show which tracked positions have a pending baseline
    const pending = tracker.list().filter(p => p.entryTop50Pct === null || p.entryHolderCount === null);
    if (!pending.length) return ctx.reply('All tracked positions have baselines set. Nothing to sync.');
    const lines = pending.map(p => `• <code>${p.ca}</code>`).join('\n');
    return ctx.replyWithHTML(`<b>Pending baselines:</b>\n${lines}\n\nUsage: /sync &lt;CA&gt;`);
  }
  const result = await tracker.syncBaseline(ca, ctx.chat.id, bot);
  if (!result.found) return ctx.reply(`CA not found in your tracked positions.`);
});

bot.command('window', ctx => {
  const etHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date()).find(p => p.type === 'hour')?.value ?? 0
  );
  const window = etHour >= 2 && etHour < 12 ? 'DISCOVERY' : etHour >= 12 && etHour < 19 ? 'DEAD_ZONE' : 'RESEARCH';
  return ctx.replyWithHTML(
    `<b>Scan Thresholds</b>\n\nLP min: ${config.LP_MIN_USD.toLocaleString()}\nAge max: ${config.AGE_MAX_MIN}min\n` +
    `Vol/Liq: ${window === 'DEAD_ZONE' ? '8x' : '5x'} (${window})\nTop 10 max: ${config.TOP10_MAX_PCT}%\n` +
    `Curve max: ${config.CURVE_MAX_PCT}% (hard skip: ${config.CURVE_HARD_SKIP_PCT}%)\n` +
    `Top 10 hard NO-GO: ${config.TOP10_HARD_MAX_PCT}%\nSession: ${config.SESSION_SIZE_SOL} SOL\n\n` +
    `<b>TPs (${window === 'DEAD_ZONE' ? 'Dead Zone' : 'Normal'}):</b>\n` +
    `TP1 → ${window === 'DEAD_ZONE' ? '$50K' : '$100K'} MC\nTP2 → $250K MC\nTP3 → $500K MC\n\n` +
    `Time Mode: <b>${window}</b> (ET hour ${etHour})`
  );
});

bot.command('scanfull', ctx => {
  forceFullNextScanChats.add(ctx.chat.id);
  return ctx.reply('Full-card mode armed for your next scan. Paste a CA (or use /details).');
});

bot.command('details', ctx => {
  forceFullNextScanChats.add(ctx.chat.id);
  return ctx.reply('Full-card mode armed for your next scan. Paste a CA (or use /scanfull).');
});

// ── CA scan handler ───────────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  const plusTrack = text.match(/^\+track\s+([1-9A-HJ-NP-Za-km-z]{32,50})$/i);
  if (plusTrack) {
    const tracked = await beginTrackingAnyCa({ ca: plusTrack[1], chatId: ctx.chat.id });
    if (!tracked.ok) return ctx.reply(`⚠️ TRACK FAILED — ${tracked.reason}`);
    return ctx.reply(tracked.message);
  }

  const tokens = text.split(/\s+/);
  const ca = tokens.find(t => isSolanaCA(t));
  if (!ca) return ctx.reply('Send a valid Solana contract address (32–50 base58 chars).');

  const scanning = await ctx.replyWithHTML(`🔍 Scanning <code>${ca}</code>...`);

  try {
    const scanExec = await executeOracleScan(ca, {
      source: 'scan',
      includeVerification: true,
      includeReasoning: true,
      recordAuditEntry: true,
    });
    if (!scanExec.ok) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, scanning.message_id, undefined,
        `No data found for <code>${ca}</code>. Check the address and try again.`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    const { result } = scanExec;
    const mc = result.signals.marketCap || 0;
    const forceFull = forceFullNextScanChats.has(ctx.chat.id);
    if (forceFull) forceFullNextScanChats.delete(ctx.chat.id);
    const cardMode = forceFull ? 'full' : 'short';
    const message = formatVerdict(result, ca, { context: 'scan', mode: cardMode });

    await ctx.telegram.editMessageText(
      ctx.chat.id, scanning.message_id, undefined,
      message,
      {
        parse_mode: 'HTML',
        reply_markup: buildKeyboard(ca, mc, result.verdict),
      }
    );
  } catch (err) {
    console.error('[scan error]', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, scanning.message_id, undefined,
      `Error scanning <code>${ca}</code>: ${err.message}`,
      { parse_mode: 'HTML' }
    );
  }
});

bot.action(/^forensics:([^:]+):?(\d+)?$/, async ctx => {
  const ca = ctx.match[1];

  try { await ctx.answerCbQuery('Running deep forensics…'); } catch (_) {}

  const wait = await ctx.replyWithHTML(`🔎 Running deep forensics on <code>${ca}</code>...`);
  try {
    const sig = await fetchForensic(ca).catch(() => null);
    const forensic = await runDeepForensics(ca, {
      marketCap: sig?.marketCap ?? null,
      ageMinutes: sig?.ageMinutes ?? null,
      holders: {
        holderCount: sig?.holderCount ?? null,
        top10Pct: sig?.top10Pct ?? null,
        top20Pct: sig?.top20Pct ?? null,
        top50Pct: sig?.top50Pct ?? null,
      },
      topWallets: sig?.topWallets || [],
    });

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      wait.message_id,
      undefined,
      forensic.oneLine,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      wait.message_id,
      undefined,
      `🔎 Forensics: 🟡 Unknown — deep check failed: ${String(e.message).slice(0, 90)}`,
      { parse_mode: 'HTML' }
    );
  }
});

// ── Inline button callbacks ───────────────────────────────────────────────────

bot.on('callback_query', async ctx => {
  const data = ctx.callbackQuery?.data || '';

  if (data.startsWith('alert:')) {
    const parts  = data.split(':');
    const ca     = parts[1];
    const mc     = parseFloat(parts[2]) || 0;
    const shortCa = `${ca.slice(0,6)}...${ca.slice(-4)}`;
    if (watchlist.has(ca, ctx.chat.id)) {
      await ctx.answerCbQuery(`🔔 Already watching ${shortCa}`);
      return;
    }
    let sig = null;
    try { sig = await fetchForensic(ca); } catch (_) {}
    const symbol = ctx.callbackQuery?.message?.text?.match(/Token:\s*([A-Za-z0-9_$-]+)/i)?.[1] || '???';
    const baselineMc = sig?.marketCap ?? mc;
    const added = watchlist.add(ca, ctx.chat.id, symbol, {
      baselineMc,
      athMc: baselineMc,
      baselineLp: sig?.lp ?? null,
      baselineHolders: sig?.holderCount ?? null,
      baselineTop10: sig?.top10Pct ?? null,
      baselineTop50: sig?.top50Pct ?? null,
      baselineVolLiq: sig?.adjustedVolLiq ?? null,
    });
    if (added) {
      await ctx.answerCbQuery(`🔔 Dip alert set for ${shortCa}`);
      await bot.telegram.sendMessage(
        ctx.chat.id,
        `🔔 *DIP ALERT ARMED*\n` +
        `CA: \`${shortCa}\`\n` +
        `Baseline MC: $${fmtUsd(baselineMc)}\n\n` +
        `I will notify only when a high-quality retrace/retest forms:\n` +
        `• retrace from Guardian Peak\n` +
        `• LP/holder stability\n` +
        `• concentration stability\n` +
        `• no drain danger\n` +
        `• volume still alive\n\n` +
        `_Auto-expires in 12 hours._`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.answerCbQuery(`Already watching ${shortCa}`);
    }
    return;
  }

  if (data.startsWith('learn:')) {
    const ca = data.split(':')[1];
    const shortCa = `${ca.slice(0,6)}...${ca.slice(-4)}`;
    await ctx.answerCbQuery('📌 Saving learned memory...');
    try {
      const scanExec = await executeOracleScan(ca, {
        source: 'learn_button',
        includeVerification: false,
        includeReasoning: false,
        recordAuditEntry: false,
      });
      if (!scanExec.ok) {
        await ctx.telegram.sendMessage(ctx.chat.id, `⚠️ Could not load live data for ${shortCa}.`);
        return;
      }
      const original = findOriginalScanEntry(ca);
      const signals = scanExec.result?.signals || {};
      const currentMc = Number(signals.marketCap || 0);
      const originalScanMc = original?.scanMc > 0 ? Number(original.scanMc) : currentMc;
      const currentPeakMc = Math.max(currentMc, Number(original?.highestPeakMc || 0), Number(original?.peakMc || 0));
      const multipleFromScan = originalScanMc > 0 && currentPeakMc > 0 ? currentPeakMc / originalScanMc : 1;
      const originalClass = original?.oracleScoreClass || original?.verdict || scanExec.result?.oracleScore?.class || 'MANUAL';
      const originalScore = original?.oracleScoreTotal ?? scanExec.result?.oracleScore?.total ?? null;
      const saved = saveForcedLearnRecord({
        ca,
        symbol: scanExec.data?.codex?.symbol || scanExec.data?.pump?.symbol || '???',
        originalScanMc,
        currentMc,
        currentPeakMc,
        multipleFromScan,
        originalClass,
        originalScore,
        adjustedVolLiq: signals.adjustedVolLiq ?? null,
        washPct: signals.washPct ?? null,
        top10Pct: signals.top10Pct ?? null,
        bundleCount: signals.bundleCount ?? null,
        holderHealthPct: signals.holderHealth?.healthPct ?? null,
        lp: signals.lp ?? null,
        ageMinutes: signals.ageMinutes ?? null,
        narrativeType: signals.narrativeType || scanExec.result?.narrativeType || 'NONE',
        narrativeStrength: signals.narrativeStrength ?? scanExec.result?.narrativeStrength ?? 0,
        source: 'learn_button',
        learnedAt: Date.now(),
        reason: 'user_forced_learn',
      });
      const originalRead = resolveTraderClass(originalClass, originalScore).label;
      const noOriginalNote = original ? '' : '\nNo original scan found; saved as manual memory.';
      await ctx.telegram.sendMessage(
        ctx.chat.id,
        `📌 <b>LEARNED</b>\n\n` +
        `Original Scan: <b>$${fmtUsd(saved.originalScanMc || originalScanMc)}</b>\n` +
        `Current Peak: <b>$${fmtUsd(saved.currentPeakMc || currentPeakMc)}</b>\n` +
        `Move: <b>${Number(saved.multiple || multipleFromScan).toFixed(1)}x</b>\n` +
        `Original Read: <b>${originalRead}</b>\n\n` +
        `Saved to Oracle memory.${noOriginalNote}`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('[learn callback] error:', err);
      await ctx.telegram.sendMessage(ctx.chat.id, `⚠️ LEARN failed for ${shortCa}: ${err.message}`);
    }
    return;
  }

  if (data.startsWith('details:')) {
    const ca = data.split(':')[1];
    const shortCa = `${ca.slice(0,6)}...${ca.slice(-4)}`;
    await ctx.answerCbQuery('🧠 Building full details...');
    try {
      const scanExec = await executeOracleScan(ca, {
        source: 'details_button',
        includeVerification: true,
        includeReasoning: true,
        recordAuditEntry: false,
      });
      if (!scanExec.ok) {
        await ctx.telegram.sendMessage(ctx.chat.id, `⚠️ No data found for ${shortCa}.`);
        return;
      }
      const details = formatVerdict(scanExec.result, ca, { context: 'scan', mode: 'full' });
      await ctx.telegram.sendMessage(
        ctx.chat.id,
        details,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '📈 CHART', url: `https://dexscreener.com/solana/${ca}` },
            ]],
          },
        }
      );
    } catch (err) {
      console.error('[details callback] error:', err);
      await ctx.telegram.sendMessage(ctx.chat.id, `⚠️ DETAILS failed for ${shortCa}: ${err.message}`);
    }
    return;
  }

  if (data.startsWith('untrack:')) {
    const ca      = data.split(':')[1];
    const removed = tracker.untrack(ca);
    const shortCa = `${ca.slice(0,6)}...${ca.slice(-4)}`;
    await ctx.answerCbQuery(removed ? `❌ Stopped tracking ${shortCa}` : 'Not currently tracking this token');
    return;
  }

  if (data.startsWith('track:')) {
    const parts = data.split(':');
    const ca    = parts[1];
    const mc    = parseFloat(parts[2]) || 0;

    const tracked = await beginTrackingAnyCa({ ca, chatId: ctx.chat.id, preferredMc: mc });
    if (!tracked.ok) {
      await ctx.answerCbQuery(`⚠️ ${tracked.reason}`);
      return;
    }
    await ctx.answerCbQuery(`✅ Tracking ${tracked.shortCa}`);
    await ctx.telegram.sendMessage(ctx.chat.id, tracked.message);
  }
});

// ── Launch ────────────────────────────────────────────────────────────────────
// v10.2.8 FIX: Start subsystems BEFORE bot.launch().
//
// Root cause of "hunt.start() never called": when Railway deploys, the old
// instance keeps polling for a few seconds. The new instance calls bot.launch(),
// gets 409 Conflict, the old .catch() called process.exit(1), Railway restarted,
// and we were stuck in a boot loop. hunt.start() only ran inside .then(), so it
// was never reached during the loop — and when the loop finally broke, timing
// could still race. Fix: subsystems need only the bot object (they call
// bot.telegram.sendMessage directly, not via polling), so start them immediately.
// bot.launch() is retried with backoff; a 409 is not fatal.

try { tracker.startTracker(bot); }
catch (e) { console.error('[startup] tracker.startTracker error:', e?.stack || e.message); }
logMemoryStartupState();

try { hunt.start(bot, buildKeyboard); }
catch (e) { console.error('[startup] hunt.start error:', e?.stack || e.message); }

try { watchlist.start(bot); }
catch (e) { console.error('[startup] watchlist.start error:', e?.stack || e.message); }

// Non-blocking xAI connectivity check — result appears in Railway logs within ~5s.
// Look for "[reasoning] PROBE OK" or "[reasoning] PROBE FAILED" to diagnose Grok issues.
probeXaiConnection().catch(() => {});

console.log('[startup] subsystems started — launching Telegram polling...');

async function launchWithRetry(maxAttempts = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      console.log(`${config.ORACLE_VERSION} started — polling active (attempt ${attempt})`);

      // Startup ping — hunters already loaded by hunt.start() above.
      const hunters = hunt.listHunters();
      const startupMsg =
        `🚀 <b>${config.ORACLE_VERSION} Online</b>\n` +
        `Modes: Hunt free scan | Birdeye hunt hard-block | Grok sent-alert-only\n` +
        `Hunt engine: running | Use /huntstatus to verify.`;
      for (const chatId of hunters) {
        try { await bot.telegram.sendMessage(chatId, startupMsg, { parse_mode: 'HTML' }); }
        catch (e) { console.error(`[startup] ping failed for ${chatId}:`, e.message); }
      }
      if (hunters.length) console.log(`[startup] pinged ${hunters.length} hunter(s)`);
      return; // success
    } catch (err) {
      const is409 = err.message?.includes('409') || err.description?.includes('Conflict');
      if (is409) {
        console.warn(`[launch] attempt ${attempt}/${maxAttempts}: 409 Conflict — old instance still holds polling lock. Retrying in ${delayMs}ms...`);
      } else {
        console.error(`[launch] attempt ${attempt}/${maxAttempts} failed:`, err.message);
      }
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        console.error('[launch] all attempts exhausted — polling inactive, but subsystems and health check are still running.');
      }
    }
  }
}

try { startAuditLoop(bot, fetchMcOnly); }
catch (e) { console.error('[startup] audit loop error:', e?.stack || e.message); }

launchWithRetry().catch(err => console.error('[launch] launchWithRetry unexpected error:', err?.stack || err));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

process.on('unhandledRejection', err => {
  console.error('[process] unhandledRejection:', err?.stack || err);
});

process.on('uncaughtException', err => {
  console.error('[process] uncaughtException:', err?.stack || err);
  process.exit(1);
});
