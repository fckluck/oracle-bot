'use strict';
// Oracle Audit Engine v37.0
// Batch-updates actionable scans from /data/audit.json. Queue is capped to avoid
// the unbounded drain problem from earlier designs.

const fs   = require('fs');
const path = require('path');

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
    resolved: rec.resolved ?? rec.outcome !== 'UNRESOLVED',
    outcome: rec.outcome ?? 'UNRESOLVED',
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
  if (['SKIP', 'NO_GO', 'AVOID'].includes(verdict)) return;
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
        const wasDowngraded = ['WATCH_VOL', 'RISKY_RUNNER'].includes(entry.verdict);
        if (wasDowngraded && multiplier != null && multiplier >= 3 && bot && process.env.OWNER_TELEGRAM_ID) {
          const label = entry.ticker ?? entry.ca.slice(0, 8);
          const msg = `AUDIT ALERT: Missed ${label} - ${multiplier.toFixed(1)}x from scan (${entry.verdict}). `
            + `Scan MC: $${(entry.scanMc / 1000).toFixed(1)}K -> Peak: $${(entry.peakMc / 1000).toFixed(1)}K.`;
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
    .slice(0, 5);
  const rugs = auditHistory
    .filter(r => r.outcome === 'FLAT_OR_RUG')
    .sort((a, b) => b.scanTime - a.scanTime)
    .slice(0, 5);
  if (winners.length === 0 && rugs.length === 0) return null;
  return { winners, rugs };
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
};
