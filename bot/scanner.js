const config = require('./config');

// ── Eastern Time window ───────────────────────────────────────────────────────

function getEasternHour() {
  const now   = new Date();
  const month = now.getUTCMonth() + 1;
  const offset = (month >= 3 && month <= 11) ? -4 : -5;
  return (now.getUTCHours() + 24 + offset) % 24;
}

function getTimeWindow() {
  const h = getEasternHour();
  if (h >= 2  && h < 12) return 'DISCOVERY';
  if (h >= 12 && h < 19) return 'DEAD_ZONE';
  return 'RESEARCH';
}

// ── Position sizing (v8.4 — adjusted vol/liq based) ──────────────────────────

function getPositionUnits(entryTier, lp, mc) {
  if (entryTier === 'SCRIBBLI') {
    const lpPct = mc > 0 ? (lp / mc) * 100 : 100;
    return lpPct < 15 ? 1.0 : 2.0;
  }
  switch (entryTier) {
    case 'PLUTO':           return 2.0;
    case 'HIGH_CONVICTION': return 1.5;
    case 'BASELINE_ENTRY':  return 1.0;
    default:                return 0;
  }
}

// ── Momentum Gate ─────────────────────────────────────────────────────────────

function momentumGate(birdeye, volLiq) {
  if (!birdeye) return null;
  const { priceChange5m, rangePct } = birdeye;
  // Distribution: requires a significant 5m drop (>10%) not just any red candle.
  // Normal Solana "breathing" (small pullbacks during uptrends) should not trigger this.
  if (priceChange5m !== null && priceChange5m < -10 && volLiq >= 8) {
    return 'VOLUMETRIC_DISTRIBUTION';
  }
  if (rangePct !== null) {
    // 60% floor captures re-accumulation phase, not just absolute peak.
    return rangePct >= 0.60 ? 'TOP_QUARTER' : 'LOWER_RANGE';
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

// ── Holder health ─────────────────────────────────────────────────────────────

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

// ── v8.4 Wash quality label ───────────────────────────────────────────────────

function washQualityLabel(washPct) {
  if (washPct == null) return 'UNVERIFIED';
  if (washPct < 15)   return 'ORGANIC';
  if (washPct < 35)   return 'MIXED';
  return 'WASH-HEAVY';
}

// ── Main scan (v8.4 Anti-Wash Predator) ──────────────────────────────────────

function scan(data) {
  const { codex, pump, holders, bundle, devStats, devPeak, walletAge, birdeye, stDeployer } = data;

  const lp       = codex?.lp         ?? 0;
  const vol1h    = codex?.volume1h   ?? 0;
  const ageMins  = codex?.ageMinutes ?? null;
  const mc       = codex?.marketCap  ?? null;
  const curvePct = pump?.curvePct    ?? null;
  const devWallet= data.devWallet || pump?.devWallet || null;

  const devLaunches   = stDeployer?.totalLaunches ?? devStats?.totalLaunches ?? null;
  const migratedCount = stDeployer?.migratedCount ?? devStats?.migratedCount ?? null;
  const timeWindow    = getTimeWindow();

  // Pro Pilot: success rate > 5% AND minimum 10 launches → lower BUY floor to 3x.
  // Experience floor: devs with <10 launches are UNPROVEN — success rate is
  // statistically meaningless and the 3x buffer must not activate for them.
  const successRatePct   = (devLaunches != null && devLaunches > 0 && migratedCount != null)
    ? (migratedCount / devLaunches) * 100 : null;
  const isUnproven       = devLaunches != null && devLaunches < 10;
  const isProPilot       = successRatePct != null && successRatePct > 5 && !isUnproven;
  const isSerialDeployer = devLaunches !== null && devLaunches > 500;

  const holderCount     = holders?.holderCount     ?? null;
  const topAccountCount = holders?.topAccountCount ?? null;
  const top10Pct        = holders?.top10Pct        ?? null;
  const holderSource    = holders?.source          ?? null;

  const ctoDesc        = detectCtoFromDesc(pump);
  const ctoBehavior    = ctoStatus(pump, walletAge, top10Pct);
  const holderHealthData = holderHealth(holderCount, mc);
  const pressureLabel  = pressureFlag(codex?.buyCount, codex?.sellCount);

  // ── v8.4 Wash / Adjusted Vol computation ──────────────────────────────────
  const rawWashPct     = data.washPct      ?? null;
  const washVolumeUsd  = data.washVolumeUsd ?? null;
  const washSource     = data.washSource   ?? null;
  const snipersPct     = data.snipersPct   ?? null;
  const insidersPct    = data.insidersPct  ?? null;
  const stRiskScore    = data.stRiskScore  ?? null;
  const washPct        = rawWashPct != null ? Math.round(rawWashPct * 10) / 10 : null;
  const organicVol     = (washPct != null && vol1h > 0)
    ? vol1h * (1 - washPct / 100) : vol1h;
  const adjustedVolLiq = lp > 0 ? organicVol / lp : 0;
  const rawVolLiq      = lp > 0 ? vol1h / lp : 0;

  // ── Bundle / DeFade ────────────────────────────────────────────────────────
  const bundleCount  = bundle?.maxInSlot ?? 0;
  const isMeteora    = codex?.isMeteora === true;
  const deFadeScore  = data.deFadeScore ?? null;
  const isDeFadeClean = isMeteora ? true : (deFadeScore !== null && deFadeScore < 20);
  const sybilFunded  = !!(bundle?.sybilDetected);

  // ── Momentum ───────────────────────────────────────────────────────────────
  let momentumStatus = momentumGate(birdeye, adjustedVolLiq);

  // HEALTHY DIP override: price dropped >10% in 5m (would normally AVOID) but
  // buy-side transactions still dominate — signal of dip-buying, not a dump.
  // Lets the token fall through to the vol/liq verdict ladder as a WATCH/BUY.
  if (
    momentumStatus === 'VOLUMETRIC_DISTRIBUTION' &&
    codex?.buyCount != null && codex?.sellCount != null &&
    codex.buyCount > codex.sellCount
  ) {
    momentumStatus = 'HEALTHY_DIP';
  }

  // ── Kill-Shot Headline Hierarchy (v8.4) ───────────────────────────────────
  // Priority: Bundle > Momentum > Concentration > Wash > Liquidity > Deployer
  let noGoReason   = null;
  let headlineType = null; // 'BUNDLE' | 'MOMENTUM' | 'CONCENTRATION' | 'WASH' | 'LIQUIDITY' | 'DEPLOYER'

  // 1. Sybil Wash Trap (Sybil funding + wash)
  if (sybilFunded && washPct !== null && washPct > 30) {
    noGoReason   = `SYBIL WASH TRAP — Same-parent funding + ${washPct.toFixed(0)}% fake volume`;
    headlineType = 'BUNDLE';
  }
  // 2. Bundle
  else if (sybilFunded) {
    noGoReason   = `SYBIL BUNDLE — ${bundle.uniqueSigners} buyers, ${bundle.fundingSources} funding source(s)`;
    headlineType = 'BUNDLE';
  }
  else if (bundleCount > 10) {
    noGoReason   = `BUNDLE RISK — ${bundleCount} txns in single slot`;
    headlineType = 'BUNDLE';
  }
  // 3. Hard wash gate (>50%)
  else if (washPct !== null && washPct > 50) {
    const ctoConfirmed = ctoBehavior === 'CTO_CONFIRMED';
    if (!ctoConfirmed) {
      noGoReason   = `WASH FAIL — ${washPct.toFixed(0)}% fake volume (>${50}% threshold)`;
      headlineType = 'WASH';
    }
  }
  // 4. Liquidity
  else if (lp < config.LP_MIN_USD) {
    noGoReason   = `Low Liquidity (${lp > 0 ? '$' + lp.toLocaleString() : 'N/A'} < $${config.LP_MIN_USD.toLocaleString()})`;
    headlineType = 'LIQUIDITY';
  }
  // 5. Migration gap
  else if (curvePct !== null && curvePct >= 90 && curvePct < 100) {
    noGoReason   = `Migration Gap — Curve at ${curvePct.toFixed(1)}% (wait for Raydium pool)`;
    headlineType = 'LIQUIDITY';
  }
  // 6. (Serial Deployer demoted to DEV TRUST warning — no longer a hard NO_GO)
  // 7. Moderate bundle without DeFade clean — threshold raised to >7 (6-7/slot is borderline
  //    on a hot token; real bot clusters are 10+/slot; DeFade runs post-scan on BUY only)
  else if (bundleCount > 7 && !isDeFadeClean) {
    const ctx = deFadeScore !== null ? `DeFade=${deFadeScore}` : 'DeFade unverified';
    noGoReason   = `UNVERIFIED BUNDLE — ${bundleCount}/slot, ${ctx}`;
    headlineType = 'BUNDLE';
  }
  // 8. Concentration hard cap
  else if (top10Pct !== null && top10Pct > 35) {
    noGoReason   = `CONCENTRATION FAIL — Top10 ${top10Pct.toFixed(1)}% > 35%`;
    headlineType = 'CONCENTRATION';
  }

  // ── Verdict ladder (v8.4 — adjusted vol/liq) ──────────────────────────────
  let entryTier = null, verdict, watchReason = null;

  if (noGoReason) {
    verdict = 'NO_GO';
  } else if (momentumStatus === 'VOLUMETRIC_DISTRIBUTION') {
    verdict      = 'AVOID';
    headlineType = 'MOMENTUM';
  // HEALTHY_DIP falls through to the normal vol/liq ladder below (no special case needed)
  } else if (washPct !== null && washPct > 30) {
    // Soft wash gate (30-50%): cap at WATCH
    verdict      = 'WATCH_WASH';
    watchReason  = `Wash volume ${washPct.toFixed(0)}% exceeds 30% — capped at WATCH. Wait for organic volume to dominate.`;
    headlineType = 'WASH';
  } else if (adjustedVolLiq >= 50) {
    entryTier    = 'SCRIBBLI'; verdict = 'BUY';
  } else if (adjustedVolLiq >= 12 &&
             (washPct === null || washPct < 20) &&
             (top10Pct === null || top10Pct < 15) &&
             momentumStatus === 'TOP_QUARTER') {
    // Pluto Lock: all four conditions required
    entryTier    = 'PLUTO'; verdict = 'BUY';
  } else if (adjustedVolLiq >= 12) {
    // Pluto conditions not fully met — downgrade to HIGH_CONVICTION
    entryTier    = 'HIGH_CONVICTION'; verdict = 'BUY';
  } else if (adjustedVolLiq >= 8) {
    entryTier    = 'HIGH_CONVICTION'; verdict = 'BUY';
  } else if (adjustedVolLiq >= 5) {
    entryTier    = 'BASELINE_ENTRY'; verdict = 'BUY';
  } else if (adjustedVolLiq >= 3 && isProPilot) {
    // Pro Pilot buffer: proven dev (>5% success rate) earns 3x floor instead of 5x
    entryTier    = 'BASELINE_ENTRY'; verdict = 'BUY';
  } else if (adjustedVolLiq >= 3) {
    verdict      = 'WATCH_VOL';
    watchReason  = `Adjusted Vol/Liq ${adjustedVolLiq.toFixed(1)}x below 5x minimum. Wait for organic demand.`;
  } else {
    verdict = 'SKIP';
  }

  // ── Social Breakout upgrade (additive, never lowers math floor) ───────────
  // Rules:
  //   1. WATCH_VOL (3x-5x) → BASELINE_ENTRY if social breakout detected
  //   2. Math floor stays locked: SKIP (<3x) cannot be upgraded regardless
  //   3. Hard NO_GO / AVOID / WATCH_WASH kills are never overridden
  const social = data.social ?? null;
  const socialBreakout = social?.available && social?.isTrending;
  const socialCto      = social?.available && social?.ctoSignal;

  // Social CTO: X community is calling a takeover from 3+ unique accounts.
  // Overrides the on-chain CTO detection — visible in scorecard but doesn't
  // change verdict on its own (only the WATCH upgrade rule triggers a verdict change).
  const effectiveCto = ctoBehavior === 'CTO_CONFIRMED' || ctoBehavior === 'CTO_LIKELY' || socialCto;

  let socialUpgrade = false;
  if (verdict === 'WATCH_VOL' && socialBreakout) {
    verdict       = 'BUY';
    entryTier     = 'BASELINE_ENTRY';
    watchReason   = null;
    socialUpgrade = true;
  }

  // ── RISKY RUNNER overrides ─────────────────────────────────────────────────
  let riskyRunnerReason = null;

  // (A) Grok-style social+dev override: a soft NO_GO with viral X sentiment and
  // a proven dev CAN be a hidden opportunity. Hard kills never overridden.
  const socialViral = social?.available && (social?.mentionCount ?? 0) >= 20;
  if (
    verdict === 'NO_GO' &&
    headlineType !== 'BUNDLE' &&
    headlineType !== 'WASH' &&
    socialViral &&
    isProPilot
  ) {
    verdict = 'RISKY_RUNNER';
    riskyRunnerReason = 'SOCIAL_GROK';
  }

  // (B) INFLATED/BOTTED demotion: synthetic holder counts at low MC mean the
  // BUY conviction is unearned — demote to RISKY_RUNNER at 0.5x size.
  if (verdict === 'BUY' && holderHealthData?.label === 'INFLATED/BOTTED') {
    verdict = 'RISKY_RUNNER';
    riskyRunnerReason = 'INFLATED_HOLDERS';
  }

  const positionUnits   = getPositionUnits(entryTier, lp, mc);
  const positionSizeSol = +(config.SESSION_SIZE_SOL * positionUnits).toFixed(3);
  const scribbliSlippageWarning = entryTier === 'SCRIBBLI' && mc > 0 && (lp / mc) * 100 < 15;

  const devProfile = {
    wallet:                 devWallet,
    totalLaunches:          devLaunches,
    migratedCount,
    winRate:                stDeployer?.winRate              ?? devStats?.winRate              ?? null,
    peakAssets:             stDeployer?.assetCount           ?? devPeak?.assetCount            ?? null,
    peakMc:                 stDeployer?.peakMc               ?? devPeak?.highestMc             ?? null,
    topPerformerMultiplier: stDeployer?.topPerformerMultiplier ?? devPeak?.topPerformerMultiplier ?? null,
    walletAge:              walletAge ?? null,
    ctoBehavior,
  };

  return {
    verdict, entryTier, noGoReason, headlineType, watchReason, timeWindow,
    positionSizeSol, positionUnits, scribbliSlippageWarning,
    pressureLabel, momentumStatus, ctoBehavior,
    devProfile,
    socialUpgrade, socialBreakout, socialCto, effectiveCto,
    signals: {
      lp, ageMinutes: ageMins,
      volume1h:       codex?.volume1h     ?? null,
      rawVolLiq, adjustedVolLiq, washPct, washVolumeUsd, washSource,
      washQuality:    washQualityLabel(washPct),
      snipersPct, insidersPct, stRiskScore,
      marketCap: mc,
      priceUsd:       codex?.priceUsd     ?? null,
      buyCount:       codex?.buyCount     ?? null,
      sellCount:      codex?.sellCount    ?? null,
      uniqueWallets:  codex?.uniqueWallets ?? null,
      change1h:       codex?.change1h     ?? null,
      holderCount, topAccountCount, top10Pct, holderSource,
      top3Pct:        holders?.top3Pct    ?? null,
      top50Pct:       holders?.top50Pct   ?? null,
      curvePct, ctoDesc, timeWindow, bundle,
      birdeye: birdeye || null,
      bundleCount, isMeteora, deFadeScore, isDeFadeClean, sybilFunded,
      holderHealth:   holderHealthData,
      isPostCurve:    pump?.migrated === true || (pump == null && codex != null),
      isProPilot, isUnproven, isSerialDeployer, successRatePct, riskyRunnerReason,
      proPilotBuffer: isProPilot && adjustedVolLiq >= 3 && adjustedVolLiq < 5,
    },
  };
}

module.exports = { scan };
