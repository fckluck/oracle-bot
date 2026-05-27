const config = require('./config');

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function b(str)    { return `<b>${esc(str)}</b>`; }
function i(str)    { return `<i>${esc(str)}</i>`; }
function code(str) { return `<code>${esc(str)}</code>`; }

function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return 'N/A';
  return n.toLocaleString('en-US', { maximumFractionDigits: d });
}
function fmtUsd(n) {
  if (n == null || isNaN(n)) return 'N/A';
  if (n >= 1e6) return `$${fmt(n / 1e6, 2)}M`;
  if (n >= 1e3) return `$${fmt(n / 1e3, 1)}K`;
  return `$${fmt(n, 2)}`;
}
function fmtPct(n, d = 1) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${n.toFixed(d)}%`;
}
function fmtChange(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function fmtMult(n) {
  if (n == null || isNaN(n) || n <= 0) return 'N/A';
  if (n >= 100) return `${n.toFixed(0)}x`;
  if (n >= 10)  return `${n.toFixed(1)}x`;
  return `${n.toFixed(2)}x`;
}

// ── Verdict header ────────────────────────────────────────────────────────────

function tierName(t) {
  switch (t) {
    case 'SCRIBBLI':        return 'SCRIBBLI (50x+ Adjusted)';
    case 'PLUTO':           return 'PLUTO CANDIDATE (12x+ Adjusted)';
    case 'HIGH_CONVICTION': return 'HIGH CONVICTION (8x+ Adjusted)';
    case 'BASELINE_ENTRY':  return 'BUY CANDIDATE (5x+ Adjusted)';
    default:                return '—';
  }
}
function tierPositionLabel(entryTier, _positionUnits, slippageWarn) {
  if (entryTier === 'SCRIBBLI') return slippageWarn ? '1.0 unit ⚠️ LP thin' : '2.0 units';
  switch (entryTier) {
    case 'PLUTO':           return '2.0 units';
    case 'HIGH_CONVICTION': return '1.5 units';
    case 'BASELINE_ENTRY':  return '1.0 unit';
    default:                return '—';
  }
}

function getTpTargets(entryTier, timeWindow) {
  const isDead = timeWindow === 'DEAD_ZONE';
  if (entryTier === 'SCRIBBLI') {
    return { tp1: isDead ? 125000 : 250000, tp2: isDead ? 350000 : 500000,
             tp3: isDead ? 700000 : 1000000, slPct: isDead ? 25 : 50 };
  }
  return { tp1: isDead ? config.DEAD_ZONE_TP1_MC : config.TP1_MC,
           tp2: config.TP2_MC, tp3: config.TP3_MC, slPct: isDead ? 25 : 50 };
}

// ── Section helpers ───────────────────────────────────────────────────────────

function momentumDisplay(momentumStatus, birdeye) {
  const range5m = birdeye?.priceChange5m != null ? ` | 5m: ${fmtChange(birdeye.priceChange5m)}` : '';
  const rangePctDisp = birdeye?.rangePct != null ? `${(birdeye.rangePct * 100).toFixed(0)}%` : 'N/A';
  switch (momentumStatus) {
    case 'VOLUMETRIC_DISTRIBUTION': return `🔴 DISTRIBUTION${range5m} — high vol, falling price`;
    case 'HEALTHY_DIP':             return `♻️ RECYCLE OPPORTUNITY${range5m} — dip with buy-side dominance`;
    case 'TOP_QUARTER':             return `🟢 BREAKOUT (${rangePctDisp} of 1H range)${range5m}`;
    case 'LOWER_RANGE':             return `🟡 STALLED (${rangePctDisp} of 1H range)${range5m}`;
    default:                        return 'N/A (Birdeye candles unavailable)';
  }
}

function bundleDisplay(bundle) {
  if (!bundle) return 'N/A';
  if (bundle.sybilDetected) {
    return `⛔ SYBIL (${bundle.uniqueSigners} buyers, ${bundle.fundingSources} parent)`;
  }
  if (bundle.bundleDetected) return `⛔ BUNDLE (${bundle.maxInSlot}/slot)`;
  return `✅ CLEAN (max ${bundle.maxInSlot}/slot)`;
}

function parentFundingDisplay(bundle) {
  if (!bundle) return 'N/A';
  if (bundle.sybilDetected) return `⛔ SYBIL (${bundle.fundingSources} source → ${bundle.uniqueSigners} wallets)`;
  const traced = bundle.tracesResolved ?? 0;
  // ≥3 traces = high-confidence clean; 1-2 traces = partial but still evidence of diversity
  if (traced >= 3) return `✅ CLEAN (${traced} wallets traced, ${bundle.fundingSources} source(s))`;
  if (traced >= 1) return `✅ CLEAN (partial — ${traced} trace${traced > 1 ? 's' : ''}, no shared funder)`;
  return `⚪ UNRESOLVED (no traces completed)`;
}

function ctoStatusDisplay(ctoBehavior, walletAge) {
  const mins = walletAge?.minutesSinceLastTx;
  const lastActivity = mins != null ? ` (${mins}m idle)` : '';
  switch (ctoBehavior) {
    case 'CTO_CONFIRMED': return `✅ CTO CONFIRMED${lastActivity}`;
    case 'CTO_LIKELY':    return `🟡 CTO LIKELY${lastActivity}`;
    case 'CTO_PARTIAL':   return `🟡 CTO PARTIAL (no socials)${lastActivity}`;
    case 'DEV_ACTIVE':    return `🔴 DEV ACTIVE${lastActivity}`;
    default:              return `UNKNOWN${lastActivity}`;
  }
}

function washQualityDisplay(washPct) {
  if (washPct == null) return { qualityLine: '⚪ UNVERIFIED', icon: '⚪' };
  const icon  = washPct < 15 ? '✅' : washPct < 35 ? '🟡' : '🔴';
  const label = washPct < 15 ? 'ORGANIC' : washPct < 35 ? 'MIXED' : 'WASH-HEAVY';
  return { qualityLine: `${icon} ${label}`, icon };
}

// ── Main formatter (v8.4 Anti-Wash Predator) ──────────────────────────────────

function formatVerdict(result, ca) {
  const {
    verdict, entryTier, noGoReason, headlineType, watchReason, timeWindow,
    positionSizeSol, positionUnits, scribbliSlippageWarning,
    pressureLabel, momentumStatus, ctoBehavior,
    devProfile, signals,
    socialUpgrade, socialBreakout, socialCto, effectiveCto,
  } = result;

  const mc            = signals.marketCap;
  const adjustedVolLiq= signals.adjustedVolLiq;
  const rawVolLiq     = signals.rawVolLiq;
  const L = [];

  // ── Oracle's Soul (Grok reasoning — shown when XAI_API_KEY is configured) ──

  const soulReasoning = result.soulReasoning ?? null;
  if (soulReasoning) {
    L.push(`🧠 ${b('ORACLE\'S SOUL')}`);
    L.push(i(soulReasoning));  // i() already calls esc() internally — don't double-escape
    L.push('─────────────────────────────');
  }

  // ── Time-window banner ─────────────────────────────────────────────────────

  if (timeWindow === 'RESEARCH') {
    L.push(`🌙 ${b('RESEARCH MODE (7PM–2AM ET)')}`);
    L.push(`⚠️ Off-hours — elevated risk. Human override available.`);
    L.push('─────────────────────────────');
  } else if (timeWindow === 'DEAD_ZONE') {
    L.push(`☀️ ${b('DEAD ZONE (12PM–7PM ET)')}`);
    L.push(`ℹ️ Low-conviction window — TP1 $50K | SL 25% | Min 5x Adjusted`);
    L.push('─────────────────────────────');
  }

  // ── Header — kill-shot hierarchy ──────────────────────────────────────────

  if (verdict === 'NO_GO') {
    L.push(`🚫 ${b('ORACLE VERDICT: NO-GO')}`);
    L.push(`${esc(noGoReason)}`);
  } else if (verdict === 'AVOID') {
    L.push(`⛔ ${b('ORACLE VERDICT: AVOID')}`);
    L.push(`Momentum Fail — high vol, falling price (Distribution)`);
  } else if (verdict === 'WATCH_WASH') {
    L.push(`🟡 ${b('ORACLE VERDICT: WATCH — Wash Heavy')}`);
    L.push(`${esc(watchReason)}`);
  } else if (verdict === 'BUY') {
    L.push(`🚀 ${b(`ORACLE VERDICT: ${tierName(entryTier)}`)}`);
    const bufferNote  = signals.proPilotBuffer ? ` ${i('| PRO PILOT BUFFER (3x floor)')}` : '';
    const socialNote  = socialUpgrade          ? ` ${i('| SOCIAL BREAKOUT UPGRADE')}` : '';
    const socialCtoNote = !socialUpgrade && socialCto && effectiveCto ? ` ${i('| SOCIAL CTO DETECTED')}` : '';
    L.push(`${b('BUY CANDIDATE')} — ${positionSizeSol} SOL (${tierPositionLabel(entryTier, positionUnits, scribbliSlippageWarning)})${bufferNote}${socialNote}${socialCtoNote}`);
  } else if (verdict === 'WATCH_VOL') {
    L.push(`🟡 ${b('ORACLE VERDICT: WATCH — Volume Pending')}`);
    L.push(`${esc(watchReason)}`);
  } else if (verdict === 'RISKY_RUNNER') {
    L.push(`🟡 ${b('ORACLE VERDICT: RISKY RUNNER')}`);
    if (signals.riskyRunnerReason === 'DATA_PENDING_HIGH_VOL') {
      L.push(`Nano-cap entry — holder distribution unverified at ${fmtUsd(signals.marketCap)} MC. Organic Vol/Liq: ${b(signals.adjustedVolLiq.toFixed(1) + 'x')} (wash-corrected).`);
      L.push(`⚠️ ${i('API data incomplete. 0.5x size ONLY. Hard exit at TP1. Bundle and wash gates passed.')}`);
    } else if (signals.riskyRunnerReason === 'INFLATED_HOLDERS') {
      const hp = signals.holderHealth?.healthPct;
      L.push(`Holder count ${hp != null ? hp + '% of target' : 'inflated'} at ${fmtUsd(signals.marketCap)} MC — botted wallets suspected.`);
      L.push(`⚠️ ${i('Conviction demoted. 0.5x size only. Watch for organic holder growth.')}`);
    } else {
      L.push(`Social velocity + Pro Pilot override — underlying concern: ${esc(noGoReason || 'see details')}`);
      L.push(`⚠️ ${i('High-risk play. Reduce size 50%. Exit fast.')}`);
    }
  } else {
    L.push(`⬇️ ${b('ORACLE VERDICT: SKIP')}`);
    L.push(`Adjusted Vol/Liq ${adjustedVolLiq.toFixed(2)}x below 5x minimum`);
  }
  L.push(`Mode: ${b(timeWindow)}${timeWindow === 'DEAD_ZONE' ? ' ' + i('(TP1 $50K | SL 25% | Min 5x Adjusted)') : ''}`);
  L.push('');

  // ── VOLUME QUALITY ─────────────────────────────────────────────────────────

  const { qualityLine } = washQualityDisplay(signals.washPct);
  const washSrcLabel = signals.washSource
    ? (signals.washSource.startsWith('birdeye')
        ? `Birdeye ${signals.washSource.replace('birdeye-', '')} window`
        : 'SolanaTracker')
    : null;
  L.push(b('── VOLUME QUALITY ──'));
  L.push(`• ${b('Raw Vol/Liq:')} ${fmt(rawVolLiq, 2)}x`);
  if (signals.washPct != null) {
    const fakeAmt = signals.washVolumeUsd != null ? ` ($${Math.round(signals.washVolumeUsd).toLocaleString()})` : '';
    L.push(`• ${b('Fake Volume:')} ${fmtPct(signals.washPct, 0)}${fakeAmt} ✅`);
  } else {
    L.push(`• ${b('Fake Volume:')} ⚪ UNVERIFIED`);
  }
  L.push(`• ${b('Adjusted Vol/Liq:')} ${fmt(adjustedVolLiq, 2)}x`);
  const qualityVerified = washSrcLabel ? ` ${i('(Verified via ' + washSrcLabel + ')')}` : '';
  L.push(`• ${b('Quality:')} ${qualityLine}${qualityVerified}`);
  // Sniper / insider risk — only show when non-zero (avoids noise on clean tokens)
  const totalSniperRisk = (signals.snipersPct ?? 0) + (signals.insidersPct ?? 0);
  if (totalSniperRisk > 0) {
    const snip = signals.snipersPct > 0 ? `Snipers ${fmtPct(signals.snipersPct, 1)}` : null;
    const ins  = signals.insidersPct > 0 ? `Insiders ${fmtPct(signals.insidersPct, 1)}` : null;
    const parts = [snip, ins].filter(Boolean).join(' | ');
    const riskIcon = totalSniperRisk > 20 ? '🔴' : '🟡';
    L.push(`• ${b('Sniper Risk:')} ${riskIcon} ${parts}`);
  }
  L.push('');

  // ── CONVICTION ─────────────────────────────────────────────────────────────

  L.push(b('── CONVICTION ──'));
  L.push(`• ${b('Momentum:')} ${esc(momentumDisplay(momentumStatus, signals.birdeye))}`);
  L.push(`• ${b('Bundle:')} ${esc(bundleDisplay(signals.bundle))}`);
  L.push(`• ${b('Parent Funding:')} ${esc(parentFundingDisplay(signals.bundle))}`);
  L.push('');

  // ── ENTRY STRATEGY (BUY only) ──────────────────────────────────────────────
  // Uses 1H OHLCV range from Birdeye to compute Fibonacci 0.618 dip-buy target.
  // Zone B = (high1h - low1h) * 0.618 + low1h  (61.8% from low — optimal fill).
  // Safety floor = 1H Low. Invalidation below floor.

  if (verdict === 'BUY') {
    const birdeyeData = signals.birdeye;
    const high1h  = birdeyeData?.high1h  ?? null;
    const low1h   = birdeyeData?.low1h   ?? null;
    const px      = signals.priceUsd ?? 0;

    if (high1h != null && low1h != null && high1h > low1h && px > 0) {
      const zoneB = low1h + (high1h - low1h) * 0.618;
      const isBreakout = px >= zoneB;
      const statusLabel = isBreakout ? '🟢 BREAKOUT' : '🟡 RE-ACCUMULATING';

      // R:R relative to Zone B entry (capped to avoid nonsensical values)
      const riskToFloor  = Math.max(zoneB - low1h, 0);
      const rewardToHigh = Math.max(high1h - zoneB, 0);
      const rr = riskToFloor > 0 ? (rewardToHigh / riskToFloor) : null;
      const rrLabel = rr != null ? `1:${rr.toFixed(1)}` : 'N/A';

      // Verdict line
      let actionLabel;
      if (isBreakout) {
        actionLabel = 'Market Buy 50% here. Set limit for Zone B fill.';
      } else {
        actionLabel = 'Wait for Zone B fill. Heavy limit at optimal entry.';
      }

      const fmtPx = (n) => n < 0.001 ? n.toExponential(3) : n < 1 ? n.toFixed(5) : n.toFixed(4);

      L.push(b('── ENTRY STRATEGY ──'));
      L.push(`• ${b('Status:')} ${statusLabel}`);
      L.push(`• ${b('Zone A (Breakout Fill):')} $${fmtPx(px)} ${i('(current)')}`);
      L.push(`• ${b('Zone B (Optimal Dip):')} $${fmtPx(zoneB)} ${i('(Limit Order)')}`);
      L.push(`• ${b('Safety Floor:')} $${fmtPx(low1h)} — invalidation below`);
      L.push(`• ${b('Risk/Reward:')} ${rrLabel} ${i('(to 1H High)')}`);
      L.push(`• ${b('Verdict:')} ${esc(actionLabel)}`);
      L.push('');
    }
  }

  // ── DEV TRUST ─────────────────────────────────────────────────────────────

  const dp = devProfile;
  const walletShort = dp.wallet
    ? code(`${dp.wallet.slice(0,6)}...${dp.wallet.slice(-4)}`) : 'N/A';
  const topPerf = dp.topPerformerMultiplier != null
    ? fmtMult(dp.topPerformerMultiplier)
    : (dp.peakAssets != null && dp.peakAssets > 0
        ? `${dp.peakAssets} prior token(s), peak MC unknown`
        : 'N/A (no prior tokens indexed)');
  let successRate = 'N/A';
  if (dp.totalLaunches != null && dp.totalLaunches > 0) {
    const migrated = dp.migratedCount ?? 0;
    const pct = (migrated / dp.totalLaunches) * 100;
    const pctDisp = pct < 1 ? pct.toFixed(1) : Math.round(pct).toString();
    // v10.2.8: pump.fun network migration rate ~1.5% — tier labels reflect reality
    const flag = pct < 0.5  ? ' 🔴 ZERO SURVIVAL'
               : pct < 5    ? ' 🟡 NETWORK AVERAGE'
               : pct < 15   ? ' 🟢 PRO PILOT'
               :               ' 💎 ELITE DEPLOYER';
    successRate = `${migrated}/${dp.totalLaunches} (${pctDisp}%)${flag}`;
  } else if (dp.totalLaunches != null) {
    successRate = `0/${dp.totalLaunches} tokens (0%) 🔴 SERIAL RUGGER`;
  }

  L.push(b('── DEV TRUST ──'));
  L.push(`• ${b('Success Rate:')} ${esc(successRate)}`);
  if (signals.isSerialDeployer) {
    L.push(`• ${b('⚠️ Serial Deployer:')} ${dp.totalLaunches?.toLocaleString()} launches — elevated rug risk`);
  }
  L.push(`• ${b('Peak Performance:')} ${esc(topPerf)}`);
  L.push(`• ${b('Status:')} ${esc(ctoStatusDisplay(ctoBehavior, dp.walletAge))}`);
  L.push('');

  // ── SAFETY ────────────────────────────────────────────────────────────────

  let holderDisplay;
  const effectiveCount = signals.holderCount ?? signals.topAccountCount ?? null;
  const isFloor = signals.holderCount == null && signals.topAccountCount != null;
  // At MC < $100K, < 30% top10 is healthy (early float, concentrated holders normal)
  const isSmallCap = mc != null && mc < 100000;

  if (effectiveCount !== null && mc > 0) {
    const target    = Math.round((mc / 100000) * 400);
    const healthPct = Math.round((effectiveCount / target) * 100);
    let label, icon;
    if (isFloor) {
      if (healthPct >= 200)      { label = 'OVERDISTRIBUTED / BOT-LIKELY'; icon = '🔴'; }
      else if (healthPct >= 50)  { label = 'PASS (floor)';                 icon = '✅'; }
      else                       { label = 'UNVERIFIED';                   icon = '⚪'; }
      holderDisplay = `≥${effectiveCount} | Health: ≥${healthPct}% ${icon} ${esc(label)} (target ~${target})`;
    } else {
      if (healthPct < 50)        { label = 'LOW ORGANIC';                  icon = '🟡'; }
      else if (healthPct > 200)  { label = 'OVERDISTRIBUTED / BOT-LIKELY'; icon = '🔴'; }
      else                       { label = 'PASS';                         icon = '✅'; }
      holderDisplay = `${effectiveCount} | Health: ${healthPct}% ${icon} ${esc(label)} (target ~${target})`;
    }
  } else if (effectiveCount !== null) {
    holderDisplay = `${isFloor ? '≥' : ''}${effectiveCount} (MC unverified)`;
  } else if (signals.top10Pct !== null && isSmallCap && signals.top10Pct <= 30) {
    // No exact holder count, but top10 is clean on a small-cap — infer organic distribution
    holderDisplay = `UNVERIFIED count | ✅ ORGANIC DISTRIBUTION (Top10 ${fmtPct(signals.top10Pct)})`;
  } else {
    holderDisplay = 'UNVERIFIED';
  }

  // v12.0: MC-aware top10 threshold — 35% for sub-$100K, 25% above.
  const top10Threshold = (mc != null && mc < 100_000) ? 35 : 25;
  const top10Display = signals.top10Pct !== null
    ? `${fmtPct(signals.top10Pct)} (${esc(
        signals.top10Pct <= 15               ? 'CLEAN'    :
        signals.top10Pct <= top10Threshold   ? 'ELEVATED' : 'FAIL'
      )})`
    : `UNVERIFIED`;

  let curveDisplay;
  if (signals.curvePct !== null) {
    curveDisplay = `${fmtPct(signals.curvePct)}${signals.curvePct >= 90 ? ' ⚠️ MIGRATION GAP' : ''}`;
  } else if (signals.isPostCurve) {
    curveDisplay = '✅ MIGRATED (post-curve)';
  } else {
    curveDisplay = 'N/A';
  }

  L.push(b('── SAFETY ──'));
  L.push(`• ${b('Holders:')} ${holderDisplay}`);
  L.push(`• ${b('Top 10:')} ${top10Display}`);
  L.push(`• ${b('Curve:')} ${curveDisplay}`);
  L.push('');

  // ── GROK NARRATIVE (SocialData — always shown when available) ─────────────
  const social = result.social ?? null;
  if (social?.available) {
    const trendIcon    = social.isTrending ? '🔥' : '🟡';
    const trendLabel   = social.isTrending ? 'SOCIAL BREAKOUT' : 'NEUTRAL';
    const velocityNote = social.isTrending ? ' ↗ Trending' : '';
    L.push(b('── GROK NARRATIVE ──'));
    L.push(`• ${b('Social Velocity:')} ${trendIcon} ${social.mentions15m} mentions / 15m${velocityNote} | ${social.uniqueAccounts} unique accounts`);
    if (socialCto) {
      L.push(`• ${b('CTO Signal:')} ✅ SOCIAL VERIFIED (${social.ctoSignal ? '3+' : '0'} accounts calling takeover)`);
    }
    if (socialUpgrade) {
      L.push(`• ${b('Verdict Impact:')} ✅ WATCH → BUY CANDIDATE — social breakout confirmed volume intent`);
    } else if (social.isTrending && verdict !== 'BUY') {
      L.push(`• ${b('Verdict Impact:')} 🟡 Trending but math floor not met — monitor closely`);
    } else if (social.isTrending) {
      L.push(`• ${b('Verdict Impact:')} ✅ Narrative confirms volume`);
    } else {
      L.push(`• ${b('Verdict Impact:')} ⚪ No social breakout detected`);
    }
    L.push('');
  }

  // ── VERIFICATION (DeFade, BUY candidates only) ────────────────────────────
  const dv = result.deFadeVerification;
  if (dv) {
    const tag = dv.action === 'PASS'      ? '✅ PASS'
              : dv.action === 'FLAG'      ? '🟡 FLAG'
              : dv.action === 'HARD_SKIP' ? '🛑 HARD SKIP'
              :                             '⚪ UNAVAILABLE';
    L.push(b('── VERIFICATION ──'));
    L.push(`• ${b('DeFade:')} ${tag}`);
    L.push(`• ${b('Reason:')} ${esc(dv.reason || 'n/a')}`);
    L.push('');
  }

  // ── LIVE METRICS ──────────────────────────────────────────────────────────

  L.push(b('── LIVE METRICS ──'));
  L.push(`• ${b('MC:')} ${fmtUsd(mc)} | ${b('LP:')} ${fmtUsd(signals.lp)} | ${b('Vol 1h:')} ${fmtUsd(signals.volume1h)}`);
  L.push(`• ${b('Price:')} $${signals.priceUsd != null ? signals.priceUsd.toFixed(8) : 'N/A'} | ${b('1H \u0394:')} ${fmtChange(signals.change1h)}`);
  L.push(`• ${b('Age:')} ${signals.ageMinutes != null ? signals.ageMinutes + 'min' : 'N/A'} | ${b('Buys/Sells:')} ${signals.buyCount ?? 'N/A'}/${signals.sellCount ?? 'N/A'}`);
  L.push('');

  // ── TPs (BUY only) ────────────────────────────────────────────────────────

  if (verdict === 'BUY') {
    const tps = getTpTargets(entryTier, timeWindow);
    const m = (mc > 0) ? mc : 1;
    L.push(b('── TAKE PROFITS ──'));
    L.push(`TP1: ${fmtUsd(tps.tp1)}  (${(tps.tp1/m).toFixed(1)}x)`);
    L.push(`TP2: ${fmtUsd(tps.tp2)}  (${(tps.tp2/m).toFixed(1)}x)`);
    L.push(`TP3: ${fmtUsd(tps.tp3)}  (${(tps.tp3/m).toFixed(1)}x)`);
    L.push(`SL:  ${tps.slPct}% retrace from ATH | hard exit if LP &lt; $5K`);
    L.push('');
  }

  L.push(`CA: ${code(ca)}`);
  return L.join('\n');
}

module.exports = { formatVerdict };
