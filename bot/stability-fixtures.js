'use strict';

// Local regression fixtures for v40.0 Pearl Extraction Stability Freeze.
// These are lightweight objects for manual/dev sanity checks.
const fixtures = {
  poke: {
    description: 'Hunt first-seen ~21K should surface as PEARL_WATCH/promoted early.',
    scan: { mc: 21_000, adjustedVolLiq: 3.4, rawVolLiq: 4.1, washPct: 8, top10Pct: 42, bundleCount: 7, ageMinutes: 18 },
    expected: { classOneOf: ['PEARL_WATCH', 'MISSED_WINNER_MATCH'], notHiddenUntilMcAbove: 90_000 },
  },
  zCrash: {
    description: '4K micro flow should be scout/floor style, not generic fail.',
    scan: { mc: 4_000, adjustedVolLiq: 3.1, rawVolLiq: 3.7, washPct: 9, top10Pct: 36, bundleCount: 4, ageMinutes: 12 },
    expected: { classNot: 'NO_GO', watchStyle: true },
  },
  datbihgahStyle: {
    description: '10/slot bundle + clean wash + strong flow + pro dev should not hard fail on missing DeFade.',
    scan: { mc: 28_000, adjustedVolLiq: 6.2, rawVolLiq: 7.4, washPct: 7, top10Pct: 44, bundleCount: 10, ageMinutes: 22 },
    expected: { classNot: 'NO_GO', requiredStackNotBlockedBy: ['defade_required_missing', 'codex_missing', 'birdeye_missing'] },
  },
  apm: {
    description: 'Dev-supported runner should classify controlled runner lane, not auto scam.',
    scan: { mc: 62_000, adjustedVolLiq: 7.1, rawVolLiq: 8.3, washPct: 11, top10Pct: 39, bundleCount: 6, successRatePct: 12 },
    expected: { classOneOf: ['ORACLE_BUY', 'DIRTY_RUNNER_WATCH', 'PEARL_WATCH'] },
  },
  albino: {
    description: 'Monster card cannot contradict with zero size / watch-only risk.',
    card: { class: 'ORACLE_BUY', score: 90, positionSizeSol: 0 },
    expected: { noContradiction: true },
  },
  top50Bug: {
    description: 'Top50 drop + holders/LP rising should mark decentralizing, not cluster exit.',
    guardian: { top50DropPct: 4.2, holdersDeltaPct: 1.8, lpDeltaPct: 6.5, mcDeltaPct: 4.1, top10Worsening: false, adjustedVolLiq: 3.6 },
    expected: { alertIncludes: 'TOP50_DECENTRALIZING', alertNot: 'CLUSTER_EXIT' },
  },
  codexBirdeyeMissing: {
    description: 'Paid stack missing should not hard-kill Pearl Watch.',
    stack: { codexMissing: true, birdeyeMissing: true, stMissing: true, mcValid: true, washPct: 12, sybil: false },
    expected: { pearlRequiredStackPass: true },
  },
};

module.exports = { fixtures };
