const config = require('./config');

// ── Eastern Time window ───────────────────────────────────────────────────────

function getEasternHour() {
  // Intl.DateTimeFormat handles DST correctly including the exact switch
  // dates in early March and late November that the old month-offset missed.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  return Number(parts.find(p => p.type === 'hour')?.value ?? 0);
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
  // v10.2.7 STRICT: ANY negative 5m candle with significant volume = distribution.
  // The old -10% threshold let obvious dumps through as HIGH_CONVICTION.
  if (priceChange5m !== null && priceChange5m < 0 && volLiq >= 8) {
    return 'VOLUMETRIC_DISTRIBUTION';
  }
  if (rangePct !== null) {
    // v10.2.7: tightened 0.60 → 0.75 — must be in top 25% of 1H range to qualify
    // for any BUY tier. LOWER_RANGE is caught explicitly in the verdict ladder.
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
  // v10.2.7: HEALTHY_DIP override removed. Letting AVOID flip to BUY because
  // buyCount > sellCount during a 5m dump was producing false BUY signals on
  // distribution candles. Strict distribution = strict AVOID, no exceptions.
  const momentumStatus = momentumGate(birdeye, adjustedVolLiq);

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
  else if (top10Pct !== null && top10Pct > config.TOP10_HARD_MAX_PCT) {
    noGoReason   = `CONCENTRATION FAIL — Top10 ${top10Pct.toFixed(1)}% > ${config.TOP10_HARD_MAX_PCT}%`;
    headlineType = 'CONCENTRATION';
  }
  // 9. v10.2 Botted Wallets HARD-STOP — extreme inflation at low MC is
  //     unrecoverable. NO RISKY_RUNNER override allowed for this pattern.
  //     v10.2.2 fail-safe: when holder health is UNAVAILABLE at low MC, the
  //     gate also trips — we cannot certify a sub-$100K launch without it.
  else if (
    mc != null && mc < 100000 && (
      (holderHealthData?.healthPct != null && holderHealthData.healthPct > 250) ||
      holderHealthData?.healthPct == null
    )
  ) {
    if (holderHealthData?.healthPct == null) {
      noGoReason = `HOLDER DATA UNAVAILABLE — Cannot certify wallet quality at $${(mc/1000).toFixed(0)}K MC (gate 9 fail-safe)`;
    } else {
      noGoReason = `BOTTED WALLETS — Holder Health ${holderHealthData.healthPct}% at $${(mc/1000).toFixed(0)}K MC (>250% threshold under $100K)`;
    }
    headlineType = 'INFLATED';
  }

  // ── Verdict ladder (v10.2.7 — Spine Lock) ─────────────────────────────────
  // Tiered BUY now REQUIRES a multi-factor safety pass. v10.2.6 let high-vol
  // tokens with bad top10/wash/momentum still earn BUY via the "downgrade to
  // HIGH_CONVICTION" path. v10.2.7 routes failed safety to WATCH instead.
  let entryTier = null, verdict, watchReason = null;

  // Shared safety predicate for the high tiers (SCRIBBLI / PLUTO).
  // ALL of: momentum in top 25%, top10 < 15%, wash < 20%, bundle/parent clean,
  // holder health sane (50-200% or unknown), dev not active.
  const highTierSafe = (
    momentumStatus === 'TOP_QUARTER' &&
    (top10Pct === null || top10Pct < 15) &&
    (washPct === null || washPct < 20) &&
    bundleCount <= 7 &&
    !sybilFunded &&
    (holderHealthData?.healthPct == null ||
      (holderHealthData.healthPct >= 50 && holderHealthData.healthPct <= 200)) &&
    ctoBehavior !== 'DEV_ACTIVE'
  );
  // SCRIBBLI adds an LP/MC health gate (>=15%) — required for 50x+ extreme tier.
  const scribbliSafe = highTierSafe && (mc <= 0 || (lp / mc) * 100 >= 15);

  if (noGoReason) {
    verdict = 'NO_GO';
  } else if (momentumStatus === 'VOLUMETRIC_DISTRIBUTION') {
    verdict      = 'AVOID';
    headlineType = 'MOMENTUM';
  } else if (momentumStatus === 'LOWER_RANGE') {
    // v10.2.7: range <0.75 = momentum fail. Cannot become BUY at any vol tier.
    verdict      = 'WATCH_VOL';
    watchReason  = `MOMENTUM FAIL — Price in lower 75% of 1H range. WATCH for re-accumulation back to top quarter.`;
    headlineType = 'MOMENTUM';
  } else if (washPct !== null && washPct > 30) {
    // Soft wash gate (30-50%): cap at WATCH
    verdict      = 'WATCH_WASH';
    watchReason  = `Wash volume ${washPct.toFixed(0)}% exceeds 30% — capped at WATCH. Wait for organic volume to dominate.`;
    headlineType = 'WASH';
  } else if (adjustedVolLiq >= 50 && scribbliSafe) {
    entryTier    = 'SCRIBBLI'; verdict = 'BUY';
  } else if (adjustedVolLiq >= 50) {
    // v10.2.7: 50x+ without safety NO LONGER auto-buys. Sit on hands.
    verdict      = 'WATCH_VOL';
    watchReason  = `SCRIBBLI threshold met (${adjustedVolLiq.toFixed(1)}x) but safety failed — top10/momentum/bundle/wash/holder/dev/LP-MC. WATCH only.`;
  } else if (adjustedVolLiq >= 12 && highTierSafe) {
    entryTier    = 'PLUTO'; verdict = 'BUY';
  } else if (adjustedVolLiq >= 12) {
    // v10.2.7: failed PLUTO safety NO LONGER downgrades to HIGH_CONVICTION BUY.
    // It becomes WATCH. The old downgrade was the single biggest source of
    // "Oracle called this rug a BUY" complaints in v10.2.6.
    verdict      = 'WATCH_VOL';
    watchReason  = `PLUTO threshold met (${adjustedVolLiq.toFixed(1)}x) but safety failed — top10/momentum/wash/bundle/holder/dev. WATCH only.`;
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
  // v10.2.7 (post-architect fix): the social upgrade was the back door that
  // undid Spine Lock. A trending X post could lift any WATCH_VOL — including
  // dirty-SCRIBBLI, failed-PLUTO, LOWER_RANGE, INFLATED-holder cases — back to
  // BUY. Now the upgrade requires the SAME safety pass as PLUTO/SCRIBBLI:
  // momentum in top quarter, top10 < 15, wash < 20, bundle/sybil clean,
  // holder health sane, dev not active. Plus an explicit watchReason guard so
  // momentum/wash-cap WATCH states cannot be promoted regardless.
  const watchIsRecoverable = watchReason !== null &&
    !/momentum fail|safety failed|wash volume/i.test(watchReason);
  if (verdict === 'WATCH_VOL' && socialBreakout && highTierSafe && watchIsRecoverable) {
    verdict       = 'BUY';
    entryTier     = 'BASELINE_ENTRY';
    watchReason   = null;
    socialUpgrade = true;
  }

  // ── RISKY RUNNER (v10.2.7: temporarily disabled) ──────────────────────────
  // The Grok social+pro-pilot override and the INFLATED→RISKY_RUNNER demotion
  // both produced false signals on obvious rugs in v10.2.6. Disabled until the
  // base scanner is reliable; inflated holders now go to NO_GO instead.
  let riskyRunnerReason = null;

  // INFLATED/BOTTED demotion: at any MC, synthetic holder count means the
  // BUY conviction is unearned. v10.2.6 demoted to RISKY_RUNNER; v10.2.7 → NO_GO.
  // (Gate 9 in the NO_GO ladder already covers MC<$100K; this catches MC>=$100K.)
  if (verdict === 'BUY' && holderHealthData?.label === 'INFLATED/BOTTED') {
    verdict      = 'NO_GO';
    noGoReason   = `INFLATED HOLDERS — Health ${holderHealthData.healthPct}% (>200%) — bot wallets suspected.`;
    headlineType = 'INFLATED';
    entryTier    = null;
  }

  // ── v10.2.7 invariant fuse (last line of defense) ─────────────────────────
  // Even if some future change (a new override block, a refactor) re-introduces
  // a path that lets BUY slip past Spine Lock, these invariants force the
  // verdict back to WATCH_VOL. Treat any trip here as a bug.
  if (verdict === 'BUY') {
    let invariantFail = null;
    if (top10Pct !== null && top10Pct > 15)                  invariantFail = `INVARIANT: top10 ${top10Pct.toFixed(1)}% > 15`;
    else if (momentumStatus === 'LOWER_RANGE')               invariantFail = `INVARIANT: momentum LOWER_RANGE`;
    else if (momentumStatus === 'VOLUMETRIC_DISTRIBUTION')   invariantFail = `INVARIANT: momentum VOLUMETRIC_DISTRIBUTION`;
    else if (washPct !== null && washPct > 30)               invariantFail = `INVARIANT: wash ${washPct.toFixed(0)}% > 30`;
    else if (holderHealthData?.label === 'INFLATED/BOTTED')  invariantFail = `INVARIANT: INFLATED/BOTTED holders`;
    if (invariantFail) {
      console.error(`[scanner] ${invariantFail} — forcing BUY → WATCH_VOL (bug in upstream verdict logic)`);
      verdict       = 'WATCH_VOL';
      entryTier     = null;
      watchReason   = `${invariantFail} — verdict downgraded by safety invariant.`;
      socialUpgrade = false;
    }
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
