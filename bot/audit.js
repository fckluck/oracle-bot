'use strict';
// Oracle Audit Engine v38.5
// Memory-safe persistence + pending ATH snapshots + fingerprint storage.

const fs   = require('fs');
const path = require('path');
const config = require('./config');
const { resolveTraderClass } = require('./trader-ui');

const DATA_DIR      = process.env.DATA_DIR || '/data';
const AUDIT_FILE    = path.join(DATA_DIR, 'audit.json');
const MAX_ENTRIES   = 50;
const HISTORY_LIMIT = 200;
const BATCH_SIZE    = 5;
const CYCLE_MS      = 30_000;
const RESOLVE_MS    = 6 * 60 * 60 * 1000;
const REMOVED_WINNER_IMPRINTS = new Set(['sigeonpex']);
const MISSED_REJECT_VERDICTS = new Set([
  'SKIP',
  'NO_GO',
  'AVOID',
  'WATCH_VOL',
  'WATCH_WASH',
  'RISKY_RUNNER',
  'DIRTY_RUNNER_WATCH',
  'MISSED_WINNER_MATCH',
  'WATCH',
]);

let auditQueue = [];
let auditHistory = [];
let winnerFingerprints = [];
let failedFingerprints = [];
let updateTimer = null;

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function isRemovedWinnerImprint(entry = {}) {
  const name = String(entry.ticker || entry.symbol || '').toLowerCase();
  return REMOVED_WINNER_IMPRINTS.has(name);
}

function normalizeRecord(rec) {
  const outcome = rec.outcome ?? 'UNRESOLVED';
  const holderHealthPct = rec.holderHealthPct ?? rec.holderHealth?.healthPct ?? null;
  const scanMc = rec.scanMc ?? rec.mc ?? null;
  const peakMc = rec.peakMc ?? scanMc ?? null;
  const firstSeenMc = rec.firstSeenMc ?? scanMc ?? null;
  const alertMc = rec.alertMc ?? scanMc ?? null;
  const firstSeenAt = rec.firstSeenAt ?? rec.scanTime ?? rec.scannedAt ?? Date.now();
  const alertAt = rec.alertAt ?? rec.scanTime ?? rec.scannedAt ?? Date.now();
  const currentMc = rec.currentMc ?? scanMc ?? null;
  const multipleFromFirstSeen = firstSeenMc > 0 && peakMc > 0 ? peakMc / firstSeenMc : null;
  const multipleFromAlert = alertMc > 0 && peakMc > 0 ? peakMc / alertMc : null;
  const promotionDelayMinutes = firstSeenAt > 0 && alertAt > 0
    ? Math.max(0, Math.round((alertAt - firstSeenAt) / 60000))
    : null;

  return {
    ca: rec.ca,
    ticker: rec.ticker ?? rec.symbol ?? '???',
    symbol: rec.symbol ?? rec.ticker ?? '???',
    verdict: rec.verdict,
    oracleScoreTotal: rec.oracleScoreTotal ?? rec.oracleScore?.total ?? null,
    oracleScoreClass: rec.oracleScoreClass ?? rec.oracleScore?.class ?? null,
    entryTier: rec.entryTier ?? null,
    scanMc,
    peakMc,
    currentMc,
    scannedAt: rec.scannedAt ?? rec.scanTime ?? Date.now(),
    scanTime: rec.scanTime ?? rec.scannedAt ?? Date.now(),
    firstSeenMc,
    firstSeenAt,
    firstSeenSource: rec.firstSeenSource ?? rec.source ?? null,
    firstSeenClass: rec.firstSeenClass ?? rec.oracleScoreClass ?? rec.verdict ?? null,
    alertMc,
    alertAt,
    alertClass: rec.alertClass ?? rec.oracleScoreClass ?? rec.verdict ?? null,
    promotionDelayMinutes,
    trackEntryMc: rec.trackEntryMc ?? null,
    guardianPeakMc: rec.guardianPeakMc ?? rec.peakMc ?? null,
    trueAthMc: rec.trueAthMc ?? null,
    multipleFromFirstSeen,
    multipleFromAlert,
    promotionAlerted: !!rec.promotionAlerted,
    lastChecked: rec.lastChecked ?? 0,
    adjustedVolLiq: rec.adjustedVolLiq ?? null,
    rawVolLiq: rec.rawVolLiq ?? null,
    lp: rec.lp ?? null,
    top10Pct: rec.top10Pct ?? null,
    top50Pct: rec.top50Pct ?? null,
    holderCount: rec.holderCount ?? null,
    holderHealthPct,
    bundleCount: rec.bundleCount ?? null,
    sybilFunded: !!rec.sybilFunded,
    washPct: rec.washPct ?? null,
    isEliteDev: rec.isEliteDev ?? false,
    successRatePct: rec.successRatePct ?? null,
    devLaunches: rec.devLaunches ?? null,
    peakMultiplier: rec.peakMultiplier ?? null,
    ageMinutes: rec.ageMinutes ?? null,
    timeWindow: rec.timeWindow ?? null,
    socialMentions15m: rec.socialMentions15m ?? null,
    uniqueAccounts: rec.uniqueAccounts ?? null,
    narrativeType: rec.narrativeType ?? 'NONE',
    narrativeStrength: rec.narrativeStrength ?? 0,
    narrativeReason: rec.narrativeReason ?? null,
    noGoReason: rec.noGoReason ?? null,
    watchReason: rec.watchReason ?? null,
    headlineType: rec.headlineType ?? null,
    blueprintAction: rec.blueprintAction ?? null,
    blueprintConfidence: rec.blueprintConfidence ?? null,
    blueprintMatches: normalizeStringArray(rec.blueprintMatches),
    blueprintReason: rec.blueprintReason ?? null,
    source: rec.source ?? null,

    resolved: rec.resolved ?? outcome !== 'UNRESOLVED',
    outcome,
  };
}

function normalizeFingerprint(fp = {}) {
  return {
    ca: fp.ca ?? null,
    ticker: fp.ticker ?? fp.symbol ?? '???',
    symbol: fp.symbol ?? fp.ticker ?? '???',
    scanMc: fp.scanMc ?? null,
    peakMc: fp.peakMc ?? null,
    multiple: fp.multiple ?? null,
    verdict: fp.verdict ?? null,
    oracleScoreTotal: fp.oracleScoreTotal ?? null,
    oracleScoreClass: fp.oracleScoreClass ?? null,
    adjustedVolLiq: fp.adjustedVolLiq ?? null,
    rawVolLiq: fp.rawVolLiq ?? null,
    lp: fp.lp ?? null,
    top10Pct: fp.top10Pct ?? null,
    top50Pct: fp.top50Pct ?? null,
    holderCount: fp.holderCount ?? null,
    holderHealthPct: fp.holderHealthPct ?? null,
    bundleCount: fp.bundleCount ?? null,
    sybilFunded: !!fp.sybilFunded,
    washPct: fp.washPct ?? null,
    successRatePct: fp.successRatePct ?? null,
    devLaunches: fp.devLaunches ?? null,
    peakMultiplier: fp.peakMultiplier ?? null,
    ageMinutes: fp.ageMinutes ?? null,
    timeWindow: fp.timeWindow ?? null,
    socialMentions15m: fp.socialMentions15m ?? null,
    uniqueAccounts: fp.uniqueAccounts ?? null,
    narrativeType: fp.narrativeType ?? 'NONE',
    narrativeStrength: fp.narrativeStrength ?? 0,
    narrativeReason: fp.narrativeReason ?? null,
    noGoReason: fp.noGoReason ?? null,
    watchReason: fp.watchReason ?? null,
    headlineType: fp.headlineType ?? null,
    blueprintAction: fp.blueprintAction ?? null,
    blueprintConfidence: fp.blueprintConfidence ?? null,
    blueprintMatches: normalizeStringArray(fp.blueprintMatches),
    blueprintReason: fp.blueprintReason ?? null,
    source: fp.source ?? null,
    learnedAt: fp.learnedAt ?? null,
    reason: fp.reason ?? null,
    originalClass: fp.originalClass ?? null,
    originalScore: fp.originalScore ?? null,
    originalScanMc: fp.originalScanMc ?? null,
    currentMc: fp.currentMc ?? null,
    currentPeakMc: fp.currentPeakMc ?? null,
    multipleFromScan: fp.multipleFromScan ?? fp.multiple ?? null,
    outcome: fp.outcome ?? 'UNKNOWN',
    failureReason: fp.failureReason ?? null,
    resolvedAt: fp.resolvedAt ?? Date.now(),
    scanTime: fp.scanTime ?? null,
  };
}

function classPriority(cls) {
  const key = String(cls || '').toUpperCase();
  const rank = {
    ORACLE_BUY: 100,
    MISSED_WINNER_MATCH: 90,
    DIRTY_RUNNER_WATCH: 80,
    PEARL_WATCH: 70,
    RISKY_RUNNER: 60,
    WATCH_VOL: 50,
    WATCH_WASH: 45,
    WATCH: 40,
    ALERT: 35,
    SKIP: 30,
    NO_GO: 20,
    AVOID: 10,
  };
  return rank[key] ?? 0;
}

function isCatastrophicRecord(entry = {}) {
  if (entry.sybilFunded) return true;
  if (entry.washPct != null && Number(entry.washPct) > 50) return true;
  if (!(Number(entry.scanMc || entry.firstSeenMc || 0) > 0)) return true;
  if (entry.lp != null && Number(entry.lp) < 0) return true;
  return false;
}

function archiveCorruptFile(filePath, reason) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const corruptPath = filePath.replace(/\.json$/i, '') + `.corrupt.${ts}.json`;
    fs.renameSync(filePath, corruptPath);
    console.warn(`[audit] ${reason}; preserved corrupt file at ${corruptPath}`);
    return corruptPath;
  } catch (e) {
    console.warn(`[audit] failed to preserve corrupt file ${filePath}: ${e.message}`);
    return null;
  }
}

function loadAudit() {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return;
    const text = fs.readFileSync(AUDIT_FILE, 'utf8');
    let raw = null;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      archiveCorruptFile(AUDIT_FILE, `JSON parse failed (${e.message})`);
      auditHistory = [];
      auditQueue = [];
      winnerFingerprints = [];
      failedFingerprints = [];
      return;
    }

    if (Array.isArray(raw)) {
      const records = raw.map(normalizeRecord);
      auditHistory = records.filter(r => r.outcome !== 'UNRESOLVED').slice(-HISTORY_LIMIT);
      auditQueue = records.filter(r => r.outcome === 'UNRESOLVED').slice(-MAX_ENTRIES);
      winnerFingerprints = [];
      failedFingerprints = [];
      return;
    }

    auditHistory = Array.isArray(raw.history) ? raw.history.map(normalizeRecord).slice(-HISTORY_LIMIT) : [];
    auditQueue = Array.isArray(raw.queue) ? raw.queue.map(normalizeRecord).slice(-MAX_ENTRIES) : [];
    winnerFingerprints = Array.isArray(raw.winnerFingerprints)
      ? raw.winnerFingerprints.map(normalizeFingerprint)
      : [];
    failedFingerprints = Array.isArray(raw.failedFingerprints)
      ? raw.failedFingerprints.map(normalizeFingerprint)
      : [];
  } catch (e) {
    console.warn('[audit] Failed to load audit file:', e.message);
    auditHistory = [];
    auditQueue = [];
    winnerFingerprints = [];
    failedFingerprints = [];
  }
}

function saveAudit() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const hasAnyData = auditHistory.length || auditQueue.length || winnerFingerprints.length || failedFingerprints.length;
    if (!hasAnyData && fs.existsSync(AUDIT_FILE)) {
      // Memory-safety: never wipe existing audit memory with an empty payload.
      return;
    }
    const payload = {
      history: auditHistory.slice(-HISTORY_LIMIT),
      queue: auditQueue.slice(-MAX_ENTRIES),
      winnerFingerprints,
      failedFingerprints,
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

  const now = Date.now();
  const existingIdx = auditQueue.findIndex(e => e.ca === ca && !e.resolved);
  if (existingIdx >= 0) {
    const existing = auditQueue[existingIdx];
    const currentMc = scanMc ?? existing.currentMc ?? existing.scanMc ?? existing.firstSeenMc ?? null;
    const peakMc = Math.max(existing.peakMc ?? 0, currentMc ?? 0, existing.currentMc ?? 0);
    const incomingClass = extra.oracleScoreClass || verdict;
    const prevClass = existing.alertClass || existing.oracleScoreClass || existing.verdict;
    const classChanged = String(prevClass || '').toUpperCase() !== String(incomingClass || '').toUpperCase();
    const classImproved = classPriority(incomingClass) > classPriority(prevClass);
    const shouldRefreshAlert = classChanged || classImproved;

    const updated = normalizeRecord({
      ...existing,
      ticker: ticker || existing.ticker,
      symbol: ticker || existing.symbol,
      verdict,
      entryTier: entryTier ?? existing.entryTier,
      oracleScoreClass: incomingClass ?? existing.oracleScoreClass,
      oracleScoreTotal: extra.oracleScoreTotal ?? existing.oracleScoreTotal,
      currentMc: currentMc ?? existing.currentMc,
      peakMc,
      firstSeenMc: existing.firstSeenMc ?? existing.scanMc ?? scanMc ?? null,
      firstSeenAt: existing.firstSeenAt ?? existing.scanTime ?? now,
      firstSeenSource: existing.firstSeenSource ?? existing.source ?? extra.source ?? null,
      firstSeenClass: existing.firstSeenClass ?? existing.oracleScoreClass ?? existing.verdict ?? incomingClass,
      alertMc: shouldRefreshAlert ? (currentMc ?? existing.alertMc ?? existing.scanMc ?? null) : (existing.alertMc ?? existing.scanMc ?? currentMc ?? null),
      alertAt: shouldRefreshAlert ? now : (existing.alertAt ?? existing.scanTime ?? now),
      alertClass: shouldRefreshAlert ? incomingClass : (existing.alertClass ?? incomingClass),
      lastChecked: now,
      adjustedVolLiq: extra.adjustedVolLiq ?? existing.adjustedVolLiq,
      rawVolLiq: extra.rawVolLiq ?? existing.rawVolLiq,
      lp: extra.lp ?? existing.lp,
      top10Pct: extra.top10Pct ?? existing.top10Pct,
      top50Pct: extra.top50Pct ?? existing.top50Pct,
      holderCount: extra.holderCount ?? existing.holderCount,
      holderHealthPct: extra.holderHealthPct ?? existing.holderHealthPct,
      bundleCount: extra.bundleCount ?? existing.bundleCount,
      sybilFunded: extra.sybilFunded ?? existing.sybilFunded,
      washPct: extra.washPct ?? existing.washPct,
      isEliteDev: extra.isEliteDev ?? existing.isEliteDev,
      successRatePct: extra.successRatePct ?? existing.successRatePct,
      devLaunches: extra.devLaunches ?? existing.devLaunches,
      peakMultiplier: extra.peakMultiplier ?? existing.peakMultiplier,
      ageMinutes: extra.ageMinutes ?? existing.ageMinutes,
      timeWindow: extra.timeWindow ?? existing.timeWindow,
      socialMentions15m: extra.socialMentions15m ?? existing.socialMentions15m,
      uniqueAccounts: extra.uniqueAccounts ?? existing.uniqueAccounts,
      narrativeType: extra.narrativeType ?? existing.narrativeType,
      narrativeStrength: extra.narrativeStrength ?? existing.narrativeStrength,
      narrativeReason: extra.narrativeReason ?? existing.narrativeReason,
      noGoReason: extra.noGoReason ?? existing.noGoReason,
      watchReason: extra.watchReason ?? existing.watchReason,
      headlineType: extra.headlineType ?? existing.headlineType,
      blueprintAction: extra.blueprintAction ?? existing.blueprintAction,
      blueprintConfidence: extra.blueprintConfidence ?? existing.blueprintConfidence,
      blueprintMatches: extra.blueprintMatches ?? existing.blueprintMatches,
      blueprintReason: extra.blueprintReason ?? existing.blueprintReason,
      trackEntryMc: extra.trackEntryMc ?? existing.trackEntryMc,
      guardianPeakMc: extra.guardianPeakMc ?? existing.guardianPeakMc,
      trueAthMc: extra.trueAthMc ?? existing.trueAthMc,
      source: extra.source ?? existing.source,
      resolved: false,
      outcome: 'UNRESOLVED',
    });
    auditQueue[existingIdx] = updated;
    saveAudit();
    return;
  }

  if (auditQueue.length >= MAX_ENTRIES) auditQueue.shift();
  auditQueue.push(normalizeRecord({
    ca,
    ticker,
    symbol: ticker,
    verdict,
    entryTier,
    scanMc: scanMc ?? null,
    peakMc: scanMc ?? null,
    currentMc: scanMc ?? null,
    scannedAt: now,
    scanTime: now,
    firstSeenMc: scanMc ?? null,
    firstSeenAt: now,
    firstSeenSource: extra.source ?? null,
    firstSeenClass: extra.oracleScoreClass ?? verdict,
    alertMc: scanMc ?? null,
    alertAt: now,
    alertClass: extra.oracleScoreClass ?? verdict,
    promotionDelayMinutes: 0,
    trackEntryMc: extra.trackEntryMc ?? null,
    guardianPeakMc: extra.guardianPeakMc ?? scanMc ?? null,
    trueAthMc: extra.trueAthMc ?? null,
    multipleFromFirstSeen: 1,
    multipleFromAlert: 1,
    promotionAlerted: false,
    lastChecked: 0,
    adjustedVolLiq: extra.adjustedVolLiq,
    rawVolLiq: extra.rawVolLiq,
    lp: extra.lp,
    top10Pct: extra.top10Pct,
    top50Pct: extra.top50Pct,
    holderCount: extra.holderCount,
    holderHealthPct: extra.holderHealthPct,
    bundleCount: extra.bundleCount,
    sybilFunded: extra.sybilFunded,
    washPct: extra.washPct,
    isEliteDev: extra.isEliteDev,
    successRatePct: extra.successRatePct,
    devLaunches: extra.devLaunches,
    peakMultiplier: extra.peakMultiplier,
    ageMinutes: extra.ageMinutes,
    timeWindow: extra.timeWindow,
    socialMentions15m: extra.socialMentions15m,
    uniqueAccounts: extra.uniqueAccounts,
    narrativeType: extra.narrativeType,
    narrativeStrength: extra.narrativeStrength,
    narrativeReason: extra.narrativeReason,
    noGoReason: extra.noGoReason,
    watchReason: extra.watchReason,
    headlineType: extra.headlineType,
    oracleScoreTotal: extra.oracleScoreTotal,
    oracleScoreClass: extra.oracleScoreClass,
    blueprintAction: extra.blueprintAction,
    blueprintConfidence: extra.blueprintConfidence,
    blueprintMatches: extra.blueprintMatches,
    blueprintReason: extra.blueprintReason,
    source: extra.source,
    resolved: false,
    outcome: 'UNRESOLVED',
  }));
  saveAudit();
}

function recordScan({
  ca, symbol, verdict, entryTier, mc, adjustedVolLiq, top10Pct, washPct,
  rawVolLiq, lp, top50Pct, holderCount, holderHealthPct, bundleCount, sybilFunded,
  isEliteDev, successRatePct, devLaunches, peakMultiplier, ageMinutes, timeWindow,
  socialMentions15m, uniqueAccounts, narrativeType, narrativeStrength, narrativeReason,
  noGoReason, watchReason, headlineType, oracleScoreTotal, oracleScoreClass, source,
  blueprintAction, blueprintConfidence, blueprintMatches, blueprintReason,
  trackEntryMc, guardianPeakMc, trueAthMc,
}) {
  addToAudit(ca, symbol, verdict, entryTier, mc, {
    adjustedVolLiq,
    rawVolLiq,
    lp,
    top10Pct,
    top50Pct,
    holderCount,
    holderHealthPct,
    bundleCount,
    sybilFunded,
    washPct,
    isEliteDev,
    successRatePct,
    devLaunches,
    peakMultiplier,
    ageMinutes,
    timeWindow,
    socialMentions15m,
    uniqueAccounts,
    narrativeType,
    narrativeStrength,
    narrativeReason,
    noGoReason,
    watchReason,
    headlineType,
    oracleScoreTotal,
    oracleScoreClass,
    blueprintAction,
    blueprintConfidence,
    blueprintMatches,
    blueprintReason,
    trackEntryMc,
    guardianPeakMc,
    trueAthMc,
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

function inferFailureReason(entry) {
  return entry.noGoReason || entry.watchReason || entry.headlineType || 'unclassified_failure';
}

function buildFingerprint(entry, outcome) {
  const multiple = entry.scanMc > 0 && entry.peakMc > 0 ? entry.peakMc / entry.scanMc : null;
  return normalizeFingerprint({
    ca: entry.ca,
    ticker: entry.ticker,
    symbol: entry.symbol,
    scanMc: entry.scanMc,
    peakMc: entry.peakMc,
    multiple,
    verdict: entry.oracleScoreClass || entry.verdict,
    oracleScoreTotal: entry.oracleScoreTotal,
    oracleScoreClass: entry.oracleScoreClass,
    adjustedVolLiq: entry.adjustedVolLiq,
    rawVolLiq: entry.rawVolLiq,
    lp: entry.lp,
    top10Pct: entry.top10Pct,
    top50Pct: entry.top50Pct,
    holderCount: entry.holderCount,
    holderHealthPct: entry.holderHealthPct,
    bundleCount: entry.bundleCount,
    sybilFunded: entry.sybilFunded,
    washPct: entry.washPct,
    successRatePct: entry.successRatePct,
    devLaunches: entry.devLaunches,
    peakMultiplier: entry.peakMultiplier,
    ageMinutes: entry.ageMinutes,
    timeWindow: entry.timeWindow,
    socialMentions15m: entry.socialMentions15m,
    uniqueAccounts: entry.uniqueAccounts,
    narrativeType: entry.narrativeType,
    narrativeStrength: entry.narrativeStrength,
    narrativeReason: entry.narrativeReason,
    noGoReason: entry.noGoReason,
    watchReason: entry.watchReason,
    headlineType: entry.headlineType,
    blueprintAction: entry.blueprintAction,
    blueprintConfidence: entry.blueprintConfidence,
    blueprintMatches: entry.blueprintMatches,
    blueprintReason: entry.blueprintReason,
    outcome,
    failureReason: outcome === 'WINNER' ? null : inferFailureReason(entry),
    resolvedAt: Date.now(),
    scanTime: entry.scanTime,
  });
}

function pushFingerprint(entry) {
  const outcome = entry.outcome || classify(entry);
  const fp = buildFingerprint(entry, outcome);
  if (outcome === 'WINNER') {
    winnerFingerprints.push(fp);
  } else {
    failedFingerprints.push(fp);
  }
}

async function processBatch(bot, fetchMcFn) {
  const promotableOriginalClasses = new Set([
    'WATCH',
    'WATCH_VOL',
    'DIRTY_RUNNER_WATCH',
    'PEARL_WATCH',
    'SKIP',
    'NO_GO',
    'RISKY_RUNNER',
    'ALERT',
  ]);
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
      if (entry.trueAthMc == null || currentMc > entry.trueAthMc) entry.trueAthMc = currentMc;
      entry.guardianPeakMc = Math.max(entry.guardianPeakMc || 0, entry.peakMc || 0, currentMc || 0);
      entry.multipleFromFirstSeen = entry.firstSeenMc > 0 && entry.peakMc > 0 ? entry.peakMc / entry.firstSeenMc : null;
      entry.multipleFromAlert = entry.alertMc > 0 && entry.peakMc > 0 ? entry.peakMc / entry.alertMc : null;
      entry.promotionDelayMinutes = entry.firstSeenAt > 0 && entry.alertAt > 0
        ? Math.max(0, Math.round((entry.alertAt - entry.firstSeenAt) / 60000))
        : null;

      const firstSeenClass = String(entry.firstSeenClass || entry.verdict || '').toUpperCase();
      const firstSeenMc = Number(entry.firstSeenMc || 0);
      const moveFromFirst = Number(entry.multipleFromFirstSeen || 0);
      const isHuntOrigin = String(entry.firstSeenSource || entry.source || '').toLowerCase().includes('hunt');
      const catastrophic = isCatastrophicRecord(entry);
      if (
        bot &&
        process.env.OWNER_TELEGRAM_ID &&
        !entry.promotionAlerted &&
        !entry.resolved &&
        isHuntOrigin &&
        firstSeenMc >= 9_000 &&
        firstSeenMc <= 45_000 &&
        moveFromFirst >= 1.5 &&
        promotableOriginalClasses.has(firstSeenClass) &&
        !catastrophic
      ) {
        const symbol = entry.ticker || entry.symbol || entry.ca.slice(0, 8);
        const msg = `🦪 HUNT PEARL PROMOTED\n\n`
          + `Hunt saw this earlier.\n`
          + `Token: ${symbol}\n`
          + `CA: ${entry.ca}\n`
          + `First Seen MC: ${fmtUsdCompact(entry.firstSeenMc)}\n`
          + `Current/Peak: ${fmtUsdCompact(entry.currentMc)}/${fmtUsdCompact(entry.peakMc)}\n`
          + `Move From First Seen: ${moveFromFirst.toFixed(2)}x\n`
          + `Original Class: ${entry.firstSeenClass || entry.verdict}\n\n`
          + `Action: chart/track now. Chase guard applies; no blind entry if already extended.`;
        bot.telegram.sendMessage(process.env.OWNER_TELEGRAM_ID, msg).catch(() => {});
        entry.promotionAlerted = true;
      }

      if (Date.now() - entry.scanTime >= RESOLVE_MS) {
        entry.resolved = true;
        entry.outcome = classify(entry);
        const multiplier = entry.scanMc > 0 ? entry.peakMc / entry.scanMc : null;
        const wasMissedOrDowngraded = MISSED_REJECT_VERDICTS.has(entry.verdict);

        if (wasMissedOrDowngraded && multiplier != null && multiplier >= 3 && bot && process.env.OWNER_TELEGRAM_ID) {
          const label = entry.ticker ?? entry.ca.slice(0, 8);
          const blueprintLine = `${entry.blueprintAction || 'N/A'} / ${(entry.blueprintMatches || []).length ? entry.blueprintMatches.join(', ') : 'N/A'}`;
          const msg = `🚨 AUDIT ALERT: Missed ${label} — ${multiplier.toFixed(1)}x from scan verdict ${entry.verdict}`
            + `${entry.entryTier ? ` / ${entry.entryTier}` : ''}\n`
            + `CA: ${entry.ca}\n`
            + `Scan MC: $${(entry.scanMc / 1000).toFixed(1)}K → Peak: $${(entry.peakMc / 1000).toFixed(1)}K\n`
            + `Blueprint: ${blueprintLine}\n`
            + `Pattern memory updated.`;
          bot.telegram.sendMessage(process.env.OWNER_TELEGRAM_ID, msg).catch(() => {});
        }
        const resolvedEntry = { ...entry };
        auditHistory.push(resolvedEntry);
        pushFingerprint(resolvedEntry);
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
  console.log(`[audit] v37 loop started - ${BATCH_SIZE} CA(s) every ${CYCLE_MS / 1000}s, queue cap ${MAX_ENTRIES}`);
}

function stopAuditLoop() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = null;
}

function getAuditReport() {
  loadAudit();
  const recent = [...auditHistory].slice(-10).reverse();
  const pendingSnapshot = auditQueue
    .filter(e => !e.resolved)
    .map(e => {
      const current = e.currentMc ?? e.peakMc ?? e.scanMc ?? 0;
      const peak = Math.max(e.peakMc ?? 0, current);
      const multiple = e.scanMc > 0 && peak > 0 ? peak / e.scanMc : 0;
      return { ...e, current, peak, multiple };
    })
    .sort((a, b) => b.multiple - a.multiple)
    .slice(0, 10);

  const resolvedLines = recent.length
    ? recent.map(e => {
      const mult = e.scanMc > 0 && e.peakMc > 0 ? `${(e.peakMc / e.scanMc).toFixed(1)}x` : '?x';
      const classLabel = resolveTraderClass(e.oracleScoreClass || e.verdict, e.oracleScoreTotal).auditLabel;
      return `${e.outcome} ${e.ticker ?? e.ca.slice(0, 8)} | Scan: ${fmtUsdCompact(e.scanMc)} -> Peak: ${fmtUsdCompact(e.peakMc)} (${mult}) | ${classLabel}`;
    })
    : ['No resolved entries yet.'];

  const pendingLines = pendingSnapshot.length
    ? pendingSnapshot.map(e => {
      const classLabel = resolveTraderClass(e.oracleScoreClass || e.verdict, e.oracleScoreTotal).auditLabel;
      return `PENDING ${e.ticker ?? e.ca.slice(0, 8)} | Scan: ${fmtUsdCompact(e.scanMc)} -> Current/Peak: ${fmtUsdCompact(e.current)}/${fmtUsdCompact(e.peak)} (${e.multiple > 0 ? e.multiple.toFixed(1) : '0.0'}x) | age: ${formatAge(Date.now() - (e.scanTime || Date.now()))} | ${classLabel}`;
    })
    : ['No pending entries.'];

  return `AUDIT - Last 10 Resolved\n\n${resolvedLines.join('\n')}\n\nPENDING SNAPSHOT (Top 10 by current multiple)\n\n${pendingLines.join('\n')}\n\nPending means not old enough to finalize yet. Peaks are updated live.`;
}

function getAll() {
  loadAudit();
  return [...auditHistory, ...auditQueue].map(normalizeRecord);
}

function getUnresolved() {
  loadAudit();
  return auditQueue.filter(e => !e.resolved);
}

function getPatternMemory() {
  loadAudit();

  const winners = auditHistory
    .filter(r => (r.outcome === 'WINNER' || r.outcome === 'RUNNER') && !isRemovedWinnerImprint(r))
    .sort((a, b) => b.scanTime - a.scanTime)
    .slice(0, 8);

  const rugs = auditHistory
    .filter(r => r.outcome === 'FLAT_OR_RUG')
    .sort((a, b) => b.scanTime - a.scanTime)
    .slice(0, 8);

  const missedWinners = winners
    .filter(r => MISSED_REJECT_VERDICTS.has(r.verdict))
    .slice(0, 5);

  const missedWinners3x = [...winnerFingerprints]
    .filter(fp => fp.multiple != null && fp.multiple >= 3 && MISSED_REJECT_VERDICTS.has(fp.verdict) && !isRemovedWinnerImprint(fp))
    .sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0))
    .slice(0, 8);

  const monsterWinners10x = [...winnerFingerprints]
    .filter(fp => fp.multiple != null && fp.multiple >= 10 && !isRemovedWinnerImprint(fp))
    .sort((a, b) => (b.multiple || 0) - (a.multiple || 0))
    .slice(0, 8);

  const blueprintWinners = [...winnerFingerprints]
    .filter(fp => !isRemovedWinnerImprint(fp) &&
      fp.multiple != null &&
      fp.multiple >= 3 &&
      Array.isArray(fp.blueprintMatches) &&
      fp.blueprintMatches.length > 0)
    .sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0))
    .slice(0, 12);

  const recentFailedAlerts = [...failedFingerprints]
    .sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0))
    .slice(0, 10);

  const failedWarnings = recentFailedAlerts
    .filter(fp => fp.outcome === 'FLAT_OR_RUG')
    .slice(0, 6);

  if (
    winners.length === 0 &&
    rugs.length === 0 &&
    missedWinners.length === 0 &&
    missedWinners3x.length === 0 &&
    blueprintWinners.length === 0 &&
    monsterWinners10x.length === 0 &&
    recentFailedAlerts.length === 0
  ) return null;

  return {
    winners,
    rugs,
    missedWinners,
    missedWinners3x,
    blueprintWinners,
    monsterWinners10x,
    recentFailedAlerts,
    winnerFingerprints: [...winnerFingerprints].filter(fp => !isRemovedWinnerImprint(fp)).slice(-50),
    failedFingerprints: [...failedFingerprints].slice(-50),
    failedWarnings,
  };
}

function updatePeaks(mcMap) {
  loadAudit();
  for (const entry of auditQueue) {
    const mc = mcMap?.[entry.ca];
    if (mc != null && (entry.peakMc == null || mc > entry.peakMc)) entry.peakMc = mc;
    entry.lastChecked = Date.now();
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
    if (entry.trueAthMc == null || currentMc > entry.trueAthMc) entry.trueAthMc = currentMc;
    entry.multipleFromFirstSeen = entry.firstSeenMc > 0 && entry.peakMc > 0 ? entry.peakMc / entry.firstSeenMc : null;
    entry.multipleFromAlert = entry.alertMc > 0 && entry.peakMc > 0 ? entry.peakMc / entry.alertMc : null;
    if (Date.now() - entry.scanTime >= RESOLVE_MS) {
      entry.resolved = true;
      entry.outcome = classify(entry);
      resolved++;
      const resolvedEntry = { ...entry };
      auditHistory.push(resolvedEntry);
      pushFingerprint(resolvedEntry);
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
  const shown = pending.length <= 25 ? pending : pending.slice(0, 25);
  const lines = shown.map((e, idx) => {
    const current = e.currentMc ?? e.peakMc ?? e.scanMc ?? 0;
    const peak = e.peakMc ?? current;
    const mult = e.scanMc > 0 && peak > 0 ? (peak / e.scanMc).toFixed(2) : 'N/A';
    const classLabel = resolveTraderClass(e.oracleScoreClass || e.verdict, e.oracleScoreTotal).auditLabel;
    return `${idx + 1}. ${e.ticker || e.ca.slice(0, 8)} | Scan ${fmtUsdCompact(e.scanMc)} | Current/Peak ${fmtUsdCompact(current)}/${fmtUsdCompact(peak)} | ${mult}x | age ${formatAge(now - (e.scanTime || now))} | ${classLabel}`;
  });
  const suffix = pending.length > shown.length ? `\n\nShowing first ${shown.length} of ${pending.length} pending entries.` : '';
  return lines.join('\n') + suffix;
}

function matchLearnedPattern(result) {
  const memory = getPatternMemory();
  if (!memory?.winnerFingerprints?.length && !memory?.missedWinners3x?.length && !memory?.blueprintWinners?.length) {
    return { matched: false, strong: false, action: null, type: null, confidence: 0, reason: 'No winner-fingerprint history yet.' };
  }

  const s = result?.signals || {};
  const candidate = {
    mc: Number(s.marketCap || 0),
    top10: Number(s.top10Pct || 0),
    wash: Number(s.washPct || 0),
    vol: Number(s.adjustedVolLiq || 0),
    bundle: Number(s.bundleCount || 0),
    sybil: !!s.sybilFunded,
    lp: Number(s.lp || 0),
  };

  const catastrophic = [];
  if (candidate.sybil) catastrophic.push('confirmed_sybil');
  if (candidate.wash > 50) catastrophic.push('wash_over_50');
  if (!(candidate.mc > 0)) catastrophic.push('malformed_or_missing_market_cap');
  if (!(candidate.lp > 0 || candidate.mc > 0)) catastrophic.push('liquidity_malformed');

  if (catastrophic.length) {
    return {
      matched: false,
      strong: false,
      action: null,
      type: null,
      confidence: 0,
      reason: `Blocked by catastrophic risk: ${catastrophic.join(', ')}`,
      catastrophic,
    };
  }

  const reasons = [];
  let score = 0;

  const controlledConcentration = candidate.mc > 0 &&
    candidate.mc <= 150_000 &&
    candidate.top10 >= 30 &&
    candidate.top10 <= 50 &&
    candidate.vol >= 5 &&
    (candidate.wash <= 25 || candidate.wash === 0);
  if (controlledConcentration) {
    score += 2;
    reasons.push('controlled-concentration winner family');
  }

  const bundleExpansion = candidate.bundle >= 6 &&
    candidate.bundle <= 10 &&
    candidate.vol >= 8 &&
    candidate.wash < 15 &&
    candidate.top10 <= 45 &&
    !candidate.sybil;
  if (bundleExpansion) {
    score += 2;
    reasons.push('bundle-blocked expansion winner family');
  }

  const earlyExpansion = candidate.mc >= 10_000 &&
    candidate.mc <= 30_000 &&
    candidate.vol >= 4 &&
    candidate.wash < 25 &&
    !candidate.sybil;
  if (earlyExpansion) {
    score += 1.5;
    reasons.push('early expansion zone');
  }

  const narrativeStrength = Number(s.narrativeStrength || 0);
  if (narrativeStrength >= 3) {
    score += 1.25;
    reasons.push(`narrative catalyst ${s.narrativeType || 'NONE'} (${narrativeStrength}/5)`);
  }

  const fpMatches = (memory.winnerFingerprints || []).filter(fp => {
    if (isRemovedWinnerImprint(fp)) return false;
    if (!(fp.scanMc > 0) || !(fp.multiple >= 3)) return false;
    const mcNear = candidate.mc > 0 ? Math.abs(candidate.mc - fp.scanMc) / Math.max(candidate.mc, fp.scanMc) <= 0.7 : false;
    const top10Near = fp.top10Pct == null || candidate.top10 === 0 ? false : Math.abs(candidate.top10 - fp.top10Pct) <= 12;
    const volNear = fp.adjustedVolLiq == null || candidate.vol === 0 ? false : Math.abs(candidate.vol - fp.adjustedVolLiq) <= 6;
    return mcNear && (top10Near || volNear);
  });
  if (fpMatches.length) {
    score += Math.min(2, fpMatches.length * 0.5);
    reasons.push(`historical fingerprint similarity (${fpMatches.length})`);
  }

  const confidence = Math.max(0, Math.min(0.95, 0.35 + score * 0.12));
  const matched = score >= 2.5;
  const strong = score >= 4;

  return {
    matched,
    strong,
    action: matched ? 'MISSED_WINNER_MATCH' : null,
    type: matched ? 'WINNER_FAMILY_SIMILARITY' : null,
    confidence,
    reason: reasons.length ? reasons.join('; ') : 'No winner-family match.',
    reasons,
    catastrophic,
  };
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function fmtUsdCompact(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return '$0';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function getMemoryStats() {
  loadAudit();
  return {
    dataDir: DATA_DIR,
    auditFile: AUDIT_FILE,
    queueCount: auditQueue.length,
    historyCount: auditHistory.length,
    winnerFingerprintCount: winnerFingerprints.length,
    failedFingerprintCount: failedFingerprints.length,
  };
}

function findOriginalScanEntry(ca) {
  loadAudit();
  const entries = [...auditHistory, ...auditQueue]
    .filter(e => e.ca === ca)
    .sort((a, b) => (a.scanTime || 0) - (b.scanTime || 0));
  const fpEntries = [...winnerFingerprints, ...failedFingerprints]
    .filter(fp => fp.ca === ca)
    .sort((a, b) => (a.scanTime || 0) - (b.scanTime || 0));
  const sourceEntries = entries.length ? entries : fpEntries;
  if (!sourceEntries.length) return null;
  const original = sourceEntries[0];
  const highestPeak = sourceEntries.reduce((max, e) => {
    const peak = e.peakMc ?? e.currentPeakMc ?? e.currentMc ?? e.scanMc ?? e.originalScanMc ?? 0;
    return Math.max(max, peak);
  }, 0);
  return {
    ...original,
    scanMc: original.scanMc ?? original.firstSeenMc ?? original.originalScanMc ?? null,
    highestPeakMc: highestPeak || (original.peakMc ?? original.scanMc ?? original.firstSeenMc ?? original.originalScanMc ?? 0),
  };
}

function saveForcedLearnRecord(record = {}) {
  loadAudit();
  const scanMc = Number(record.originalScanMc) > 0 ? Number(record.originalScanMc) : Number(record.currentMc || 0);
  const peakMc = Number(record.currentPeakMc) > 0 ? Number(record.currentPeakMc) : Number(record.currentMc || 0);
  const multiple = scanMc > 0 && peakMc > 0 ? peakMc / scanMc : 1;
  const fingerprint = normalizeFingerprint({
    ca: record.ca,
    ticker: record.symbol || record.ticker || '???',
    symbol: record.symbol || record.ticker || '???',
    scanMc,
    peakMc,
    multiple,
    verdict: record.originalClass || 'MANUAL_LEARN',
    oracleScoreTotal: record.originalScore ?? null,
    oracleScoreClass: record.originalClass || null,
    adjustedVolLiq: record.adjustedVolLiq ?? null,
    lp: record.lp ?? null,
    top10Pct: record.top10Pct ?? null,
    top50Pct: record.top50Pct ?? null,
    holderHealthPct: record.holderHealthPct ?? null,
    bundleCount: record.bundleCount ?? null,
    washPct: record.washPct ?? null,
    ageMinutes: record.ageMinutes ?? null,
    narrativeType: record.narrativeType ?? 'NONE',
    narrativeStrength: record.narrativeStrength ?? 0,
    source: record.source ?? 'manual_learn_button',
    learnedAt: record.learnedAt ?? Date.now(),
    reason: record.reason ?? 'user_forced_learn',
    originalClass: record.originalClass ?? null,
    originalScore: record.originalScore ?? null,
    originalScanMc: scanMc,
    currentMc: record.currentMc ?? null,
    currentPeakMc: peakMc,
    multipleFromScan: multiple,
    outcome: 'WINNER',
    resolvedAt: Date.now(),
    scanTime: record.learnedAt ?? Date.now(),
  });
  winnerFingerprints.push(fingerprint);
  winnerFingerprints = winnerFingerprints.slice(-400);
  saveAudit();
  return fingerprint;
}

function getLogReport(limit = 20) {
  loadAudit();
  const lines = [...auditHistory, ...auditQueue]
    .sort((a, b) => (b.scanTime || 0) - (a.scanTime || 0))
    .slice(0, Math.max(1, limit))
    .map((e, idx) => {
      const peak = e.peakMc ?? e.currentMc ?? e.scanMc ?? 0;
      const mult = e.scanMc > 0 && peak > 0 ? `${(peak / e.scanMc).toFixed(2)}x` : 'N/A';
      const classLabel = resolveTraderClass(e.oracleScoreClass || e.verdict, e.oracleScoreTotal).auditLabel;
      return `${idx + 1}. ${e.ticker || e.ca.slice(0, 8)} | ${classLabel} | Scan ${fmtUsdCompact(e.scanMc)} -> Peak ${fmtUsdCompact(peak)} (${mult}) | age ${formatAge(Date.now() - (e.scanTime || Date.now()))}`;
    });
  return lines.length ? lines.join('\n') : 'No log entries yet.';
}

function getLogForCa(ca, limit = 10) {
  loadAudit();
  const matches = [...auditHistory, ...auditQueue]
    .filter(e => e.ca === ca)
    .sort((a, b) => (b.scanTime || 0) - (a.scanTime || 0))
    .slice(0, Math.max(1, limit));
  if (!matches.length) return `No log entries found for ${ca.slice(0, 8)}...`;
  return matches.map((e, idx) => {
    const peak = e.peakMc ?? e.currentMc ?? e.scanMc ?? 0;
    const mult = e.scanMc > 0 && peak > 0 ? `${(peak / e.scanMc).toFixed(2)}x` : 'N/A';
    const classLabel = resolveTraderClass(e.oracleScoreClass || e.verdict, e.oracleScoreTotal).auditLabel;
    return `${idx + 1}. ${new Date(e.scanTime || Date.now()).toISOString()} | ${classLabel} | Scan ${fmtUsdCompact(e.scanMc)} -> Peak ${fmtUsdCompact(peak)} (${mult})`;
  }).join('\n');
}

module.exports = {
  DATA_DIR,
  AUDIT_FILE,
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
  getMemoryStats,
  findOriginalScanEntry,
  saveForcedLearnRecord,
  getLogReport,
  getLogForCa,
};
