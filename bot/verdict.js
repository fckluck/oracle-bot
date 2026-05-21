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
    case 'SCRIBBLI':        return 'SCRIBBLI (50x+)';
    case 'PLUTO':           return 'PLUTO CANDIDATE (12x+, DeFade clean)';
    case 'HIGH_CONVICTION': return 'HIGH CONVICTION (8x+)';
    case 'BASELINE_ENTRY':  return 'BUY CANDIDATE (5x+)';
    case 'RISKY_RUNNER':    return 'RISKY RUNNER (vol override)';
    default:                return '—';
  }
}
function tierPositionLabel(entryTier, _positionUnits, slippageWarn) {
  if (entryTier === 'SCRIBBLI') return slippageWarn ? '1.0 unit ⚠️ LP thin' : '2.0 units';
  switch (entryTier) {
    case 'PLUTO':           return '2.0 units';
    case 'HIGH_CONVICTION': return '1.5 units';
    case 'BASELINE_ENTRY':  return '1.0 unit';
    case 'RISKY_RUNNER':    return '0.5 unit 🟡 half-size';
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

// ── Conviction section helpers ────────────────────────────────────────────────

function momentumDisplay(momentumStatus, birdeye) {
  const range5m = birdeye?.priceChange5m != null ? ` | 5m: ${fmtChange(birdeye.priceChange5m)}` : '';
  const rangePctDisp = birdeye?.rangePct != null ? `${(birdeye.rangePct * 100).toFixed(0)}%` : 'N/A';
  switch (momentumStatus) {
    case 'VOLUMETRIC_DISTRIBUTION': return `🔴 DISTRIBUTION${range5m} — high vol, falling price`;
    case 'TOP_QUARTER':             return `🟢 BREAKOUT (${rangePctDisp} of 1H range)${range5m}`;
    case 'LOWER_RANGE':             return `🟡 STALLED (${rangePctDisp} of 1H range)${range5m}`;
    default:                        return 'N/A (Birdeye candles unavailable)';
  }
}

function bundleDisplay(bundle) {
  if (!bundle) return 'N/A';
  if (bundle.sybilDetected) {
    return `⛔ SYBIL DETECTED (${bundle.uniqueSigners} buyers, ${bundle.fundingSources} parent)`;
  }
  if (bundle.bundleDetected) return `⛔ BUNDLE (${bundle.maxInSlot}/slot)`;
  return `✅ CLEAN (max ${bundle.maxInSlot}/slot)`;
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

// ── Main formatter (v6.0 — 3-pillar Scorecard) ───────────────────────────────

function formatVerdict(result, ca) {
  const {
    verdict, entryTier, noGoReason, watchReason, timeWindow,
    positionSizeSol, positionUnits, scribbliSlippageWarning,
    holderVerdictLabel, pressureLabel, momentumStatus, ctoBehavior,
    devProfile, signals,
  } = result;

  const mc     = signals.marketCap;
  const volLiq = signals.volLiq;
  const L = [];

  // ── Time-window informational banner (v6.2 — no longer gates output) ──────

  if (timeWindow === 'RESEARCH') {
    L.push(`🌙 ${b('RESEARCH MODE (7PM–2AM ET)')}`);
    L.push(`⚠️ Off-hours — elevated risk. Human override available.`);
    L.push('─────────────────────────────');
  } else if (timeWindow === 'DEAD_ZONE') {
    L.push(`☀️ ${b('DEAD ZONE (12PM–7PM ET)')}`);
    L.push(`ℹ️ Low-conviction window — stricter thresholds (Min 8x, TP1 $50K).`);
    L.push('─────────────────────────────');
  }

  // ── Header ────────────────────────────────────────────────────────────────

  if (verdict === 'NO_GO') {
    L.push(`🚫 ${b('ORACLE VERDICT: NO-GO')}`);
    L.push(`${esc(noGoReason)}`);
  } else if (verdict === 'AVOID') {
    L.push(`⛔ ${b('ORACLE VERDICT: AVOID')}`);
    L.push(`Volumetric Distribution — high vol with falling price`);
  } else if (verdict === 'BUY') {
    L.push(`🚀 ${b(`ORACLE VERDICT: ${tierName(entryTier)}`)}`);
    L.push(`${b('BUY CANDIDATE')} — ${positionSizeSol} SOL (${tierPositionLabel(entryTier, positionUnits, scribbliSlippageWarning)})`);
  } else if (verdict === 'WATCH_MOMENTUM') {
    L.push(`🟡 ${b('ORACLE VERDICT: WATCH — Momentum Stalled')}`);
    L.push(`${esc(watchReason)}`);
  } else if (verdict === 'WATCH_VOL') {
    L.push(`🟡 ${b('ORACLE VERDICT: WATCH — Volume Pending')}`);
    L.push(`${esc(watchReason)}`);
  } else if (verdict === 'WATCH_HOLDERS') {
    L.push(`🟡 ${b('ORACLE VERDICT: WATCH — Thin Distribution')}`);
    L.push(`${esc(watchReason)}`);
  } else {
    const minT = timeWindow === 'DEAD_ZONE' ? 8.0 : 5.0;
    L.push(`⬇️ ${b('ORACLE VERDICT: SKIP')}`);
    L.push(`Vol/Liq ${volLiq.toFixed(2)}x below ${minT}x minimum`);
  }
  L.push(`Mode: ${b(timeWindow)}${timeWindow === 'DEAD_ZONE' ? ' ' + i('(TP1 $50K | SL 25% | Min 8x)') : ''}`);
  L.push('');

  // ── CONVICTION ────────────────────────────────────────────────────────────

  L.push(b('── CONVICTION ──'));
  L.push(`• ${b('Momentum:')} ${esc(momentumDisplay(momentumStatus, signals.birdeye))}`);
  L.push(`• ${b('Vol/Liq:')} ${fmt(volLiq)}x`);
  L.push(`• ${b('Bundle:')} ${esc(bundleDisplay(signals.bundle))}`);
  L.push('');

  // ── DEV TRUST ─────────────────────────────────────────────────────────────

  const dp = devProfile;
  const walletShort = dp.wallet
    ? code(`${dp.wallet.slice(0,6)}...${dp.wallet.slice(-4)}`) : 'N/A';
  const ageStr = dp.walletAge?.ageDisplay || 'unknown age';
  const topPerf = dp.topPerformerMultiplier != null
    ? fmtMult(dp.topPerformerMultiplier)
    : (dp.peakAssets != null && dp.peakAssets > 0
        ? `${dp.peakAssets} prior token(s), peak MC unknown`
        : 'N/A (no prior tokens indexed)');
  const successRate = (dp.totalLaunches != null)
    ? `${dp.migratedCount ?? '?'}/${dp.totalLaunches} tokens`
    : 'N/A';

  L.push(b('── DEV TRUST ──'));
  L.push(`• ${b('Wallet:')} ${walletShort} ${esc('(' + ageStr + ')')}`);
  L.push(`• ${b('Top Performer:')} ${esc(topPerf)}`);
  L.push(`• ${b('Success Rate:')} ${esc(successRate)}`);
  L.push(`• ${b('Status:')} ${esc(ctoStatusDisplay(ctoBehavior, dp.walletAge))}`);
  L.push('');

  // ── SAFETY ────────────────────────────────────────────────────────────────

  // v8.1: Dynamic Holder Health — always render when we have any holder signal.
  // Prefer the full count; fall back to topAccountCount (Helius top-20 floor) so
  // the Health line still surfaces, just marked as a lower bound.
  let holderDisplay;
  const effectiveCount = signals.holderCount ?? signals.topAccountCount ?? null;
  const isFloor = signals.holderCount == null && signals.topAccountCount != null;

  if (effectiveCount !== null && mc > 0) {
    const target   = Math.round((mc / 100000) * 400);
    const healthPct = Math.round((effectiveCount / target) * 100);
    let label, icon;
    if (isFloor) {
      // We only know a floor, so we can only positively confirm INFLATED / PASS-floor.
      if (healthPct >= 200)      { label = 'INFLATED/BOTTED'; icon = '🔴'; }
      else if (healthPct >= 50)  { label = 'PASS (floor)';    icon = '✅'; }
      else                       { label = 'UNVERIFIED';      icon = '⚪'; }
      holderDisplay = `≥${effectiveCount} | Health: ≥${healthPct}% ${icon} ${esc(label)} (target ~${target}, full count N/A)`;
    } else {
      if (healthPct < 50)        { label = 'LOW ORGANIC';     icon = '🟡'; }
      else if (healthPct > 200)  { label = 'INFLATED/BOTTED'; icon = '🔴'; }
      else                       { label = 'PASS';            icon = '✅'; }
      holderDisplay = `${effectiveCount} | Health: ${healthPct}% ${icon} ${esc(label)} (target ~${target})`;
    }
  } else if (effectiveCount !== null) {
    holderDisplay = `${isFloor ? '≥' : ''}${effectiveCount} (MC unverified)`;
  } else {
    holderDisplay = 'UNVERIFIED';
  }
  const top10Display  = signals.top10Pct !== null
    ? `${fmtPct(signals.top10Pct)} (${esc(pressureLabel)})`
    : `UNVERIFIED (${esc(pressureLabel)})`;
  let curveDisplay;
  if (signals.curvePct !== null) {
    curveDisplay = `${fmtPct(signals.curvePct)}${signals.curvePct >= 90 ? ' ⚠️ MIGRATION GAP' : ''}`;
  } else if (signals.isPostCurve) {
    curveDisplay = '✅ MIGRATED (post-curve)';
  } else {
    curveDisplay = 'N/A';
  }

  // Bundle context — DeFade moved to its own VERIFICATION block below
  let bundleCtx;
  if (signals.isMeteora) {
    bundleCtx = `${signals.bundleCount ?? 0}/slot · 🌊 Meteora pool (auto-clean)`;
  } else {
    bundleCtx = `${signals.bundleCount ?? 0}/slot`;
  }

  L.push(b('── SAFETY ──'));
  L.push(`• ${b('Holders:')} ${holderDisplay}`);
  L.push(`• ${b('Top 10:')} ${top10Display}`);
  L.push(`• ${b('Bundle ctx:')} ${esc(bundleCtx)}`);
  L.push(`• ${b('Curve:')} ${curveDisplay}`);
  L.push('');

  // ── VERIFICATION (DeFade, verification-only) ──────────────────────────────
  // Only renders when DeFade was consulted (BUY candidates). Action ∈
  // PASS | FLAG | HARD_SKIP | UNAVAILABLE. HARD_SKIP downgrades verdict to
  // NO_GO upstream — so by the time we render here, verdict already reflects it.
  const dv = result.deFadeVerification;
  if (dv) {
    const tag = dv.action === 'PASS'        ? '✅ PASS'
              : dv.action === 'FLAG'        ? '🟡 FLAG'
              : dv.action === 'HARD_SKIP'   ? '🛑 HARD SKIP'
              :                               '⚪ UNAVAILABLE';
    L.push(b('── VERIFICATION ──'));
    L.push(`• ${b('DeFade:')} ${tag}`);
    L.push(`• ${b('Reason:')} ${esc(dv.reason || 'n/a')}`);
    L.push(`• ${b('Source:')} DeFade verification only`);
    L.push('');
  }

  // ── LIVE METRICS (compact footer) ─────────────────────────────────────────

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
