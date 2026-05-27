'use strict';
// ── Oracle Audit Engine ───────────────────────────────────────────────────────
// Tracks every scan lifecycle: verdict at scan time, peak MC observed over the
// next 72 h, and final outcome classification.
// Used by: /audit command, Grok pattern memory, background peak loop.

const fs   = require('fs');
const path = require('path');

const DATA_DIR        = process.env.DATA_DIR || '/data';
const AUDIT_FILE      = path.join(DATA_DIR, 'audit.json');
const MAX_RECORDS     = 1000;
const MAX_AGE_MS      = 7  * 24 * 60 * 60 * 1000;  // 7 days
const PEAK_WINDOW_MS  = 72 *      60 * 60 * 1000;  // 72 h observation window

// ── Persistence ───────────────────────────────────────────────────────────────

function load() {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];
    return JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  } catch { return []; }
}

function save(records) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = AUDIT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records), 'utf8');
    fs.renameSync(tmp, AUDIT_FILE); // atomic write
  } catch (e) {
    console.error('[audit] save failed:', e.message);
  }
}

function prune(records) {
  const cutoff = Date.now() - MAX_AGE_MS;
  return records.filter(r => r.scannedAt > cutoff).slice(-MAX_RECORDS);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a completed scan. De-duplicates within 5 min for the same CA
 * (e.g. rapid /scan re-tries or hunt re-broadcasts of the same token).
 */
function recordScan({
  ca, symbol, verdict, mc, adjustedVolLiq, top10Pct, washPct,
  isEliteDev, successRatePct, devLaunches, source,
}) {
  if (!ca || !verdict) return;
  const records = prune(load());
  const fiveMin = 5 * 60 * 1000;
  const dupe = records.find(r => r.ca === ca && Date.now() - r.scannedAt < fiveMin);
  if (dupe) return;

  records.push({
    ca,
    symbol:         symbol         ?? '???',
    scannedAt:      Date.now(),
    scanMc:         mc             ?? null,
    verdict,
    adjustedVolLiq: adjustedVolLiq ?? null,
    top10Pct:       top10Pct       ?? null,
    washPct:        washPct        ?? null,
    isEliteDev:     isEliteDev     ?? false,
    successRatePct: successRatePct ?? null,
    devLaunches:    devLaunches    ?? null,
    source,   // 'scan' | 'hunt' | 'watchlist'
    peakMc:         null,
    peakObservedAt: null,
    // UNRESOLVED → WINNER_10X | WINNER_3X | LOSER_50 | RUG | EXPIRED
    outcome: 'UNRESOLVED',
  });
  save(records);
}

/**
 * Classify a token's outcome from its peak and current MC vs scan MC.
 * We finalise once we see a definitive peak (10x/3x winners) or a
 * definitive bottom (rug / loser). Unresolved tokens that fall outside
 * the 72 h window are marked EXPIRED on the next updatePeaks call.
 */
function classify(scanMc, peakMc) {
  if (scanMc == null || peakMc == null) return 'UNRESOLVED';
  const ratio = peakMc / scanMc;
  if (ratio >= 10) return 'WINNER_10X';
  if (ratio >= 3)  return 'WINNER_3X';
  return 'UNRESOLVED';
}

function classifyBottom(scanMc, currentMc) {
  if (scanMc == null || currentMc == null) return 'UNRESOLVED';
  const ratio = currentMc / scanMc;
  if (ratio <= 0.2) return 'RUG';
  if (ratio <= 0.5) return 'LOSER_50';
  return 'UNRESOLVED';
}

/**
 * Called by the background loop (every 60 min in index.js).
 * mcMap: { [ca]: currentMc } — only CAs that were successfully fetched.
 */
function updatePeaks(mcMap) {
  const records = prune(load());
  const now     = Date.now();
  let changed   = false;

  for (const rec of records) {
    if (rec.outcome !== 'UNRESOLVED') continue;

    // Expire records older than the 72-h observation window
    if (now - rec.scannedAt > PEAK_WINDOW_MS) {
      rec.outcome = 'EXPIRED';
      changed = true;
      continue;
    }

    const currentMc = mcMap[rec.ca] ?? null;
    if (currentMc == null) continue;

    // Update rolling peak
    if (rec.peakMc == null || currentMc > rec.peakMc) {
      rec.peakMc        = currentMc;
      rec.peakObservedAt = now;
      changed = true;
    }

    // Check for winner (based on all-time peak) or loser (based on current)
    const winOutcome = classify(rec.scanMc, rec.peakMc);
    if (winOutcome !== 'UNRESOLVED') {
      rec.outcome = winOutcome;
      changed = true;
      continue;
    }
    const loseOutcome = classifyBottom(rec.scanMc, currentMc);
    if (loseOutcome !== 'UNRESOLVED') {
      rec.outcome = loseOutcome;
      changed = true;
    }
  }

  if (changed) save(records);
}

/** All audit records (newest first after sort by caller). */
function getAll() {
  return prune(load());
}

/** Unresolved records still within the 72-h observation window. */
function getUnresolved() {
  const cutoff = Date.now() - PEAK_WINDOW_MS;
  return getAll().filter(r => r.outcome === 'UNRESOLVED' && r.scannedAt > cutoff);
}

/**
 * Returns the last 5 winners and last 5 rugs for Grok's pattern memory block.
 * Returns null when there is no resolved history yet (avoids polluting the prompt).
 */
function getPatternMemory() {
  const records  = getAll();
  const resolved = records.filter(r => r.outcome !== 'UNRESOLVED' && r.outcome !== 'EXPIRED');
  const winners  = resolved
    .filter(r => r.outcome === 'WINNER_10X' || r.outcome === 'WINNER_3X')
    .sort((a, b) => b.scannedAt - a.scannedAt).slice(0, 5);
  const rugs = resolved
    .filter(r => r.outcome === 'RUG')
    .sort((a, b) => b.scannedAt - a.scannedAt).slice(0, 5);
  if (winners.length === 0 && rugs.length === 0) return null;
  return { winners, rugs };
}

module.exports = { recordScan, updatePeaks, getAll, getUnresolved, getPatternMemory };
