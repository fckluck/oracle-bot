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
  if (entryTier === 'ELITE_DIP') return 0.75; // 75% - elite dev dip entry
  if (entryTier === 'NANO_CAP') return 0.5; // Half-size - unverified holder data
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
  // v12.0 calibration: -5% threshold replaces "any negative". A 2-4% profit-taking
  // dip on a high-vol token is normal market action, not distribution. Sustained
  // selling (-5%+) at significant volume is the real DISTRIBUTION signal.
  if (priceChange5m !== null && priceChange5m < -5 && volLiq >= 8) {
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

  // v37.0: Pro Pilot requires 15+ launches for statistical significance.
  const successRatePct   = (devLaunches != null && devLaunches > 0 && migratedCount != null)
    ? (migratedCount / devLaunches) * 100 : null;
  const isUnproven       = devLaunches != null && devLaunches < 15;
  // v37.0: stale threshold is $100K MC and requires negative 1H change.
  // Flat/stable tokens keep elite/pro exemptions.
  const isStaleElite     = ageMins !== null && ageMins > 60
    && mc !== null && mc < 100_000
    && (codex?.change1h ?? 0) < 0;
  const isProPilot       = !isStaleElite && successRatePct != null && successRatePct > 5  && !isUnproven;
  // v37.0: Elite = >10% success rate OR previous peak >15x.
  const peakMultiplier   = stDeployer?.topPerformerMultiplier ?? devPeak?.topPerformerMultiplier ?? null;
  const isEliteDev       = !isStaleElite && devLaunches != null && devLaunches > 15 && (
    (successRatePct != null && successRatePct > 10) ||
    (peakMultiplier != null && peakMultiplier >= 15)
  );
  const isSerialDeployer = devLaunches !== null && devLaunches > 500;

  const holderCount     = holders?.holderCount     ?? null;
  const topAccountCount = holders?.topAccountCount ?? null;
  const top10Pct        = holders?.top10Pct        ?? null;
  const holderSource    = holders?.source          ?? null;

  // v37.0: controlled-floor calibration.
  // Elite: 45%. Pro Pilot: 42%. Unknown sub-$100K: 40%. Post-$100K: 25%.
  const top10HardMax = (mc != null && mc < 100_000)
    ? isEliteDev ? 45 : isProPilot ? 42 : 40
    : 25;

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
  // v10.2.8 null-wash fix: when both Birdeye AND SolanaTracker fail to return
  // wash data, treat volume as 20% suspect (conservative floor). Without this,
  // a token with fabricated volume + dead APIs appears 100% organic and can
  // artificially hit PLUTO/HIGH_CONVICTION tier purely from API failure.
  const WASH_UNVERIFIED_PCT = 20;
  const effectiveWashPct   = washPct != null ? washPct : WASH_UNVERIFIED_PCT;
  const organicVol     = vol1h > 0 ? vol1h * (1 - effectiveWashPct / 100) : 0;
  // Bonding-curve tokens (LP=0) have no Raydium pool yet — use market cap as the
  // effective liquidity denominator. vol/MC is numerically equivalent to vol/LP
  // at pump.fun graduation (LP ≈ MC at migration), so the same tier thresholds apply.
  const liquidityProxy = lp > 0 ? lp : (mc || 0);
  const adjustedVolLiq = liquidityProxy > 0 ? organicVol  / liquidityProxy : 0;
  const rawVolLiq      = liquidityProxy > 0 ? vol1h       / liquidityProxy : 0;

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

  // Social data is declared here so it's available to both the kill-shot hierarchy
  // (Social Necessity gate) and the Social Breakout upgrade block below.
  const social = data.social ?? null;

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
  // 3b. Social Necessity: >8x adjusted vol with zero social footprint = manufactured volume.
  // Real retail demand ALWAYS leaves tweets. High vol + silence = bot-wash trap.
  // Only fires when social data is confirmed available (available=true) to avoid
  // false-positives from API failures on genuine tokens.
  else if (adjustedVolLiq > 8 && social?.available === true
    && typeof social?.mentions15m === 'number' && social.mentions15m < 5) {
    noGoReason   = `WASH TRADE — ${adjustedVolLiq.toFixed(1)}x vol, <5 social mentions (bot-wash signature)`;
    headlineType = 'WASH';
  }
  // 4. Liquidity — for bonding-curve tokens LP=0, use MC as effective liquidity.
  // A token with LP=0 but MC >= LP_MIN_USD has enough curve liquidity to enter.
  else if (lp < config.LP_MIN_USD && !(lp === 0 && mc != null && mc >= config.LP_MIN_USD)) {
    noGoReason   = `Low Liquidity (${lp > 0 ? '$' + lp.toLocaleString() : (mc > 0 ? 'MC $' + mc.toLocaleString() : 'N/A')} < $${config.LP_MIN_USD.toLocaleString()})`;
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
  // 7b. Zero-Survival Deployer: 10+ launches with ZERO migrations = serial rug artist.
  // Even if vol looks good, a dev who has never graduated a single token is a hard skip.
  // Threshold: >10 launches (filters statistical noise — <10 is UNPROVEN, not PROVEN BAD).
  else if (devLaunches !== null && devLaunches > 10 && migratedCount !== null && migratedCount === 0) {
    noGoReason   = `RUGGER PROFILE — ${devLaunches} launches, 0 migrations (zero-survival dev)`;
    headlineType = 'DEPLOYER';
  }
  // 8. Concentration hard cap (v12.0: MC-aware threshold — 35% under $100K, 25% above)
  else if (top10Pct !== null && top10Pct > top10HardMax) {
    noGoReason   = `CONCENTRATION FAIL — Top10 ${top10Pct.toFixed(1)}% > ${top10HardMax}%`;
    headlineType = 'CONCENTRATION';
  }
  // 9. Botted/missing holders at sub-$100K MC.
  //    v12.0 exception: if MC < $40K AND adjusted vol/liq ≥ 8x AND data is merely
  //    unavailable (not proven botted at >250%), fall through to RISKY_RUNNER.
  //    Bundle, wash, and concentration gates above this still apply.
  else if (
    mc != null && mc < 100000 && (
      (holderHealthData?.healthPct != null && holderHealthData.healthPct > 250) ||
      holderHealthData?.healthPct == null
    )
  ) {
    // Nano-cap (<$25K): natural holder concentration means a handful of wallets
    // can dominate and inflate the health score without bot activity. Raise the
    // botted threshold to 400% to reduce false positives at this MC range.
    // Above $25K: standard 250% — enough MC to attract organic distribution.
    const bottedThreshold = (mc != null && mc < 25_000) ? 400 : 250;
    const isBotted = holderHealthData?.healthPct != null && holderHealthData.healthPct > bottedThreshold;
    // Bonding-curve tokens (LP=0): pump.fun coin API never exposes holder count,
    // so holder data is structurally unavailable — not an API failure. Extend the
    // RISKY_RUNNER exception to sub-$100K at the standard BUY floor (5x adjusted).
    // LP=0: pump.fun API never exposes holder count — structural, not API failure.
    //   → sub-$100K at 4x adjusted (all devs).
    // LP>0 (graduated): holder count missing = API lag.
    //   → Elite dev (>10% success, >15 launches): sub-$100K at 8x (same as LP=0 cap).
    //     $ชั้ง autopsy: $58K MC + 9x vol + elite dev → was hard NO-GO because LP>0
    //     cap was $40K. Raising to $100K for proven devs captures these plays as
    //     RISKY_RUNNER (half-size, exit by TP1) instead of silencing them entirely.
    //   → Unknown dev: keep $40K (API failure at sub-$40K nano-cap only).
    const riskyRunnerLpCap = lp === 0 ? 100_000
      : isEliteDev ? 100_000
      : 40_000;
    const riskyRunnerCandidate = !isBotted && mc != null && (
      mc < riskyRunnerLpCap && adjustedVolLiq >= (lp === 0 ? 4 : 8)
    );
    if (riskyRunnerCandidate) {
      // Fall through to verdict ladder; demoted to RISKY_RUNNER below.
    } else if (isBotted) {
      noGoReason   = `BOTTED WALLETS — Holder Health ${holderHealthData.healthPct}% at $${(mc/1000).toFixed(0)}K MC (>250% threshold)`;
      headlineType = 'INFLATED';
    } else {
      noGoReason   = `HOLDER DATA UNAVAILABLE — Cannot certify wallet quality at $${(mc/1000).toFixed(0)}K MC`;
      headlineType = 'INFLATED';
    }
  }

  // ── Verdict ladder (v10.2.7 — Spine Lock) ─────────────────────────────────
  // Tiered BUY now REQUIRES a multi-factor safety pass. v10.2.6 let high-vol
  // tokens with bad top10/wash/momentum still earn BUY via the "downgrade to
  // HIGH_CONVICTION" path. v10.2.7 routes failed safety to WATCH instead.
  let entryTier = null, verdict, watchReason = null;

  // Shared safety predicate for the high tiers (SCRIBBLI / PLUTO).
  // ALL of: momentum in top 25%, top10 < cap (MC-aware), wash < 20%,
  // bundle/parent clean, holder health sane, dev not active.
  const highTierSafe = (
    momentumStatus === 'TOP_QUARTER' &&
    (top10Pct === null || top10Pct < top10HardMax) && // v12.0: MC-aware cap (35% sub-$100K)
    (washPct === null || washPct < 20) &&
    bundleCount <= 10 &&
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
    // v37.0: Elite + 8x vol + distribution dip = BUY THE DIP signal.
    // 75% position size - dip confirmation reduces conviction slightly.
    if (isEliteDev && adjustedVolLiq >= 8) {
      entryTier = 'ELITE_DIP';
      verdict   = 'BUY';
    } else if (isEliteDev) {
      verdict     = 'WATCH_VOL';
      watchReason = `ELITE DIP — ${birdeye?.priceChange5m != null ? Math.abs(birdeye.priceChange5m).toFixed(1) + '%' : 'unknown'} 5m drop on ${adjustedVolLiq.toFixed(1)}x organic vol. Elite dev — but vol below 8x threshold. Confirm LP holding before entry.`;
    } else {
      verdict = 'AVOID';
    }
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
  } else if (mc != null && mc < 35_000 && adjustedVolLiq >= 8 && !noGoReason) {
    // v37.0 Nano-Cap Bridge: sub-$35K MC + 8x organic vol means volume is
    // the primary verification signal. Half-size entry, exit by TP1.
    entryTier    = 'NANO_CAP'; verdict = 'BUY';
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

  // ── 10-Minute Maturity Gate ────────────────────────────────────────────────
  // Scammers manufacture 12x "organic-looking" vol + 300 "community-looking"
  // holders in the first 3-5 minutes specifically to trigger sniper bots.
  // The wash and holder APIs need time to catch the pattern. Any BUY verdict
  // at >5x for a token under 10 minutes old is downgraded to WATCH_VOL.
  // Low-vol tokens (≤5x) are unaffected — they already land on WATCH/SKIP.
  if (verdict === 'BUY' && ageMins !== null && ageMins < 10 && adjustedVolLiq > 5) {
    verdict     = 'WATCH_VOL';
    entryTier   = null;
    watchReason = `MATURITY PENDING — ${ageMins.toFixed(1)} min old (need ≥10 min). Re-scan after the 10-min mark to confirm vol/liq is still holding.`;
  }

  // ── Social Breakout upgrade (additive, never lowers math floor) ───────────
  // Rules:
  //   1. WATCH_VOL (3x-5x) → BASELINE_ENTRY if social breakout detected
  //   2. Math floor stays locked: SKIP (<3x) cannot be upgraded regardless
  //   3. Hard NO_GO / AVOID / WATCH_WASH kills are never overridden
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
    !/momentum fail|safety failed|wash volume|maturity pending/i.test(watchReason);
  if (verdict === 'WATCH_VOL' && socialBreakout && highTierSafe && watchIsRecoverable) {
    verdict       = 'BUY';
    entryTier     = 'BASELINE_ENTRY';
    watchReason   = null;
    socialUpgrade = true;
  }

  let riskyRunnerReason = null;

  // INFLATED/BOTTED demotion: synthetic holder count means conviction is unearned.
  // Elite devs exempt from INFLATED demotion: self-bundled floor protection
  // routinely produces >200% holder health — it's a control mechanism, not botting.
  if (verdict === 'BUY' && holderHealthData?.label === 'INFLATED/BOTTED' && !isEliteDev) {
    verdict      = 'NO_GO';
    noGoReason   = `INFLATED HOLDERS — Health ${holderHealthData.healthPct}% (>200%) — bot wallets suspected.`;
    headlineType = 'INFLATED';
    entryTier    = null;
  }

  // v12.0 RISKY RUNNER: holder data unavailable + strong volume signal.
  // Two paths:
  //   LP=0 (bonding curve): sub-$100K + adjustedVolLiq ≥ 5x — pump.fun API never
  //     exposes holder count so this is structural, not an API failure.
  //   LP>0 (graduated): nano-cap (<$40K) + adjustedVolLiq ≥ 8x — API failure only.
  // Bundle, wash, concentration, and liquidity gates above still applied.
  // Position halved vs normal BUY; user must exit by TP1.
  // Elite dev LP>0 cap matches LP=0 ($100K) — same reasoning as riskyRunnerCandidate.
  const riskyRunnerTrip = holderCount === null && mc != null && (
    (lp === 0 && mc < 100_000 && adjustedVolLiq >= 4) ||
    (lp > 0  && (isEliteDev ? mc < 100_000 : mc < 40_000) && adjustedVolLiq >= 8)
  );
  if (verdict === 'BUY' && entryTier !== 'ELITE_DIP' && entryTier !== 'NANO_CAP' && riskyRunnerTrip) {
    verdict           = 'RISKY_RUNNER';
    riskyRunnerReason = 'DATA_PENDING_HIGH_VOL';
    entryTier         = null;
  }

  // ── v10.2.7 invariant fuse (last line of defense) ─────────────────────────
  // Even if some future change (a new override block, a refactor) re-introduces
  // a path that lets BUY slip past Spine Lock, these invariants force the
  // verdict back to WATCH_VOL. Treat any trip here as a bug.
  // v37.0: ELITE_DIP and NANO_CAP intentionally bypass selected standard
  // safety checks, while still respecting hard NO_GO gates above.
  if (verdict === 'BUY' && entryTier !== 'ELITE_DIP' && entryTier !== 'NANO_CAP') {
    let invariantFail = null;
    if (top10Pct !== null && top10Pct > top10HardMax)        invariantFail = `INVARIANT: top10 ${top10Pct.toFixed(1)}% > ${top10HardMax}`;
    else if (momentumStatus === 'LOWER_RANGE')               invariantFail = `INVARIANT: momentum LOWER_RANGE`;
    else if (momentumStatus === 'VOLUMETRIC_DISTRIBUTION')   invariantFail = `INVARIANT: momentum VOLUMETRIC_DISTRIBUTION`;
    else if (washPct !== null && washPct > 30)               invariantFail = `INVARIANT: wash ${washPct.toFixed(0)}% > 30`;
    else if (holderHealthData?.label === 'INFLATED/BOTTED' && !isEliteDev)  invariantFail = `INVARIANT: INFLATED/BOTTED holders`;
    // v10.2.8: sybil-funded wallets were missing from fuse — HIGH_CONVICTION
    // (8x-12x) doesn't check highTierSafe, so a sybil bundle with low wash
    // and low top10 could slip through to BUY. Catch it here as a last resort.
    else if (sybilFunded)                                    invariantFail = `INVARIANT: sybil-funded wallet detected`;
    // Maturity gate: belt-and-suspenders — the gate above runs before social
    // upgrade, but if any future path re-introduces BUY for a <10m token, catch it.
    else if (ageMins !== null && ageMins < 10 && adjustedVolLiq > 5)
                                                             invariantFail = `INVARIANT: maturity pending (age ${ageMins.toFixed(1)} min < 10m)`;
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
      isProPilot, isEliteDev, isUnproven, isSerialDeployer,
      totalLaunches: devLaunches, successRatePct, peakMultiplier, riskyRunnerReason,
      proPilotBuffer: isProPilot && adjustedVolLiq >= 3 && adjustedVolLiq < 5,
    },
  };
}

module.exports = { scan };
