'use strict';

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pushTrait(list, condition, label) {
  if (condition) list.push(label);
}

function evaluatePearlWatch(result = {}, data = {}) {
  const signals = result.signals || {};
  const oracleScore = result.oracleScore || {};
  const hardBlocks = Array.isArray(oracleScore.hardBlocks) ? oracleScore.hardBlocks : [];

  const mc = num(signals.marketCap, 0);
  const adjustedVolLiq = num(signals.adjustedVolLiq, 0);
  const rawVolLiq = num(signals.rawVolLiq, 0);
  const washPct = num(signals.washPct, null);
  const top10Pct = num(signals.top10Pct, null);
  const top50Pct = num(signals.top50Pct, null);
  const bundleCount = num(signals.bundleCount, 0);
  const ageMinutes = num(signals.ageMinutes, null);
  const buyCount = num(signals.buyCount, 0);
  const sellCount = num(signals.sellCount, 0);
  const change1h = num(signals.change1h, 0);
  const holderCount = num(signals.holderCount, null);
  const holderHealthPct = num(signals.holderHealth?.healthPct, null);
  const devPeak = num(signals.peakMultiplier, null);
  const devSuccess = num(signals.successRatePct, null);
  const volAccel = num(signals.birdeye?.volAccel, null);
  const socialMentions = num(result.social?.mentions15m, 0);
  const narrativeStrength = num(signals.narrativeStrength, 0);
  const sybil = !!signals.sybilFunded;

  const severeConcentration = top10Pct != null && top10Pct > 55 && (
    (washPct != null && washPct > 20) ||
    bundleCount > 10 ||
    (holderHealthPct != null && holderHealthPct > 300)
  );
  const hardRuggerWeakFlow = !!signals.isSerialDeployer && adjustedVolLiq < 3;

  const catastrophic = [];
  if (sybil) catastrophic.push('confirmed_sybil');
  if (washPct != null && washPct > 50) catastrophic.push('wash_over_50');
  if (!(mc > 0)) catastrophic.push('malformed_or_missing_market_cap');
  if (hardBlocks.includes('liquidity_malformed')) catastrophic.push('liquidity_malformed');
  if (hardBlocks.includes('defade_hard_skip')) catastrophic.push('defade_hard_skip');
  if (severeConcentration) catastrophic.push('severe_concentration_supporting_danger');
  if (hardRuggerWeakFlow) catastrophic.push('hard_rugger_profile_weak_flow');
  for (const hb of hardBlocks) {
    if (['confirmed_sybil', 'wash_over_50', 'malformed_or_missing_market_cap', 'liquidity_malformed', 'defade_hard_skip'].includes(hb)) {
      catastrophic.push(hb);
    }
  }

  const uniqueCatastrophic = [...new Set(catastrophic)];
  if (uniqueCatastrophic.length) {
    return {
      matched: false,
      confidence: 0,
      traits: [],
      reason: `Blocked by catastrophic risk: ${uniqueCatastrophic.join(', ')}`,
      action: 'TRACK_CHART_TINY_SCOUT_ONLY',
    };
  }

  const strongEvidence = (
    socialMentions >= 10 ||
    narrativeStrength >= 3 ||
    (holderHealthPct != null && holderHealthPct >= 60) ||
    (devPeak != null && devPeak >= 10) ||
    (devSuccess != null && devSuccess >= 8)
  );
  const inMcRange = (mc >= 9_000 && mc <= 35_000) || (mc > 35_000 && mc <= 45_000 && strongEvidence);
  const gateWash = washPct == null || washPct <= 20;
  const gateTop10 = top10Pct == null || top10Pct <= 55;
  const gateBundle = bundleCount <= 12 || !sybil;

  const traits = [];
  const demandTraits = [];
  const structureTraits = [];

  const demandVol = adjustedVolLiq >= 2.5;
  const demandRawVol = rawVolLiq >= 3;
  const demandBuyPressure = buyCount > sellCount && buyCount > 0;
  const demandExpansion = change1h >= 25;
  const demandRisingFlow = volAccel != null && volAccel >= 0.10;
  const demandMcExpansion = num(data.firstSeenMc, null) != null && mc > Number(data.firstSeenMc || 0);

  pushTrait(traits, demandVol, 'Adjusted Vol/Liq >= 2.5x');
  pushTrait(traits, demandRawVol, 'Raw Vol/Liq >= 3x');
  pushTrait(traits, demandBuyPressure, 'Buy pressure > sell pressure');
  pushTrait(traits, demandExpansion, '1H expansion positive');
  pushTrait(traits, demandRisingFlow, 'Volume acceleration rising');
  pushTrait(traits, demandMcExpansion, 'MC expanding from first seen');
  pushTrait(demandTraits, demandVol, 'demand_vol');
  pushTrait(demandTraits, demandRawVol, 'demand_raw_vol');
  pushTrait(demandTraits, demandBuyPressure, 'demand_buy_pressure');
  pushTrait(demandTraits, demandExpansion, 'demand_1h_expansion');
  pushTrait(demandTraits, demandMcExpansion, 'demand_mc_expansion');

  const structEarly = ageMinutes != null && ageMinutes <= 30;
  const structWash = washPct == null || washPct <= 10 || washPct <= 20;
  const structTop10 = top10Pct == null || top10Pct <= 45;
  const structTop50 = top50Pct == null || top50Pct <= 82;
  const structBundle = bundleCount <= 10;
  const structHolders = (holderCount != null && holderCount >= 50) || (holderHealthPct != null && holderHealthPct >= 50 && holderHealthPct <= 260);
  const structSocial = socialMentions >= 8 || narrativeStrength >= 2;
  const structDev = (devPeak != null && devPeak >= 10) || (devSuccess != null && devSuccess >= 8);
  const structLearned = !!result.patternMatch?.matched;
  const structBlueprint = !!result.blueprintMatch?.matched;

  pushTrait(traits, inMcRange, 'MC in early pearl zone');
  pushTrait(traits, structEarly, 'Age <= 30m');
  pushTrait(traits, structWash, 'Wash clean/controlled');
  pushTrait(traits, structTop10, 'Top10 controlled');
  pushTrait(traits, structTop50, 'Top50 reasonable');
  pushTrait(traits, structBundle, 'Bundle controlled');
  pushTrait(traits, structHolders, 'Holder structure reasonable');
  pushTrait(traits, structSocial, 'Social/narrative present');
  pushTrait(traits, structDev, 'Dev prior peak/success support');
  pushTrait(traits, structLearned, 'Learned pattern match');
  pushTrait(traits, structBlueprint, 'Blueprint match');

  pushTrait(structureTraits, inMcRange, 'structure_mc');
  pushTrait(structureTraits, structWash, 'structure_wash');
  pushTrait(structureTraits, structTop10, 'structure_top10');
  pushTrait(structureTraits, structTop50, 'structure_top50');
  pushTrait(structureTraits, structBundle, 'structure_bundle');
  pushTrait(structureTraits, structHolders, 'structure_holders');
  pushTrait(structureTraits, structSocial, 'structure_social');
  pushTrait(structureTraits, structDev, 'structure_dev');
  pushTrait(structureTraits, structLearned, 'structure_learned');
  pushTrait(structureTraits, structBlueprint, 'structure_blueprint');

  const gatePass = inMcRange && gateWash && gateTop10 && gateBundle;
  const matched = gatePass && traits.length >= 4 && demandTraits.length >= 1 && structureTraits.length >= 1;

  let confidence = 0;
  if (matched) {
    const demandScore = Math.min(4, demandTraits.length);
    const structureScore = Math.min(5, structureTraits.length);
    const qualityBonus = (washPct != null && washPct <= 10 ? 0.07 : 0) + (top10Pct != null && top10Pct <= 40 ? 0.06 : 0);
    confidence = Math.min(0.95, 0.45 + demandScore * 0.07 + structureScore * 0.05 + qualityBonus);
  }

  const reason = matched
    ? `Early runner structure with ${traits.length} active pearl traits, demand confirmed, and no catastrophic risk.`
    : `Pearl criteria not met: traits=${traits.length}, demand=${demandTraits.length}, structure=${structureTraits.length}, gates=${gatePass ? 'pass' : 'fail'}.`;

  return {
    matched,
    confidence: Number(confidence.toFixed(2)),
    traits,
    reason,
    action: 'TRACK_CHART_TINY_SCOUT_ONLY',
  };
}

module.exports = { evaluatePearlWatch };
