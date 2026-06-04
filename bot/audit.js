'use strict';
// Oracle Audit Engine v38.6 - Blueprint Refresh
// Keeps strict safety intact while refreshing winner memory with freshest
// blueprint families and promotion timing tracking.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR = process.env.DATA_DIR || '/data';
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const MAX_ENTRIES = 50;
const HISTORY_LIMIT = 200;
const BATCH_SIZE = 5;
const CYCLE_MS = 30_000;
const RESOLVE_MS = 6 * 60 * 60 * 1000;
const FRESH_24H_MS = 24 * 60 * 60 * 1000;
const FRESH_72H_MS = 72 * 60 * 60 * 1000;

const MISSED_VERDICTS = new Set([
  'SKIP',
  'NO_GO',
  'AVOID',
  'WATCH_VOL',
  'WATCH_WASH',
  'RISKY_RUNNER',
  'DIRTY_RUNNER_WATCH',
]);

const ACTIVE_WINNER_BLUEPRINT_REGISTRY = {
  refreshedAt: new Date().toISOString(),
  tokens: [
    'NEAN',
    'grug',
    'DATBIHGAH',
    'Friday 25x runner',
    'IPO',
    'BAMBIS',
    'GGS',
    'POLYOM',
    'CAT',
    'GOLDBANK',
    'Hillary',
    'ewok',
    'SPSC',
    'NEOW',
    'SigeonPex',
  ],
  families: {
    EARLY_EXPANSION_ZONE: {
      mcRangeUsd: '$5K-$30K',
      volLiqRange: '3x-12x',
      characteristics: ['low wash', 'fresh migration/profile'],
      examples: ['grug', 'IPO', 'BAMBIS', 'GGS', 'POLYOM', 'CAT', 'GOLDBANK', 'Hillary', 'ewok', 'SPSC'],
    },
    BUNDLE_BLOCKED_EXPANSION: {
      bundleRange: '6-10/slot',
      volLiqRange: '8x-13x',
      top10Range: '30-40%',
      characteristics: ['low wash', 'healthy LP'],
      examples: ['DATBIHGAH', 'Friday 25x runner', 'ALPHA'],
    },
    CONTROLLED_CONCENTRATION_WINNER: {
      top10Range: '30-45%',
      characteristics: ['holder health may look inflated', 'organic volume present'],
      examples: ['GRAIL', 'NEAN', 'SigeonPex', 'SOREN', 'ballish'],
    },
    NARRATIVE_CATALYST_RUNNER: {
      characteristics: ['celebrity/Elon/X/politics/news/AI/viral connection'],
      examples: ['duja', 'Hillary', 'ewok'],
    },
    PROMOTION_TIMING_TRACKER: {
      fields: [
        'firstSeenAt',
        'firstSeenMC',
        'firstSeenClass',
        'firstSeenVolLiq',
        'promotionAt',
        'promotionMC',
        'promotionClass',
        'promotionDelayMinutes',
      ],
    },
  },
};

let auditQueue = [];
let auditHistory = [];
let updateTimer = null;

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeVerdict(v) {
  return String(v || '').trim().toUpperCase();
}

function isOracleBuyClass(v) {
  return normalizeVerdict(v) === 'ORACLE_BUY';
}

function normalizeRecord(rec) {
  const outcome = rec.outcome ?? 'UNRESOLVED';
  const scanTime = asNumber(rec.scanTime ?? rec.scannedAt) ?? Date.now();
  const verdict = rec.verdict ?? rec.oracleClass ?? 'UNKNOWN';

  const normalized = {
    ca: rec.ca,
    ticker: rec.ticker ?? rec.symbol ?? '???',
    symbol: rec.symbol ?? rec.ticker ?? '???',
    verdict,
    entryTier: rec.entryTier ?? null,
    scanMc: asNumber(rec.scanMc ?? rec.mc),
    peakMc: asNumber(rec.peakMc ?? rec.scanMc ?? rec.mc),
    currentMc: asNumber(rec.currentMc),
    scannedAt: asNumber(rec.scannedAt) ?? scanTime,
    scanTime,
    lastChecked: asNumber(rec.lastChecked) ?? 0,
    adjustedVolLiq: asNumber(rec.adjustedVolLiq),
    top10Pct: asNumber(rec.top10Pct),
    washPct: asNumber(rec.washPct),
    bundleCount: asNumber(rec.bundleCount),
    lp: asNumber(rec.lp),
    isEliteDev: !!rec.isEliteDev,
    successRatePct: asNumber(rec.successRatePct),
    devLaunches: asNumber(rec.devLaunches),
    source: rec.source ?? null,
    firstSeenAt: asNumber(rec.firstSeenAt) ?? scanTime,
    firstSeenMC: asNumber(rec.firstSeenMC ?? rec.scanMc ?? rec.mc),
    firstSeenClass: rec.firstSeenClass ?? verdict,
    firstSeenVolLiq: asNumber(rec.firstSeenVolLiq ?? rec.adjustedVolLiq),
    promotionAt: asNumber(rec.promotionAt),
    promotionMC: asNumber(rec.promotionMC),
    promotionClass: rec.promotionClass ?? null,
    promotionDelayMinutes: asNumber(rec.promotionDelayMinutes),
    blueprintFamilies: Array.isArray(rec.blueprintFamilies) ? rec.blueprintFamilies : [],
    resolved: rec.resolved ?? outcome !== 'UNRESOLVED',
    outcome,
  };

  if (!(normalized.peakMc > 0) && normalized.scanMc > 0) normalized.peakMc = normalized.scanMc;
  normalized.blueprintFamilies = inferBlueprintFamilies(normalized);
  return normalized;
}

function inferBlueprintFamilies(rec) {
  const families = new Set();
  const mc = asNumber(rec.scanMc ?? rec.firstSeenMC) ?? 0;
  const vol = asNumber(rec.adjustedVolLiq ?? rec.firstSeenVolLiq) ?? 0;
  const wash = asNumber(rec.washPct);
  const top10 = asNumber(rec.top10Pct);
  const bundle = asNumber(rec.bundleCount);
  const hasLowWash = wash == null || wash < 20;

  if (mc >= 5_000 && mc <= 30_000 && vol >= 3 && vol <= 12 && hasLowWash) {
    families.add('EARLY_EXPANSION_ZONE');
  }
  if (bundle != null && bundle >= 6 && bundle <= 10 && vol >= 8 && vol <= 13 && top10 != null && top10 >= 30 && top10 <= 40 && hasLowWash) {
    families.add('BUNDLE_BLOCKED_EXPANSION');
  }
  if (top10 != null && top10 >= 30 && top10 <= 45 && vol >= 3) {
    families.add('CONTROLLED_CONCENTRATION_WINNER');
  }

  const text = `${rec.ticker || ''} ${rec.symbol || ''}`.toLowerCase();
  if (/(elon|x|viral|tweet|hillary|trump|news|ai|duja|ewok)/.test(text)) {
    families.add('NARRATIVE_CATALYST_RUNNER');
  }

  families.add('PROMOTION_TIMING_TRACKER');
  return [...families];
}

function updatePromotionTracker(entry, incoming, now = Date.now()) {
  if (!entry.firstSeenAt) entry.firstSeenAt = now;
  if (entry.firstSeenMC == null && incoming.scanMc != null) entry.firstSeenMC = incoming.scanMc;
  if (!entry.firstSeenClass) entry.firstSeenClass = incoming.verdict || entry.verdict || 'UNKNOWN';
  if (entry.firstSeenVolLiq == null && incoming.adjustedVolLiq != null) entry.firstSeenVolLiq = incoming.adjustedVolLiq;

  const wasOracleBuyInitially = isOracleBuyClass(entry.firstSeenClass);
  const nowOracleBuy = isOracleBuyClass(incoming.verdict);
  if (nowOracleBuy && !entry.promotionAt) {
    entry.promotionAt = now;
    entry.promotionMC = incoming.scanMc ?? entry.scanMc ?? null;
    entry.promotionClass = incoming.verdict;
    const baseTs = entry.firstSeenAt || now;
    entry.promotionDelayMinutes = Math.max(0, Math.round((entry.promotionAt - baseTs) / 60000));
    if (wasOracleBuyInitially) entry.promotionDelayMinutes = 0;
  }
}

function applyRecordUpdate(entry, incoming) {
  const now = Date.now();
  if (incoming.ticker) entry.ticker = incoming.ticker;
  if (incoming.symbol) entry.symbol = incoming.symbol;
  if (incoming.verdict) entry.verdict = incoming.verdict;
  if (incoming.entryTier != null) entry.entryTier = incoming.entryTier;
  if (incoming.scanMc != null) entry.scanMc = incoming.scanMc;
  if (incoming.adjustedVolLiq != null) entry.adjustedVolLiq = incoming.adjustedVolLiq;
  if (incoming.top10Pct != null) entry.top10Pct = incoming.top10Pct;
  if (incoming.bundleCount != null) entry.bundleCount = incoming.bundleCount;
  if (incoming.lp != null) entry.lp = incoming.lp;
  if (incoming.washPct != null) entry.washPct = incoming.washPct;
  if (incoming.successRatePct != null) entry.successRatePct = incoming.successRatePct;
  if (incoming.devLaunches != null) entry.devLaunches = incoming.devLaunches;
  if (incoming.source != null) entry.source = incoming.source;
  if (incoming.currentMc != null) entry.currentMc = incoming.currentMc;
  if (incoming.scanMc != null && (entry.peakMc == null || incoming.scanMc > entry.peakMc)) entry.peakMc = incoming.scanMc;
  if (incoming.currentMc != null && (entry.peakMc == null || incoming.currentMc > entry.peakMc)) entry.peakMc = incoming.currentMc;
  updatePromotionTracker(entry, incoming, now);
  entry.blueprintFamilies = inferBlueprintFamilies(entry);
}

function loadAudit() {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
    if (Array.isArray(raw)) {
      const records = raw.map(normalizeRecord);
      auditHistory = records.filter(r => r.outcome !== 'UNRESOLVED').slice(-HISTORY_LIMIT);
      auditQueue = records.filter(r => r.outcome === 'UNRESOLVED').slice(-MAX_ENTRIES);
      return;
    }
    auditHistory = Array.isArray(raw.history) ? raw.history.map(normalizeRecord).slice(-HISTORY_LIMIT) : [];
    auditQueue = Array.isArray(raw.queue) ? raw.queue.map(normalizeRecord).slice(-MAX_ENTRIES) : [];
  } catch (e) {
    console.warn('[audit] Failed to load audit file:', e.message);
    auditHistory = [];
    auditQueue = [];
  }
}

function saveAudit() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      history: auditHistory.slice(-HISTORY_LIMIT),
      queue: auditQueue.slice(-MAX_ENTRIES),
      activeWinnerBlueprintRegistry: ACTIVE_WINNER_BLUEPRINT_REGISTRY,
      updatedAt: new Date().toISOString(),
    };
    const tmp = AUDIT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, AUDIT_FILE);
  } catch (e) {
    console.warn('[audit] Failed to save audit file:', e.message);
  }
}

function addToAudit(ca, ticker, verdict, entryTier, scanMc, extra = {}) {
  if (!ca || !verdict) return;
  loadAudit();

  const incoming = {
    ca,
    ticker,
    symbol: ticker,
    verdict,
    entryTier,
    scanMc: asNumber(scanMc),
    adjustedVolLiq: asNumber(extra.adjustedVolLiq),
    top10Pct: asNumber(extra.top10Pct),
    washPct: asNumber(extra.washPct),
    bundleCount: asNumber(extra.bundleCount),
    lp: asNumber(extra.lp),
    isEliteDev: !!extra.isEliteDev,
    successRatePct: asNumber(extra.successRatePct),
    devLaunches: asNumber(extra.devLaunches),
    source: extra.source ?? null,
  };

  const existing = [...auditQueue].reverse().find(e => e.ca === ca && !e.resolved);
  if (existing) {
    applyRecordUpdate(existing, incoming);
    saveAudit();
    return;
  }

  const now = Date.now();
  if (auditQueue.length >= MAX_ENTRIES) auditQueue.shift();
  const entry = normalizeRecord({
    ca,
    ticker,
    symbol: ticker,
    verdict,
    entryTier,
    scanMc: incoming.scanMc,
    peakMc: incoming.scanMc,
    scannedAt: now,
    scanTime: now,
    lastChecked: 0,
    adjustedVolLiq: incoming.adjustedVolLiq,
    top10Pct: incoming.top10Pct,
    washPct: incoming.washPct,
    bundleCount: incoming.bundleCount,
    lp: incoming.lp,
    isEliteDev: incoming.isEliteDev,
    successRatePct: incoming.successRatePct,
    devLaunches: incoming.devLaunches,
    source: incoming.source,
    resolved: false,
    outcome: 'UNRESOLVED',
  });
  applyRecordUpdate(entry, incoming);
  auditQueue.push(entry);
  saveAudit();
}

function recordScan({
  ca, symbol, verdict, entryTier, mc, adjustedVolLiq, top10Pct, washPct,
  bundleCount, lp, isEliteDev, successRatePct, devLaunches, source,
}) {
  addToAudit(ca, symbol, verdict, entryTier, mc, {
    adjustedVolLiq,
    top10Pct,
    washPct,
    bundleCount,
    lp,
    isEliteDev,
    successRatePct,
    devLaunches,
    source,
  });
}

async function resolveMc(fetchMcFn, ca) {
  const result = await fetchMcFn(ca);
  if (typeof result === 'number') return result;
  return result?.mc ?? null;
}

function classify(entry) {
  if (!(entry.scanMc > 0) || !(entry.peakMc > 0)) return 'UNKNOWN';
  const multiplier = entry.peakMc / entry.scanMc;
  if (multiplier >= 3) return 'WINNER';
  if (multiplier >= 1.5) return 'RUNNER';
  return 'FLAT_OR_RUG';
}

async function processBatch(bot, fetchMcFn) {
  const pending = auditQueue
    .filter(e => !e.resolved)
    .sort((a, b) => (a.lastChecked || 0) - (b.lastChecked || 0))
    .slice(0, BATCH_SIZE);
  if (pending.length === 0) return;

  for (const entry of pending) {
    try {
      const currentMc = await resolveMc(fetchMcFn, entry.ca);
      entry.lastChecked = Date.now();
      if (currentMc == null) continue;
      entry.currentMc = currentMc;
      if (entry.peakMc == null || currentMc > entry.peakMc) entry.peakMc = currentMc;

      if (Date.now() - entry.scanTime >= RESOLVE_MS) {
        entry.resolved = true;
        entry.outcome = classify(entry);
        entry.blueprintFamilies = inferBlueprintFamilies(entry);
        const multiplier = entry.scanMc > 0 ? entry.peakMc / entry.scanMc : null;
        const wasMissedOrDowngraded = MISSED_VERDICTS.has(normalizeVerdict(entry.verdict));

        if (wasMissedOrDowngraded && multiplier != null && multiplier >= 3 && bot && process.env.OWNER_TELEGRAM_ID) {
          const label = entry.ticker ?? entry.ca.slice(0, 8);
          const msg = `🚨 AUDIT ALERT: Missed ${label} — ${multiplier.toFixed(1)}x from scan verdict ${entry.verdict}`
            + `${entry.entryTier ? ` / ${entry.entryTier}` : ''}. `
            + `Scan MC: $${(entry.scanMc / 1000).toFixed(1)}K → Peak: $${(entry.peakMc / 1000).toFixed(1)}K. `
            + `Pattern memory updated.`;
          bot.telegram.sendMessage(process.env.OWNER_TELEGRAM_ID, msg).catch(() => {});
        }
        auditHistory.push({ ...entry });
      }
    } catch (e) {
      console.warn(`[audit] update failed for ${entry.ca?.slice(0, 8) ?? 'unknown'}:`, e.message);
    }
  }

  auditQueue = auditQueue.filter(e => !e.resolved).slice(-MAX_ENTRIES);
  auditHistory = auditHistory.slice(-HISTORY_LIMIT);
  saveAudit();
}

function startAuditLoop(bot, fetchMcFn) {
  if (typeof fetchMcFn !== 'function') {
    console.warn('[audit] startAuditLoop skipped: fetchMcFn missing');
    return;
  }
  loadAudit();
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(() => {
    processBatch(bot, fetchMcFn).catch(e => console.warn('[audit] batch error:', e.message));
  }, CYCLE_MS);
  console.log(`[audit] v38.6 loop started - ${BATCH_SIZE} CA(s) every ${CYCLE_MS / 1000}s, queue cap ${MAX_ENTRIES}`);
}

function stopAuditLoop() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = null;
}

function getAuditReport() {
  loadAudit();
  const recent = [...auditHistory].slice(-10).reverse();
  if (recent.length === 0) {
    return `AUDIT - No resolved entries yet.\n${auditQueue.length} pending in queue.`;
  }
  const lines = recent.map(e => {
    const mult = e.scanMc > 0 && e.peakMc > 0 ? `${(e.peakMc / e.scanMc).toFixed(1)}x` : '?x';
    const timing = e.promotionDelayMinutes != null ? ` | promotion ${e.promotionDelayMinutes}m` : '';
    return `${e.outcome} ${e.ticker ?? e.ca.slice(0, 8)} | Scan: $${(e.scanMc / 1000).toFixed(1)}K -> Peak: $${(e.peakMc / 1000).toFixed(1)}K (${mult}) | ${e.verdict}${timing}`;
  });
  return `AUDIT - Last 10 Resolved\n\n${lines.join('\n')}\n\n${auditQueue.length} pending in queue`;
}

function getAll() {
  loadAudit();
  return [...auditHistory, ...auditQueue].map(normalizeRecord);
}

function getUnresolved() {
  loadAudit();
  return auditQueue.filter(e => !e.resolved);
}

function summarizeNamedComparables(records, names) {
  const byName = {};
  for (const n of names) {
    const needle = String(n).toLowerCase().replace(/\s+/g, '');
    const found = records.find(r => {
      const txt = `${r.ticker || ''}${r.symbol || ''}`.toLowerCase().replace(/\s+/g, '');
      return txt.includes(needle);
    });
    byName[n] = found || null;
  }
  return byName;
}

function getPatternMemory() {
  loadAudit();
  const now = Date.now();
  const winnersAll = auditHistory
    .filter(r => r.outcome === 'WINNER' || r.outcome === 'RUNNER')
    .sort((a, b) => b.scanTime - a.scanTime);

  const winners = winnersAll.slice(0, 8);
  const rugs = auditHistory
    .filter(r => r.outcome === 'FLAT_OR_RUG')
    .sort((a, b) => b.scanTime - a.scanTime)
    .slice(0, 8);

  const freshWinners24 = winnersAll.filter(r => (now - r.scanTime) <= FRESH_24H_MS).slice(0, 12);
  const freshWinners72 = winnersAll.filter(r => (now - r.scanTime) <= FRESH_72H_MS).slice(0, 20);
  const staleWinners = winnersAll.filter(r => (now - r.scanTime) > FRESH_72H_MS).slice(0, 8);

  const missedWinners = winnersAll
    .filter(r => MISSED_VERDICTS.has(normalizeVerdict(r.verdict)))
    .slice(0, 12);

  const namedComparables = summarizeNamedComparables(winnersAll, ACTIVE_WINNER_BLUEPRINT_REGISTRY.tokens);

  if (!winners.length && !rugs.length && !missedWinners.length) return null;

  return {
    winners,
    rugs,
    missedWinners,
    freshWinners24,
    freshWinners72,
    staleWinners,
    namedComparables,
    activeBlueprints: ACTIVE_WINNER_BLUEPRINT_REGISTRY,
  };
}

function updatePeaks(mcMap) {
  loadAudit();
  for (const entry of auditQueue) {
    const mc = mcMap?.[entry.ca];
    if (mc != null && (entry.peakMc == null || mc > entry.peakMc)) entry.peakMc = mc;
    entry.lastChecked = Date.now();
    entry.blueprintFamilies = inferBlueprintFamilies(entry);
  }
  saveAudit();
}

async function processPendingOnce(fetchMcFn, { limit = 10, allowBirdeye = false, deepMode = false } = {}) {
  loadAudit();
  const pending = auditQueue
    .filter(e => !e.resolved)
    .sort((a, b) => (a.lastChecked || 0) - (b.lastChecked || 0))
    .slice(0, Math.max(1, limit));
  if (!pending.length) return { checked: 0, resolved: 0 };

  let resolved = 0;
  for (const entry of pending) {
    const currentMc = await resolveMc((ca) => fetchMcFn(ca, { allowBirdeye, deepMode }), entry.ca);
    entry.lastChecked = Date.now();
    if (currentMc == null) continue;
    entry.currentMc = currentMc;
    if (entry.peakMc == null || currentMc > entry.peakMc) entry.peakMc = currentMc;
    if (Date.now() - entry.scanTime >= RESOLVE_MS) {
      entry.resolved = true;
      entry.outcome = classify(entry);
      entry.blueprintFamilies = inferBlueprintFamilies(entry);
      resolved++;
      auditHistory.push({ ...entry });
    }
  }
  auditQueue = auditQueue.filter(e => !e.resolved).slice(-MAX_ENTRIES);
  auditHistory = auditHistory.slice(-HISTORY_LIMIT);
  saveAudit();
  return { checked: pending.length, resolved };
}

function getAuditPendingReport() {
  loadAudit();
  const now = Date.now();
  const pending = auditQueue.filter(e => !e.resolved);
  if (!pending.length) return 'No unresolved audit entries.';
  return pending.slice(0, 30).map((e, idx) => {
    const current = e.currentMc ?? e.scanMc ?? 0;
    const peak = e.peakMc ?? current;
    const mult = e.scanMc > 0 && current > 0 ? (current / e.scanMc).toFixed(2) : 'N/A';
    const ageMin = Math.floor((now - e.scanTime) / 60000);
    const resolveIn = Math.max(0, Math.floor((RESOLVE_MS - (now - e.scanTime)) / 60000));
    const promo = e.promotionDelayMinutes != null ? ` | promo:${e.promotionDelayMinutes}m` : '';
    return `${idx + 1}. ${e.ticker} | ${e.verdict} | scan:$${Math.round((e.scanMc || 0) / 1000)}K | current:$${Math.round((current || 0) / 1000)}K | peak:$${Math.round((peak || 0) / 1000)}K | multiple:${mult}x | age:${ageMin}m | resolve:${resolveIn}m${promo}`;
  }).join('\n');
}

function matchLearnedPattern(result) {
  const memory = getPatternMemory();
  if (!memory?.missedWinners?.length && !memory?.freshWinners72?.length) {
    return { matched: false, action: null, type: null, confidence: 0, reason: 'No fresh learned runner patterns yet.' };
  }
  const s = result?.signals || {};
  const candidate = {
    mc: Number(s.marketCap || 0),
    top10: Number(s.top10Pct || 0),
    wash: Number(s.washPct || 0),
    vol: Number(s.adjustedVolLiq || 0),
    bundle: Number(s.bundleCount || 0),
  };
  const earlyExpansion = candidate.mc >= 5_000 && candidate.mc <= 30_000 && candidate.vol >= 3 && candidate.vol <= 12 && (candidate.wash <= 20 || candidate.wash === 0);
  const bundleExpansion = candidate.bundle >= 6 && candidate.bundle <= 10 && candidate.vol >= 8 && candidate.vol <= 13 && candidate.top10 >= 30 && candidate.top10 <= 40 && candidate.wash < 15;
  const controlledConc = candidate.top10 >= 30 && candidate.top10 <= 45 && candidate.vol >= 3;

  const confidence = earlyExpansion || bundleExpansion || controlledConc ? 0.76 : 0.56;
  let type = null;
  if (bundleExpansion) type = 'BUNDLE_BLOCKED_EXPANSION';
  else if (earlyExpansion) type = 'EARLY_EXPANSION_ZONE';
  else if (controlledConc) type = 'CONTROLLED_CONCENTRATION_WINNER';

  return {
    matched: confidence >= (config.DIRTY_RUNNER_MIN_CONFIDENCE || 0.7),
    action: 'DIRTY_RUNNER_WATCH',
    type: type || 'CONCENTRATION_RUNNER',
    confidence,
    reason: type
      ? `Matches fresh ${type} winner-family blueprint from recent audit memory.`
      : 'Matches prior missed 3x+ concentration runners: sub-$100K, organic vol, elevated top10, low wash.',
  };
}

module.exports = {
  ACTIVE_WINNER_BLUEPRINT_REGISTRY,
  addToAudit,
  recordScan,
  startAuditLoop,
  stopAuditLoop,
  getAuditReport,
  loadAudit,
  updatePeaks,
  getAll,
  getUnresolved,
  getPatternMemory,
  getAuditPendingReport,
  processPendingOnce,
  matchLearnedPattern,
};
