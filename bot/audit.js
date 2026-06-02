'use strict';
// Oracle Audit Engine v37.0
// Batch-updates actionable scans from /data/audit.json. Queue is capped to avoid
// the unbounded drain problem from earlier designs.

const fs   = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR      = process.env.DATA_DIR || '/data';
const AUDIT_FILE    = path.join(DATA_DIR, 'audit.json');
const MAX_ENTRIES   = 50;
const HISTORY_LIMIT = 200;
const BATCH_SIZE    = 5;
const CYCLE_MS      = 30_000;
const RESOLVE_MS    = 6 * 60 * 60 * 1000;

let auditQueue = [];
let auditHistory = [];
let updateTimer = null;

function normalizeRecord(rec) {
  const outcome = rec.outcome ?? 'UNRESOLVED';

  return {
    ca: rec.ca,
    ticker: rec.ticker ?? rec.symbol ?? '???',
    symbol: rec.symbol ?? rec.ticker ?? '???',
    verdict: rec.verdict,
    entryTier: rec.entryTier ?? null,
    scanMc: rec.scanMc ?? rec.mc ?? null,
    peakMc: rec.peakMc ?? rec.scanMc ?? rec.mc ?? null,
    scannedAt: rec.scannedAt ?? rec.scanTime ?? Date.now(),
    scanTime: rec.scanTime ?? rec.scannedAt ?? Date.now(),
    lastChecked: rec.lastChecked ?? 0,
    adjustedVolLiq: rec.adjustedVolLiq ?? null,
    top10Pct: rec.top10Pct ?? null,
    washPct: rec.washPct ?? null,
    isEliteDev: rec.isEliteDev ?? false,
    successRatePct: rec.successRatePct ?? null,
    devLaunches: rec.devLaunches ?? null,
    source: rec.source ?? null,

    // v37.1 fix:
    // If legacy records lack outcome, treat them as unresolved instead of resolved.
    resolved: rec.resolved ?? outcome !== 'UNRESOLVED',
    outcome,
  };
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

  // v37.1:
  // Record ALL scanner outcomes, including SKIP / NO_GO / AVOID.
  // The whole point of Audit Memory is learning from hard misses.
  // We still only alert later when a rejected/downgraded token proves itself by running.
  loadAudit();

  const now = Date.now();
  const dupeWindowMs = 5 * 60 * 1000;
  if (auditQueue.some(e => e.ca === ca && now - e.scanTime < dupeWindowMs)) return;

  if (auditQueue.length >= MAX_ENTRIES) auditQueue.shift();
  auditQueue.push(normalizeRecord({
    ca,
    ticker,
    symbol: ticker,
    verdict,
    entryTier,
    scanMc: scanMc ?? null,
    peakMc: scanMc ?? null,
    scannedAt: now,
    scanTime: now,
    lastChecked: 0,
    adjustedVolLiq: extra.adjustedVolLiq,
    top10Pct: extra.top10Pct,
    washPct: extra.washPct,
    isEliteDev: extra.isEliteDev,
    successRatePct: extra.successRatePct,
    devLaunches: extra.devLaunches,
    source: extra.source,
    resolved: false,
    outcome: 'UNRESOLVED',
  }));
  saveAudit();
}

function recordScan({
  ca, symbol, verdict, entryTier, mc, adjustedVolLiq, top10Pct, washPct,
  isEliteDev, successRatePct, devLaunches, source,
}) {
  addToAudit(ca, symbol, verdict, entryTier, mc, {
    adjustedVolLiq, top10Pct, washPct, isEliteDev, successRatePct, devLaunches, source,
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
      if (entry.peakMc == null || currentMc > entry.peakMc) entry.peakMc = currentMc;

      if (Date.now() - entry.scanTime >= RESOLVE_MS) {
        entry.resolved = true;
        entry.outcome = classify(entry);
        const multiplier = entry.scanMc > 0 ? entry.peakMc / entry.scanMc : null;
        const wasMissedOrDowngraded = [
          'SKIP',
          'NO_GO',
          'AVOID',
          'WATCH_VOL',
          'WATCH_WASH',
          'RISKY_RUNNER',
        ].includes(entry.verdict);

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
  console.log(`[audit] v37 loop started - ${BATCH_SIZE} CA(s) every ${CYCLE_MS / 1000}s, queue cap ${MAX_ENTRIES}`);
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
    return `${e.outcome} ${e.ticker ?? e.ca.slice(0, 8)} | Scan: $${(e.scanMc / 1000).toFixed(1)}K -> Peak: $${(e.peakMc / 1000).toFixed(1)}K (${mult}) | ${e.verdict}`;
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

function getPatternMemory() {
  loadAudit();

  const winners = auditHistory
    .filter(r => r.outcome === 'WINNER' || r.outcome === 'RUNNER')
    .sort((a, b) => b.scanTime - a.scanTime)
    .slice(0, 8);

  const rugs = auditHistory
    .filter(r => r.outcome === 'FLAT_OR_RUG')
    .sort((a, b) => b.scanTime - a.scanTime)
    .slice(0, 8);

  const missedWinners = winners
    .filter(r => ['SKIP', 'NO_GO', 'AVOID', 'WATCH_VOL', 'WATCH_WASH', 'RISKY_RUNNER', 'DIRTY_RUNNER_WATCH'].includes(r.verdict))
    .slice(0, 5);

  if (winners.length === 0 && rugs.length === 0 && missedWinners.length === 0) return null;

  return { winners, rugs, missedWinners };
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
    if (Date.now() - entry.scanTime >= RESOLVE_MS) {
      entry.resolved = true;
      entry.outcome = classify(entry);
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
    return `${idx + 1}. ${e.ticker} | ${e.verdict} | scan:$${Math.round((e.scanMc || 0) / 1000)}K | current:$${Math.round((current || 0) / 1000)}K | peak:$${Math.round((peak || 0) / 1000)}K | multiple:${mult}x | age:${ageMin}m | resolve:${resolveIn}m | learned:${e.missedType || 'none'}`;
  }).join('\n');
}

function matchLearnedPattern(result) {
  const memory = getPatternMemory();
  if (!memory?.missedWinners?.length) {
    return { matched: false, action: null, type: null, confidence: 0, reason: 'No learned runner patterns yet.' };
  }
  const s = result?.signals || {};
  const candidate = {
    mc: Number(s.marketCap || 0),
    top10: Number(s.top10Pct || 0),
    wash: Number(s.washPct || 0),
    vol: Number(s.adjustedVolLiq || 0),
  };
  const confidence = candidate.mc > 0 && candidate.mc < 100000 && candidate.vol >= 5 && candidate.wash <= 35 && candidate.top10 >= 20
    ? 0.74
    : 0.55;
  return {
    matched: confidence >= (config.DIRTY_RUNNER_MIN_CONFIDENCE || 0.7),
    action: 'DIRTY_RUNNER_WATCH',
    type: 'CONCENTRATION_RUNNER',
    confidence,
    reason: 'Matches prior missed 3x+ concentration runners: sub-$100K, organic vol, elevated top10, low wash.',
  };
}

module.exports = {
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
