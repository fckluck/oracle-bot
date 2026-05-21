const config = require('./config');

// ── Eastern Time window ───────────────────────────────────────────────────────

function getEasternHour() {
  const now   = new Date();
  const month = now.getUTCMonth() + 1;
  const offset = (month >= 3 && month <= 11) ? -4 : -5; // EDT / EST
  return (now.getUTCHours() + 24 + offset) % 24;
}

function getTimeWindow() {
  const h = getEasternHour();
  if (h >= 2  && h < 12) return 'DISCOVERY';
  if (h >= 12 && h < 19) return 'DEAD_ZONE';
  return 'RESEARCH';
}

// ── Entry Tier (v8.1 Predator Patch) ──────────────────────────────────────────
// Tier ladder is purely vol/liq-based. RISKY_RUNNER is the new high-vol play
// that accepts elevated bundle/concentration when volume is strong (0.5 units).

function getPositionUnits(entryTier, lp, mc) {
  if (entryTier === 'SCRIBBLI') {
    const lpPct = mc > 0 ? (lp / mc) * 100 : 100;
    return lpPct < 15 ? 1.0 : 2.0;
  }
  switch (entryTier) {
    case 'PLUTO':           return 2.0;
    case 'HIGH_CONVICTION': return 1.5;
    case 'BASELINE_ENTRY':  return 1.0;
    case 'RISKY_RUNNER':    return 0.5;
    default:                return 0;
  }
}

// ── Momentum Gate ─────────────────────────────────────────────────────────────

function momentumGate(birdeye, volLiq) {
  if (!birdeye) return null;
  const { priceChange5m, rangePct } = birdeye;
  if (priceChange5m !== null && priceChange5m < 0 && volLiq >= 8) {
    return 'VOLUMETRIC_DISTRIBUTION';
  }
  if (rangePct !== null) {
    return rangePct >= 0.75 ? 'TOP_QUARTER' : 'LOWER_RANGE';
  }
  return null;
}

// ── CTO check ─────────────────────────────────────────────────────────────────

function ctoStatus(pump, walletAge, top10Pct) {
  const devInactive = walletAge?.minutesSinceLastTx != null
    ? walletAge.minutesSinceLastTx >= 30 : null;
  const concentrationOk = top10Pct !== null ? top10Pct < config.TOP10_MAX_PCT : null;
  const hasSocials = !!(pump?.twitter || pump?.telegram || pump?.website);
  if (devInactive === true && concentrationOk !== false && hasSocials) return 'CTO_CONFIRMED';
  if (devInactive === false) return 'DEV_ACTIVE';
  if (devInactive === true && !hasSocials) return 'CTO_PARTIAL';
  if (devInactive === true && hasSocials) return 'CTO_LIKELY';
  return 'UNKNOWN';
}

function holderVerdict(holderCount, marketCap) {
  if (holderCount == null) return 'UNVERIFIED';
  if (!marketCap || marketCap <= 0) return 'UNVERIFIED';
  const baseline = (marketCap / 100000) * 400;
  if (holderCount < baseline * 0.5) return 'LOW ORGANIC REACH';
  if (holderCount > baseline * 2.0) return 'INFLATED WALLETS';
  return 'PASS';
}

// Dynamic Holder Health vs baseline of 400 holders per $100K MC.
// Returns { target, healthPct, label } or null when unverifiable.
function holderHealth(holderCount, marketCap) {
  if (holderCount == null || !marketCap || marketCap <= 0) return null;
  const target = (marketCap / 100000) * 400;
  if (target <= 0) return null;
  const healthPct = Math.round((holderCount / target) * 100);
  let label = 'PASS';
  if (healthPct < 50)       label = 'LOW ORGANIC';
  else if (healthPct > 200) label = 'INFLATED/BOTTED';
  return { target: Math.round(target), healthPct, label };
}

function pressureFlag(buyCount, sellCount) {
  const total = (buyCount ?? 0) + (sellCount ?? 0);
  if (total === 0) return 'N/A';
  const buyPct = (buyCount ?? 0) / total * 100;
  if (buyPct > 85) return 'AGGRESSIVE BUY PRESSURE';
  if (buyPct < 40) return 'SELL PRESSURE WARNING';
  return 'NEUTRAL';
}

function detectCtoFromDesc(pump) {
  if (!pump) return null;
  const desc = (pump.description || pump.name || '').toLowerCase();
  const phrases = ['cto', 'community takeover', 'community take over', 'no dev', 'dev abandoned'];
  return phrases.some(p => desc.includes(p));
}

// ── Main scan (v6.0) ──────────────────────────────────────────────────────────

function scan(data) {
  const { codex, pump, holders, bundle, devStats, devPeak, walletAge, birdeye, stDeployer } = data;

  const lp           = codex?.lp       ?? 0;
  const volLiq       = codex?.volLiq   ?? 0;
  const ageMins      = codex?.ageMinutes ?? null;
  const mc           = codex?.marketCap  ?? null;
  const curvePct     = pump?.curvePct    ?? null;
  const devWallet    = data.devWallet || pump?.devWallet || null;
  // SolanaTracker is primary (indexes pump.fun creates correctly); legacy
  // devStats/devPeak retained as fallbacks for non-pump tokens.
  const devLaunches   = stDeployer?.totalLaunches ?? devStats?.totalLaunches ?? null;
  const migratedCount = stDeployer?.migratedCount ?? devStats?.migratedCount ?? null;
  const timeWindow   = getTimeWindow();
  const holderCount     = holders?.holderCount ?? null;
  const topAccountCount = holders?.topAccountCount ?? null;
  const top10Pct        = holders?.top10Pct    ?? null;
  const holderSource    = holders?.source ?? null;

  const ctoDesc           = detectCtoFromDesc(pump);
  const ctoBehavior       = ctoStatus(pump, walletAge, top10Pct);
  const momentumStatus    = momentumGate(birdeye, volLiq);
  const holderVerdictLabel= holderVerdict(holderCount, mc);
  const holderHealthData  = holderHealth(holderCount, mc);
  const pressureLabel     = pressureFlag(codex?.buyCount, codex?.sellCount);

  // ── v8.1 Predator gating ───────────────────────────────────────────────────
  // bundleCount = max txns clustered in a single slot (closest analog to "bundle size")
  // isDeFadeClean = Meteora pool (auto-clean) OR DeFade score < 20
  const bundleCount = bundle?.maxInSlot ?? 0;
  const isMeteora = codex?.isMeteora === true;
  const deFadeScore = data.deFadeScore ?? null;
  const isDeFadeClean = isMeteora ? true : (deFadeScore !== null && deFadeScore < 20);

  let noGoReason = null;

  // Hard pre-checks (kept from v6.x)
  if (bundle?.sybilDetected) {
    noGoReason = `Sybil Bundle — ${bundle.uniqueSigners} buyers share only ${bundle.fundingSources} funding source(s)`;
  } else if (lp < config.LP_MIN_USD) {
    noGoReason = `Low Liquidity (${lp > 0 ? '$' + lp.toLocaleString() : 'N/A'} < $${config.LP_MIN_USD.toLocaleString()})`;
  } else if (curvePct !== null && curvePct >= 90 && curvePct < 100) {
    noGoReason = `Migration Gap — Curve at ${curvePct.toFixed(1)}% (wait for Raydium pool)`;
  } else if (devLaunches !== null && devLaunches > 500) {
    noGoReason = `Serial Deployer (${devLaunches} launches)`;
  }
  // v8.1: Bundle thresholds (replaces old "any bundle = NO_GO")
  else if (bundleCount > 10) {
    noGoReason = `MASSIVE BUNDLE — ${bundleCount} txns in single slot`;
  } else if (bundleCount > 5 && !isDeFadeClean) {
    const ctx = deFadeScore !== null ? `DeFade=${deFadeScore}` : 'DeFade unverified';
    noGoReason = `UNVERIFIED BUNDLE — ${bundleCount}/slot, ${ctx}`;
  }
  // v8.1: Absolute concentration hard-cap. Anything >35% is a hard NO_GO at any MC.
  // The 15% threshold is a soft flag that gets handled by the RISKY_RUNNER tier
  // below (vol override accepts elevated concentration with 0.5x sizing).
  else if (top10Pct !== null && top10Pct > 35) {
    noGoReason = `Concentration Too High — Top10 ${top10Pct.toFixed(1)}% > 35%`;
  }

  // ── Verdict ladder (v8.1) ──────────────────────────────────────────────────
  let entryTier = null, verdict, watchReason = null;
  const minThreshold = 5.0;

  if (noGoReason) {
    verdict = 'NO_GO';
  } else if (momentumStatus === 'VOLUMETRIC_DISTRIBUTION') {
    verdict = 'AVOID';
  } else if (volLiq >= 50) {
    entryTier = 'SCRIBBLI'; verdict = 'BUY';
  } else if (volLiq >= 8 && (bundleCount > 5 || (top10Pct !== null && top10Pct > 15))) {
    // Risky Runner — strong volume despite elevated bundle/concentration (0.5x sizing)
    entryTier = 'RISKY_RUNNER'; verdict = 'BUY';
    const flags = [];
    if (bundleCount > 5) flags.push(`bundle ${bundleCount}/slot`);
    if (top10Pct !== null && top10Pct > 15) flags.push(`top10 ${top10Pct.toFixed(1)}%`);
    watchReason = `Vol override active — ${flags.join(' + ')}. Half-size only.`;
  } else if (volLiq >= 12 && isDeFadeClean) {
    entryTier = 'PLUTO'; verdict = 'BUY';
  } else if (volLiq >= 8) {
    entryTier = 'HIGH_CONVICTION'; verdict = 'BUY';
  } else if (volLiq >= 5) {
    entryTier = 'BASELINE_ENTRY'; verdict = 'BUY';
  } else if (volLiq >= 3.0) {
    verdict = 'WATCH_VOL';
    watchReason = `Health good. Wait for Vol/Liq ≥ ${minThreshold}x (currently ${volLiq.toFixed(1)}x).`;
  } else {
    verdict = 'SKIP';
  }

  const positionUnits   = getPositionUnits(entryTier, lp, mc);
  const positionSizeSol = +(config.SESSION_SIZE_SOL * positionUnits).toFixed(3);
  const scribbliSlippageWarning = entryTier === 'SCRIBBLI' && mc > 0 && (lp / mc) * 100 < 15;

  const devProfile = {
    wallet:                  devWallet,
    totalLaunches:           devLaunches,
    migratedCount,
    winRate:                 stDeployer?.winRate              ?? devStats?.winRate                ?? null,
    peakAssets:              stDeployer?.assetCount           ?? devPeak?.assetCount              ?? null,
    peakMc:                  stDeployer?.peakMc               ?? devPeak?.highestMc               ?? null,
    topPerformerMultiplier:  stDeployer?.topPerformerMultiplier ?? devPeak?.topPerformerMultiplier ?? null,
    walletAge:               walletAge                        ?? null,
    ctoBehavior,
  };

  return {
    verdict, entryTier, noGoReason, watchReason, timeWindow,
    positionSizeSol, positionUnits, scribbliSlippageWarning,
    holderVerdictLabel, pressureLabel, momentumStatus, ctoBehavior,
    devProfile,
    signals: {
      lp, ageMinutes: ageMins,
      volume1h:      codex?.volume1h     ?? null,
      volLiq, marketCap: mc,
      priceUsd:      codex?.priceUsd     ?? null,
      buyCount:      codex?.buyCount     ?? null,
      sellCount:     codex?.sellCount    ?? null,
      uniqueWallets: codex?.uniqueWallets ?? null,
      change1h:      codex?.change1h     ?? null,
      holderCount, topAccountCount, top10Pct, holderSource,
      top3Pct:       holders?.top3Pct    ?? null,
      curvePct, ctoDesc, timeWindow, bundle,
      birdeye: birdeye || null,
      bundleCount, isMeteora, deFadeScore, isDeFadeClean,
      holderHealth: holderHealthData,
      // Post-curve detection: pump explicitly says migrated, OR pump 404'd but
      // DexScreener has the token (= effectively post-curve / non-pump token).
      isPostCurve: pump?.migrated === true || (pump == null && codex != null),
    },
  };
}

module.exports = { scan };
