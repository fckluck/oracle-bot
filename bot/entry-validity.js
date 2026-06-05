'use strict';

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function evaluateEntryValidity({
  firstSeenMc,
  alertMc,
  currentMc,
  peakMc,
  momentumStrength = 0,
  structureStrength = 0,
  healthIntact = true,
} = {}) {
  const first = n(firstSeenMc);
  const alert = n(alertMc) ?? first;
  const current = n(currentMc);
  const peak = n(peakMc) ?? current;
  if (!(current > 0) || !(alert > 0 || first > 0)) {
    return 'TRACK_ONLY';
  }

  const baseline = alert > 0 ? alert : first;
  const ratio = current / baseline;
  const fromFirst = first > 0 ? current / first : ratio;
  const retraceFromPeak = peak > 0 ? ((peak - current) / peak) * 100 : 0;
  const scalpEligible = (momentumStrength >= 2 && structureStrength >= 2) || (retraceFromPeak >= 20 && retraceFromPeak <= 45 && healthIntact);

  if (first > 0 && current < first && healthIntact) {
    return 'TRACK_ONLY';
  }
  if (fromFirst <= 1.5 && ratio <= 1.5) {
    return 'LIVE_ENTRY';
  }
  if (ratio > 1.5 && ratio <= 2.0) {
    return 'CHASE_RISK';
  }
  if (ratio > 2.0) {
    return scalpEligible ? 'SCALP_ONLY' : 'EXPIRED';
  }
  return 'TRACK_ONLY';
}

function entryLabel(status) {
  const key = String(status || '').toUpperCase();
  if (key === 'LIVE_ENTRY') return 'Entry: Live';
  if (key === 'CHASE_RISK') return 'Entry: Chase Risk';
  if (key === 'SCALP_ONLY') return 'Entry: Scalp Only';
  if (key === 'EXPIRED') return 'Entry: Expired / Track Only';
  return 'Entry: Track Only';
}

module.exports = {
  evaluateEntryValidity,
  entryLabel,
};
