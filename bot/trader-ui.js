'use strict';

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function friendlySetupLabel(rawName) {
  const key = String(rawName || '').toUpperCase();
  const map = {
    CONTROLLED_CONCENTRATION_WINNER: '🏰 Controlled Floor',
    HIGH_VOL_DATA_PLAY: '🌊 Volume Surge',
    EARLY_EXPANSION_ZONE: '🚀 Early Expansion',
    EARLY_EXPANSION_NANO_CAP: '🚀 Early Expansion',
    NARRATIVE_CATALYST: '📰 Narrative',
    MISSED_WINNER_MATCH: '🧠 Learned Pattern',
    BUNDLE_BLOCKED_EXPANSION: '🧨 Bundle Pressure',
    MOMENTUM_EXPANSION: '⚡ Momentum',
    NANO_CAP: '🌱 Nano Launch',
    RISK_PATTERN: '☠️ Failure Pattern',
    DEV_PEAK_BUFFER: '🏰 Controlled Floor',
    EXTREME_CONCENTRATION_EXCEPTION: '🏰 Controlled Floor',
    HIGH_VOL_LOW_LP_EXCEPTION: '🌊 Volume Surge',
    LOW_VOL_MOMENTUM_LOTTO: '⚡ Momentum',
    BLUEPRINT_SCOUT: 'Scout',
    BLUEPRINT_HOT_WATCH: 'Hot Watch',
    EXTREME_CONCENTRATION_SCOUT: 'Extreme Concentration Scout',
    HIGH_VOL_LOW_LP_SCOUT: 'High Volume Low LP Scout',
    LOTTO_WATCH: 'Lotto Watch',
  };
  return map[key] || null;
}

function resolveTraderClass(rawClass, scoreInput = null) {
  const cls = String(rawClass || '').toUpperCase();
  const score = toNum(scoreInput, 0);

  if (cls === 'PEARL_WATCH') {
    return {
      key: 'PEARL',
      label: '🦪 PEARL WATCH',
      movePotential: 'early sendor / inspect now',
      auditLabel: '🦪 PEARL',
    };
  }

  if (['NO_GO', 'AVOID', 'SKIP'].includes(cls)) {
    return {
      key: 'FAIL',
      label: '🔴 FAIL',
      movePotential: 'flat/rug / low probability',
      auditLabel: '🔴 FAIL',
    };
  }

  if (cls === 'ORACLE_BUY') {
    if (score >= 92) {
      return {
        key: 'MONSTER',
        label: '🟣 MONSTER',
        movePotential: '30x+',
        auditLabel: '🟣 MONSTER',
      };
    }
    if (score >= 84) {
      return {
        key: 'MONSTER',
        label: '🟣 MONSTER',
        movePotential: '10x–30x+',
        auditLabel: '🟣 MONSTER',
      };
    }
    return {
      key: 'RUNNER',
      label: '🟢 RUNNER',
      movePotential: '5x–10x',
      auditLabel: '🟢 RUNNER',
    };
  }

  if (cls === 'MISSED_WINNER_MATCH') {
    return {
      key: 'SCOUT',
      label: '🟡 SCOUT',
      movePotential: '2x–5x',
      auditLabel: '🧠 LEARNED',
    };
  }

  if (cls === 'DIRTY_RUNNER_WATCH') {
    if (score >= 68) {
      return {
        key: 'SCOUT',
        label: '🟡 SCOUT',
        movePotential: '2x–5x',
        auditLabel: '🟡 SCOUT',
      };
    }
    return {
      key: 'ALERT',
      label: '🔵 ALERT',
      movePotential: 'developing / wait for confirmation',
      auditLabel: '🔵 ALERT',
    };
  }

  if (['WATCH', 'WATCH_VOL', 'WATCH_WASH', 'RISKY_RUNNER'].includes(cls)) {
    return {
      key: 'ALERT',
      label: '🔵 ALERT',
      movePotential: 'developing / wait for confirmation',
      auditLabel: '🔵 ALERT',
    };
  }

  return {
    key: 'ALERT',
    label: '🔵 ALERT',
    movePotential: 'developing / wait for confirmation',
    auditLabel: '🔵 ALERT',
  };
}

function confidenceFromResult(result) {
  const score = toNum(result?.oracleScore?.total, 0);
  const signals = result?.signals || {};
  let conf = score / 10;
  if (toNum(signals.washPct, 0) > 20) conf -= 0.6;
  if (toNum(signals.top10Pct, 0) > 38) conf -= 0.2;
  if (toNum(signals.bundleCount, 0) >= 7) conf -= 0.4;
  if (signals.sybilFunded) conf -= 2;
  return clamp(Number(conf.toFixed(1)), 1, 9.9);
}

function shortRisk(result) {
  const signals = result?.signals || {};
  if (signals.sybilFunded) return 'confirmed sybil-linked funding';
  if (toNum(signals.washPct, 0) > 35) return 'wash-heavy flow with weak organic demand';
  if (toNum(signals.top10Pct, 0) > 45) return 'high concentration can unwind fast';
  if (toNum(signals.bundleCount, 0) >= 8) return 'bundle pressure from clustered entries';
  if (signals.isSerialDeployer) return 'serial deployer risk profile';
  const raw = result?.noGoReason || result?.watchReason || result?.headlineType || 'early structure still fragile';
  return String(raw).replace(/watch only/gi, 'needs confirmation');
}

function whyRunText(result) {
  const s = result?.signals || {};
  const parts = [];
  if (toNum(s.adjustedVolLiq, 0) >= 8) parts.push('extreme organic volume');
  else if (toNum(s.adjustedVolLiq, 0) >= 5) parts.push('healthy organic volume');
  if (toNum(s.marketCap, 0) > 0 && toNum(s.marketCap, 0) <= 120000) parts.push('low MC expansion room');
  if (toNum(result?.social?.mentions15m, 0) >= 10 || toNum(s.narrativeStrength, 0) >= 3) parts.push('narrative pressure');
  if (result?.patternMatch?.matched || String(result?.oracleScore?.class || '').toUpperCase() === 'MISSED_WINNER_MATCH') {
    parts.push('learned runner structure');
  }
  if (!parts.length) parts.push('early momentum with emerging demand');
  return `${parts.slice(0, 4).join(', ')}.`;
}

function whyFailText(result) {
  const s = result?.signals || {};
  const reasons = [];
  if (s.isSerialDeployer) reasons.push('serial deployer');
  if (toNum(s.bundleCount, 0) >= 6) reasons.push('bundled entries');
  if (toNum(s.top10Pct, 0) >= 40) reasons.push('inflated holder concentration');
  if (toNum(s.washPct, 0) >= 25) reasons.push('wash risk');
  if (!reasons.length) reasons.push(shortRisk(result));
  return `${reasons.slice(0, 3).join(', ')}.`;
}

function oracleReadText(traderClassKey) {
  if (traderClassKey === 'MONSTER') return 'Ugly but explosive. High-risk asymmetric runner profile.';
  if (traderClassKey === 'RUNNER') return 'Structured momentum with room to trend if flow stays organic.';
  if (traderClassKey === 'SCOUT') return 'Tradeable setup, but fragile and needs confirmation.';
  if (traderClassKey === 'PEARL') return 'Early sendor profile. Track/chart first; avoid blind chase.';
  if (traderClassKey === 'FAIL') return 'Risk outweighs edge right now.';
  return 'Developing setup. Wait for cleaner confirmation.';
}

function friendlyBlueprintActionLabel(rawAction) {
  const key = String(rawAction || '').toUpperCase();
  const map = {
    BLUEPRINT_SCOUT: 'Scout',
    BLUEPRINT_HOT_WATCH: 'Hot Watch',
    EXTREME_CONCENTRATION_SCOUT: 'Extreme Concentration Scout',
    HIGH_VOL_LOW_LP_SCOUT: 'High Volume Low LP Scout',
    LOTTO_WATCH: 'Lotto Watch',
    BLOCK: 'Blocked',
    NONE: 'None',
  };
  return map[key] || (rawAction ? String(rawAction) : 'None');
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function setupTagsFromResult(result) {
  const signals = result?.signals || {};
  const tags = [];
  if (signals.earlyExpansionZone) tags.push('🚀 Early Expansion');
  if (toNum(signals.adjustedVolLiq, 0) >= 8) tags.push('🌊 Volume Surge');
  if (toNum(signals.narrativeStrength, 0) >= 3) tags.push('📰 Narrative');
  if (String(result?.oracleScore?.class || '').toUpperCase() === 'PEARL_WATCH') tags.push('🦪 Pearl Structure');
  if (result?.patternMatch?.matched || String(result?.oracleScore?.class || '').toUpperCase() === 'MISSED_WINNER_MATCH') {
    tags.push('🧠 Learned Pattern');
  }

  const blueprintMatches = result?.blueprintMatch?.matches || [];
  for (const name of blueprintMatches) {
    const friendly = friendlySetupLabel(name);
    if (friendly) tags.push(friendly);
  }

  return dedupe(tags).slice(0, 4);
}

module.exports = {
  resolveTraderClass,
  friendlySetupLabel,
  confidenceFromResult,
  shortRisk,
  whyRunText,
  whyFailText,
  oracleReadText,
  setupTagsFromResult,
  friendlyBlueprintActionLabel,
};
