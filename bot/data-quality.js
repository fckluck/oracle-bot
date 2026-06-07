'use strict';

function isValidPct(v) {
  return Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100;
}

function hasOptionalSourceGap(dataUsed = {}) {
  const optionalSources = ['pump', 'birdeye', 'codex', 'helius'];
  return optionalSources.some((k) => {
    const status = String(dataUsed?.[k]?.status || '').toLowerCase();
    return status === 'failed' || status === 'skipped';
  });
}

function getDataQualityIcon(label) {
  if (label === 'FULL') return '🟢';
  if (label === 'PARTIAL') return '🟡';
  if (label === 'MC_UNCERTAIN') return '🟠';
  if (label === 'INVALID') return '🔴';
  return '⚪';
}

function getDataQualityText(label) {
  if (label === 'MC_UNCERTAIN') return 'MC UNCERTAIN';
  return label || 'UNKNOWN';
}

function computeDataQuality(result = {}, context = {}) {
  const signals = result?.signals || {};
  const dataUsed = context?.dataUsed || result?.dataUsed || {};
  const pumpStatus = context?.pumpStatus || {};
  const invalidReasons = [];

  const mc = Number(signals.marketCap || 0);
  if (!(mc > 0)) invalidReasons.push('missing_market_cap');

  const lp = Number(signals.lp);
  if (Number.isFinite(lp) && lp < 0) invalidReasons.push('negative_lp');

  const top10 = signals.top10Pct;
  const top50 = signals.top50Pct;
  if (top10 != null && !isValidPct(top10)) invalidReasons.push('invalid_top10');
  if (top50 != null && !isValidPct(top50)) invalidReasons.push('invalid_top50');
  if (signals.holderMathInvalid) invalidReasons.push('invalid_holder_math');

  if (invalidReasons.length) {
    return {
      dataQuality: 'INVALID',
      learningEligible: false,
      reasons: invalidReasons,
      badge: `${getDataQualityIcon('INVALID')} ${getDataQualityText('INVALID')}`,
    };
  }

  const mcDisagreementPct = Number(signals.mcDisagreementPct ?? context?.mcDisagreementPct ?? 0);
  const mcUncertain = !!signals.mcUncertain || !!context?.mcUncertain || mcDisagreementPct >= 25;
  if (mcUncertain) {
    return {
      dataQuality: 'MC_UNCERTAIN',
      learningEligible: false,
      reasons: ['mc_source_disagreement'],
      badge: `${getDataQualityIcon('MC_UNCERTAIN')} ${getDataQualityText('MC_UNCERTAIN')}`,
    };
  }

  const holderStatus = String(signals.holderStatus || context?.holderStatus || 'UNAVAILABLE').toUpperCase();
  const holderPartial = holderStatus === 'PARTIAL' || holderStatus === 'UNAVAILABLE';
  const pump530 = Number(pumpStatus?.httpStatus || 0) === 530;
  const optionalGap = hasOptionalSourceGap(dataUsed);

  if (holderPartial || pump530 || optionalGap) {
    const reasons = [];
    if (holderPartial) reasons.push(`holder_${holderStatus.toLowerCase()}`);
    if (pump530) reasons.push('pumpfun_http_530');
    if (optionalGap) reasons.push('optional_source_gap');
    return {
      dataQuality: 'PARTIAL',
      learningEligible: false,
      reasons,
      badge: `${getDataQualityIcon('PARTIAL')} ${getDataQualityText('PARTIAL')}`,
    };
  }

  return {
    dataQuality: 'FULL',
    learningEligible: true,
    reasons: [],
    badge: `${getDataQualityIcon('FULL')} ${getDataQualityText('FULL')}`,
  };
}

module.exports = {
  computeDataQuality,
  getDataQualityIcon,
  getDataQualityText,
};
