'use strict';

const BLUEPRINT_ACTIONS = Object.freeze({
  NONE: 'NONE',
  BLOCK: 'BLOCK',
  LOTTO_WATCH: 'LOTTO_WATCH',
  BLUEPRINT_HOT_WATCH: 'BLUEPRINT_HOT_WATCH',
  BLUEPRINT_SCOUT: 'BLUEPRINT_SCOUT',
  EXTREME_CONCENTRATION_SCOUT: 'EXTREME_CONCENTRATION_SCOUT',
  HIGH_VOL_LOW_LP_SCOUT: 'HIGH_VOL_LOW_LP_SCOUT',
});

const NAMED_BLUEPRINTS = Object.freeze({
  EARLY_EXPANSION_NANO_CAP: 'EARLY_EXPANSION_NANO_CAP',
  CONTROLLED_CONCENTRATION_WINNER: 'CONTROLLED_CONCENTRATION_WINNER',
  BUNDLE_BLOCKED_EXPANSION: 'BUNDLE_BLOCKED_EXPANSION',
  HIGH_VOL_DATA_PLAY: 'HIGH_VOL_DATA_PLAY',
  DEV_PEAK_BUFFER: 'DEV_PEAK_BUFFER',
  EXTREME_CONCENTRATION_EXCEPTION: 'EXTREME_CONCENTRATION_EXCEPTION',
  HIGH_VOL_LOW_LP_EXCEPTION: 'HIGH_VOL_LOW_LP_EXCEPTION',
  LOW_VOL_MOMENTUM_LOTTO: 'LOW_VOL_MOMENTUM_LOTTO',
});

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = finiteNumber(value);
    if (n !== null) return n;
  }
  return null;
}

function washOk(wash, max) {
  return wash == null || wash <= max;
}

function pctInRange(value, min, max) {
  return value != null && value >= min && value <= max;
}

function bool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalize(result = {}, context = {}) {
  const signals = result.signals || result;
  const social = context.social || result.social || {};
  const devProfile = result.devProfile || {};
  const holderHealthRaw = firstNumber(
    signals.holderHealthPct,
    signals.holderHealth?.healthPct,
    signals.holderHealth,
    result.holderHealthPct
  );

  return {
    marketCap: firstNumber(signals.marketCap, signals.mc, result.marketCap, result.mc),
    lp: firstNumber(signals.lp, signals.liquidity, result.lp),
    ageMinutes: firstNumber(signals.ageMinutes, signals.ageMins, result.ageMinutes),
    volume1h: firstNumber(signals.volume1h, result.volume1h),
    rawVolLiq: firstNumber(signals.rawVolLiq, result.rawVolLiq),
    adjustedVolLiq: firstNumber(signals.adjustedVolLiq, signals.volLiq, result.adjustedVolLiq),
    washPct: firstNumber(signals.washPct, result.washPct),
    top10Pct: firstNumber(signals.top10Pct, result.top10Pct),
    top50Pct: firstNumber(signals.top50Pct, result.top50Pct),
    holderCount: firstNumber(signals.holderCount, result.holderCount),
    holderHealthPct: holderHealthRaw,
    bundleCount: firstNumber(signals.bundleCount, signals.maxInSlot, result.bundleCount) ?? 0,
    sybilFunded: bool(signals.sybilFunded) || bool(result.sybilFunded),
    change1h: firstNumber(signals.change1h, signals.priceChange1h, result.change1h, result.priceChange1h),
    successRatePct: firstNumber(signals.successRatePct, result.successRatePct),
    peakMultiplier: firstNumber(
      signals.peakMultiplier,
      signals.priorPeakMultiplier,
      result.peakMultiplier,
      devProfile.topPerformerMultiplier
    ),
    narrativeType: signals.narrativeType || result.narrativeType || 'NONE',
    narrativeStrength: firstNumber(signals.narrativeStrength, result.narrativeStrength) ?? 0,
    momentumStatus: signals.momentumStatus || result.momentumStatus || null,
    socialMentions: firstNumber(social.mentions15m, social.mentions, result.socialMentions15m) ?? 0,
    uniqueAccounts: firstNumber(social.uniqueAccounts, result.uniqueAccounts) ?? 0,
    devActive: result.ctoBehavior === 'DEV_ACTIVE' ||
      devProfile.ctoBehavior === 'DEV_ACTIVE' ||
      bool(signals.devActive),
    serialDeployer: bool(signals.isSerialDeployer) || bool(result.isSerialDeployer),
    noGoReason: result.noGoReason || '',
    watchReason: result.watchReason || '',
    headlineType: result.headlineType || '',
  };
}

function detectHardBlocks(s) {
  const hardBlocks = [];
  const reasonText = `${s.noGoReason} ${s.watchReason} ${s.headlineType}`.toLowerCase();

  if (s.sybilFunded) hardBlocks.push('confirmed_sybil');
  if (s.washPct != null && s.washPct > 50) hardBlocks.push('wash_over_50');
  if (!(s.marketCap > 0)) hardBlocks.push('malformed_or_missing_market_cap');
  if (s.lp == null || s.lp < 0) hardBlocks.push('liquidity_malformed');
  if (s.top10Pct != null && s.top10Pct > 58) hardBlocks.push('top10_death_zone');
  if (/lp\s*(drain|dropped|removed)|liquidity\s*(drain|pulled|removed)/i.test(reasonText)) {
    hardBlocks.push('lp_drain');
  }
  if (/holder\s*(collapse|drop|dropped)|holders\s*(collapse|drop|dropped)/i.test(reasonText)) {
    hardBlocks.push('holder_collapse');
  }

  return [...new Set(hardBlocks)];
}

function collectRisks(s) {
  const risks = [];
  if (s.bundleCount >= 8 && s.bundleCount <= 10) risks.push('bundle_8_10');
  if (pctInRange(s.top10Pct, 40, 45)) risks.push('top10_40_45');
  if (s.holderHealthPct != null && s.holderHealthPct >= 260 && s.holderHealthPct <= 350) {
    risks.push('holder_health_260_350');
  }
  if (s.holderHealthPct != null && s.holderHealthPct > 350) risks.push('holder_health_over_350');
  if (s.lp != null && s.lp >= 10_000 && s.lp <= 15_000) risks.push('lp_10k_15k');
  if (s.lp != null && s.lp > 0 && s.lp < 10_000) risks.push('lp_under_10k');
  if (s.devActive) risks.push('dev_active');
  if (s.serialDeployer) risks.push('serial_deployer');
  return risks;
}

function confidenceFor(matchCount, riskCount) {
  const base = matchCount >= 4 ? 0.86
    : matchCount === 3 ? 0.78
    : matchCount === 2 ? 0.70
    : matchCount === 1 ? 0.62
    : 0.45;
  const penalized = base - Math.min(0.12, riskCount * 0.015);
  return Math.max(0.45, Math.min(0.92, Number(penalized.toFixed(2))));
}

function evaluateWinnerBlueprint(result = {}, context = {}) {
  const s = normalize(result, context);
  const hardBlocks = detectHardBlocks(s);
  const risks = collectRisks(s);

  if (hardBlocks.length) {
    return {
      matched: false,
      action: BLUEPRINT_ACTIONS.BLOCK,
      alertClass: null,
      confidence: 0,
      matches: [],
      risks,
      hardBlocks,
      reason: `Blocked by ${hardBlocks.join(', ')}`,
    };
  }

  const matches = [];
  const vol = s.adjustedVolLiq ?? 0;
  const wash = s.washPct;
  const mc = s.marketCap ?? 0;
  const lp = s.lp ?? 0;
  const top10 = s.top10Pct;
  const bundle = s.bundleCount ?? 0;
  const socialOk = s.socialMentions >= 10 || s.uniqueAccounts >= 8;
  const hasAge = s.ageMinutes != null;
  const ageOk = !hasAge || s.ageMinutes <= 90;

  if (mc >= 9_000 && mc <= 30_000 && vol >= 4.25 && washOk(wash, 25) && ageOk) {
    matches.push(NAMED_BLUEPRINTS.EARLY_EXPANSION_NANO_CAP);
  }
  if (mc >= 40_000 && mc <= 90_000 && vol >= 5 && pctInRange(top10, 31, 40) && washOk(wash, 25)) {
    matches.push(NAMED_BLUEPRINTS.CONTROLLED_CONCENTRATION_WINNER);
  }
  if (vol >= 8 && bundle >= 5 && bundle <= 10 && washOk(wash, 10) && (top10 == null || top10 <= 40)) {
    matches.push(NAMED_BLUEPRINTS.BUNDLE_BLOCKED_EXPANSION);
  }
  if (vol >= 12 && mc <= 100_000 && washOk(wash, 10)) {
    matches.push(NAMED_BLUEPRINTS.HIGH_VOL_DATA_PLAY);
  }
  if (((s.successRatePct != null && s.successRatePct >= 8) || (s.peakMultiplier != null && s.peakMultiplier >= 10)) &&
      mc <= 100_000 && vol >= 5 && washOk(wash, 25)) {
    matches.push(NAMED_BLUEPRINTS.DEV_PEAK_BUFFER);
  }

  const extremeConcentration = pctInRange(top10, 45, 58) &&
    vol >= 7 &&
    washOk(wash, 5) &&
    bundle <= 4 &&
    (s.holderHealthPct == null || s.holderHealthPct <= 220) &&
    socialOk;
  if (extremeConcentration) matches.push(NAMED_BLUEPRINTS.EXTREME_CONCENTRATION_EXCEPTION);

  const highVolLowLp = lp >= 10_000 && lp <= 15_000 &&
    mc <= 30_000 &&
    vol >= 15 &&
    washOk(wash, 5) &&
    socialOk;
  if (highVolLowLp) matches.push(NAMED_BLUEPRINTS.HIGH_VOL_LOW_LP_EXCEPTION);

  const lotto = vol >= 1.5 && vol < 4.25 &&
    mc >= 9_000 && mc <= 30_000 &&
    washOk(wash, 5) &&
    (s.change1h ?? 0) >= 500;
  if (lotto) matches.push(NAMED_BLUEPRINTS.LOW_VOL_MOMENTUM_LOTTO);

  const mainMatches = matches.filter(m => ![
    NAMED_BLUEPRINTS.DEV_PEAK_BUFFER,
    NAMED_BLUEPRINTS.LOW_VOL_MOMENTUM_LOTTO,
  ].includes(m));
  const nonLottoMatches = matches.filter(m => m !== NAMED_BLUEPRINTS.LOW_VOL_MOMENTUM_LOTTO);
  const confidence = confidenceFor(nonLottoMatches.length || (lotto ? 1 : 0), risks.length);

  if (lotto && nonLottoMatches.length === 0) {
    return {
      matched: true,
      action: BLUEPRINT_ACTIONS.LOTTO_WATCH,
      alertClass: null,
      confidence,
      matches,
      risks,
      hardBlocks,
      reason: 'Low-vol momentum lotto only; audit/watchlist lane, not Hunt broadcast.',
    };
  }

  if (extremeConcentration) {
    return {
      matched: true,
      action: BLUEPRINT_ACTIONS.EXTREME_CONCENTRATION_SCOUT,
      alertClass: 'DIRTY_RUNNER_WATCH',
      confidence,
      matches,
      risks,
      hardBlocks,
      forceTrack: true,
      reason: 'Strict extreme concentration scout: high demand, clean wash, small bundle, social confirmation.',
    };
  }

  if (highVolLowLp) {
    return {
      matched: true,
      action: BLUEPRINT_ACTIONS.HIGH_VOL_LOW_LP_SCOUT,
      alertClass: 'DIRTY_RUNNER_WATCH',
      confidence,
      matches,
      risks,
      hardBlocks,
      forceTrack: true,
      reason: 'High-vol low-LP exception: scout only with Guardian tracking.',
    };
  }

  if (mainMatches.length === 0) {
    return {
      matched: false,
      action: BLUEPRINT_ACTIONS.NONE,
      alertClass: null,
      confidence: 0,
      matches,
      risks,
      hardBlocks,
      reason: matches.includes(NAMED_BLUEPRINTS.DEV_PEAK_BUFFER)
        ? 'Dev peak buffer present, but no organic-demand blueprint matched.'
        : 'No controlled-dirty organic-demand blueprint matched.',
    };
  }

  const heavyRisk = risks.length >= 2 ||
    (s.holderHealthPct != null && s.holderHealthPct > 350 && !matches.includes(NAMED_BLUEPRINTS.HIGH_VOL_DATA_PLAY));
  const action = heavyRisk ? BLUEPRINT_ACTIONS.BLUEPRINT_HOT_WATCH : BLUEPRINT_ACTIONS.BLUEPRINT_SCOUT;

  return {
    matched: true,
    action,
    alertClass: 'DIRTY_RUNNER_WATCH',
    confidence,
    matches,
    risks,
    hardBlocks,
    forceTrack: action === BLUEPRINT_ACTIONS.BLUEPRINT_SCOUT || action === BLUEPRINT_ACTIONS.BLUEPRINT_HOT_WATCH,
    reason: `${action}: ${matches.join(', ')}${risks.length ? `; risks ${risks.join(', ')}` : ''}`,
  };
}

module.exports = {
  evaluateWinnerBlueprint,
  BLUEPRINT_ACTIONS,
  NAMED_BLUEPRINTS,
};
