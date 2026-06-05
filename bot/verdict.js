const config = require('./config');
const { actionTimeLine } = require('./time');
const { dataUsedHtml } = require('./telemetry');
const {
  resolveTraderClass,
  confidenceFromResult,
  shortRisk,
  whyRunText,
  whyFailText,
  oracleReadText,
  setupTagsFromResult,
  friendlyBlueprintActionLabel,
} = require('./trader-ui');
const { evaluateEntryValidity, entryLabel } = require('./entry-validity');

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

function liquidityDisplay(signals = {}) {
  if (Number(signals.lp || 0) <= 0 && !signals.isPostCurve) {
    if (Number(signals.marketCap || 0) > 0) return `Curve / pre-migration (MC proxy ${fmtUsd(signals.marketCap)})`;
    return 'Curve / pre-migration';
  }
  return fmtUsd(signals.lp);
}
function recommendedSizing(result) {
  const cls = String(result?.oracleScore?.class || result?.verdict || '').toUpperCase();
  const signals = result?.signals || {};
  const blueprint = result?.blueprintMatch || null;
  if (blueprint?.matched || blueprint?.action === 'BLOCK') {
    const action = String(blueprint.action || '').toUpperCase();
    const hasHardBlocks = (blueprint.hardBlocks || []).length > 0 || (result?.oracleScore?.hardBlocks || []).length > 0;
    if (hasHardBlocks || action === 'BLOCK') {
      return { size: '0 SOL', label: 'track-only — blueprint blocked by hard risk' };
    }
    if (action === 'BLUEPRINT_SCOUT') {
      const sol = Number(blueprint.confidence || 0) >= 0.78
        ? config.BLUEPRINT_SCOUT_STRONG_SIZE_SOL
        : config.BLUEPRINT_SCOUT_SIZE_SOL;
      return { size: sol.toFixed(2) + ' SOL', label: `${friendlyBlueprintActionLabel(action)} — controlled-dirty runner blueprint` };
    }
    if (action === 'BLUEPRINT_HOT_WATCH') {
      return { size: config.BLUEPRINT_HOT_WATCH_SIZE_SOL.toFixed(2) + ' SOL max', label: `${friendlyBlueprintActionLabel(action)} — scout only / high risk` };
    }
    if (action === 'EXTREME_CONCENTRATION_SCOUT' || action === 'HIGH_VOL_LOW_LP_SCOUT') {
      return { size: config.BLUEPRINT_HOT_WATCH_SIZE_SOL.toFixed(2) + '-' + config.BLUEPRINT_SCOUT_SIZE_SOL.toFixed(2) + ' SOL max', label: `${friendlyBlueprintActionLabel(action)} — scout only / forced track` };
    }
    if (action === 'LOTTO_WATCH') {
      return { size: 'track-only', label: `${friendlyBlueprintActionLabel(action)} — audit only, no Hunt sizing` };
    }
  }
  if (cls === 'ORACLE_BUY' || result?.verdict === 'BUY') {
    const hasHardBlocks = (result?.oracleScore?.hardBlocks || []).length > 0;
    const proposed = Number(result?.positionSizeSol != null ? result.positionSizeSol : config.SESSION_SIZE_SOL);
    if (!(proposed > 0) && !hasHardBlocks) {
      return { size: String(config.SESSION_SIZE_SOL) + ' SOL', label: 'ORACLE_BUY' };
    }
    return { size: (proposed > 0 ? String(proposed) : '0') + ' SOL', label: 'ORACLE_BUY' };
  }
  if (cls === 'MISSED_WINNER_MATCH' || result?.verdict === 'MISSED_WINNER_MATCH') {
    const strong = !!result?.missedWinnerMatch?.strong;
    const sol = strong ? config.MISSED_WINNER_MATCH_STRONG_SIZE_SOL : config.MISSED_WINNER_MATCH_SIZE_SOL;
    return { size: sol.toFixed(2) + ' SOL', label: 'TRADEABLE SCOUT — proven winner-family match' };
  }
  if (cls === 'DIRTY_RUNNER_WATCH' || result?.verdict === 'DIRTY_RUNNER_WATCH') {
    const trackOnly = !!signals.sybilFunded || (signals.washPct ?? 0) > 35 || (signals.top10Pct ?? 0) > 50;
    return {
      size: trackOnly ? 'track-only' : config.DIRTY_RUNNER_MIN_SIZE_SOL.toFixed(2) + '-' + config.DIRTY_RUNNER_MAX_SIZE_SOL.toFixed(2) + ' SOL',
      label: 'HIGH RISK WATCH — not clean enough for full confidence',
    };
  }
  if (cls === 'PEARL_WATCH' || result?.verdict === 'PEARL_WATCH') {
    return { size: 'track/chart/tiny scout only', label: 'PEARL_WATCH' };
  }
  if (['NO_GO', 'AVOID', 'SKIP'].includes(cls) || ['NO_GO', 'AVOID', 'SKIP'].includes(String(result?.verdict || '').toUpperCase())) {
    return { size: '0 SOL', label: 'No position' };
  }
  return { size: config.DIRTY_RUNNER_MIN_SIZE_SOL.toFixed(2) + ' SOL', label: 'watchlist / discretionary' };
}

function formatShortCard(result, ca) {
  const signals = result?.signals || {};
  const rawClass = String(result?.oracleScore?.class || result?.verdict || 'WATCH');
  const scoreRaw = result?.oracleScore?.total;
  const score = scoreRaw != null && Number.isFinite(Number(scoreRaw))
    ? `${Math.round(Number(scoreRaw))}/100`
    : 'N/A';
  let traderClass = resolveTraderClass(rawClass, scoreRaw);
  if (traderClass.key === 'MONSTER' && Number(signals.adjustedVolLiq || 0) < 5) {
    traderClass = resolveTraderClass('PEARL_WATCH', scoreRaw);
  }
  const sizing = recommendedSizing(result);
  if ((sizing.size === '0 SOL' || sizing.size === '0') && ['MONSTER', 'RUNNER'].includes(traderClass.key)) {
    traderClass = resolveTraderClass('NO_GO', scoreRaw);
  }
  const confidence = `${confidenceFromResult(result).toFixed(1)}/10`;
  const setupTags = setupTagsFromResult(result);
  const ageMinutes = signals.ageMinutes != null ? `${Math.round(Number(signals.ageMinutes))}m` : 'N/A';
  const mainRisk = shortRisk(result);
  const runLine = whyRunText(result);
  const failLine = whyFailText(result);
  const oracleRead = oracleReadText(traderClass.key);
  const entryState = evaluateEntryValidity({
    firstSeenMc: result?.firstSeenMc ?? signals.marketCap,
    alertMc: result?.alertMc ?? signals.marketCap,
    currentMc: signals.marketCap,
    peakMc: result?.peakMc ?? result?.currentPeakMc ?? signals.marketCap,
    momentumStrength: Number(signals.adjustedVolLiq || 0) >= 5 ? 3 : Number(signals.adjustedVolLiq || 0) >= 2.5 ? 2 : 1,
    structureStrength: Number(signals.top10Pct || 100) <= 45 ? 3 : 1,
    healthIntact: !signals.sybilFunded && (signals.washPct == null || signals.washPct <= 30),
  });
  const lines = [];
  lines.push(actionTimeLine(result?.context === 'hunt' ? 'Hunt Time' : 'Scan Time', result?.scannedAt || Date.now()));
  lines.push('');
  lines.push('🎯 ' + b('ORACLE SIGNAL'));
  lines.push('');
  lines.push(b('Class:') + ' ' + b(traderClass.label));
  lines.push(b('Score:') + ' ' + b(score));
  lines.push(b('Move Potential:') + ' ' + b(traderClass.movePotential));
  lines.push(b('Confidence:') + ' ' + b(confidence));
  lines.push(b(entryLabel(entryState)));
  lines.push('');
  lines.push(b('Setup:'));
  if (setupTags.length) {
    for (const tag of setupTags) lines.push(esc(tag));
  } else {
    lines.push('🔵 Developing / wait for confirmation');
  }
  lines.push('');
  lines.push(b('Core:'));
  lines.push(`MC: ${fmtUsd(signals.marketCap)}`);
  if (Number(signals.lp || 0) <= 0 && !signals.isPostCurve) {
    lines.push(`LP: Curve / pre-migration`);
    if (Number(signals.marketCap || 0) > 0) lines.push(`Curve Liquidity: MC proxy ${fmtUsd(signals.marketCap)}`);
  } else {
  lines.push(`LP: ${liquidityDisplay(signals)}`);
  }
  lines.push(`Vol/Liq: ${fmt(signals.adjustedVolLiq, 2)}x`);
  lines.push(`Wash: ${fmtPct(signals.washPct, 0)}`);
  lines.push(`Top10: ${fmtPct(signals.top10Pct, 1)}`);
  lines.push(`Bundle: ${signals.bundleCount ?? 0}/slot`);
  lines.push(`Age: ${ageMinutes}`);
  lines.push('');
  lines.push(b('Main Risk:'));
  lines.push(esc(mainRisk));
  lines.push('');
  lines.push(b('Why It Could Run:'));
  lines.push(esc(runLine));
  lines.push('');
  lines.push(b('Why It Could Fail:'));
  lines.push(esc(failLine));
  lines.push('');
  lines.push(b('Oracle Read:'));
  lines.push(esc(oracleRead));
  lines.push('');
  lines.push('CA: ' + code(ca));
  return lines.join('\n');
}

// ── Verdict header ────────────────────────────────────────────────────────────

function tierName(t) {
  switch (t) {
    case 'SCRIBBLI':        return 'SCRIBBLI (50x+ Adjusted)';
    case 'PLUTO':           return 'PLUTO CANDIDATE (12x+ Adjusted)';
    case 'HIGH_CONVICTION': return 'HIGH CONVICTION (8x+ Adjusted)';
    case 'BASELINE_ENTRY':  return 'BUY CANDIDATE (5x+ Adjusted)';
    case 'ELITE_DIP':       return 'ELITE DIP - BUY THE DIP';
    case 'NANO_CAP':        return 'NANO-CAP SNIPE (8x+ Adjusted)';
    default:                return '—';
  }
}
function tierPositionLabel(entryTier, _positionUnits, slippageWarn) {
  if (entryTier === 'SCRIBBLI') return slippageWarn ? '1.0 unit ⚠️ LP thin' : '2.0 units';
  switch (entryTier) {
    case 'PLUTO':           return '2.0 units';
    case 'HIGH_CONVICTION': return '1.5 units';
    case 'BASELINE_ENTRY':  return '1.0 unit';
    case 'ELITE_DIP':       return '0.75 unit';
    case 'NANO_CAP':        return '0.5 unit';
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
  // Velocity suffix: how much of the last hour's volume landed in the most recent 5m candle.
  // ≥25% = accelerating (2× the average 5m slice absorbed in one candle).
  // ≥10% = normal flow. <10% = fading interest.
  let velSuffix = '';
  if (birdeye?.volAccel != null) {
    const pct = birdeye.volAccel * 100;
    if      (pct >= 25) velSuffix = ` | 🔥 ${pct.toFixed(0)}% vel`;
    else if (pct >= 10) velSuffix = ` | ⚡ ${pct.toFixed(0)}% vel`;
    else                velSuffix = ` | 💤 ${pct.toFixed(0)}% vel`;
  }
  switch (momentumStatus) {
    case 'VOLUMETRIC_DISTRIBUTION': return `🔴 DISTRIBUTION${range5m}${velSuffix} — high vol, falling price`;
    case 'HEALTHY_DIP':             return `♻️ RECYCLE OPPORTUNITY${range5m}${velSuffix} — dip with buy-side dominance`;
    case 'TOP_QUARTER':             return `🟢 BREAKOUT (${rangePctDisp} of 1H range)${range5m}${velSuffix}`;
    case 'LOWER_RANGE':             return `🟡 STALLED (${rangePctDisp} of 1H range)${range5m}${velSuffix}`;
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

function formatVerdict(result, ca, options = {}) {
  const mode = String(options.mode || "full").toLowerCase();
  if (mode === "short") return formatShortCard({ ...result, context: options.context }, ca);
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

  L.push(actionTimeLine('Scan Time', result.scannedAt || Date.now()));
  L.push('');

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
    const buyTitle = signals.proPilotBuffer ? 'BUY CANDIDATE — PRO PILOT BUFFER' : (signals.isEliteDev && entryTier === 'BASELINE_ENTRY' ? 'BUY CANDIDATE — ELITE DEV BUFFER' : 'BUY CANDIDATE — 5x+ ADJUSTED');
    L.push(`${b(buyTitle)} — ${positionSizeSol} SOL (${tierPositionLabel(entryTier, positionUnits, scribbliSlippageWarning)})${bufferNote}${socialNote}${socialCtoNote}`);
  } else if (verdict === 'DIRTY_RUNNER_WATCH' || result.oracleScore?.class === 'DIRTY_RUNNER_WATCH') {
    L.push(`⚠️ ${b('DIRTY RUNNER WATCH — NOT A CLEAN BUY')}`);
    L.push(`Original verdict: ${b(result.verdict || 'WATCH')}`);
    const flags = [
      signals.washPct != null ? `wash ${fmtPct(signals.washPct, 0)}` : null,
      signals.top10Pct != null ? `top10 ${fmtPct(signals.top10Pct, 1)}` : null,
      signals.bundleCount != null ? `slot ${signals.bundleCount}/slot` : null,
    ].filter(Boolean).join(', ');
    L.push(`Risk flags: ${esc(flags || 'elevated concentration / runner profile')}`);
    L.push(`Why shown: ${esc(result.blueprintMatch?.reason || result.patternMatch?.reason || 'matched dirty-runner pattern with sufficient confidence')}`);
    L.push(`Sizing: scout only / human discretion`);
  } else if (verdict === 'PEARL_WATCH' || result.oracleScore?.class === 'PEARL_WATCH') {
    L.push(`🦪 ${b('PEARL WATCH — EARLY SENDOR FORMING')}`);
    L.push(`Action: track/chart first, tiny scout only. No blind chase.`);
    L.push(`Reason: ${esc(result.watchReason || result.pearlWatch?.reason || 'early expansion traits active with controlled risk')}`);
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
  if (result.oracleScore) {
    L.push(`Oracle Score: ${b(`${result.oracleScore.total}/100`)} | Class: ${b(result.oracleScore.class)}`);
    if (result.oracleScore.hardBlocks?.length) {
      L.push(`Hard blocks: ${esc(result.oracleScore.hardBlocks.join(', '))}`);
    }
    if (result.oracleScore.softWarnings?.length) {
      L.push(`Soft warnings: ${esc(result.oracleScore.softWarnings.slice(0, 4).join(', '))}`);
    }
  }
  if (result.blueprintMatch?.matched || result.blueprintMatch?.action === 'BLOCK') {
    L.push(`Blueprint: ${b(friendlyBlueprintActionLabel(result.blueprintMatch.action))} | ${esc((result.blueprintMatch.matches || []).slice(0, 4).join(', ') || 'NONE')} | confidence ${fmt(result.blueprintMatch.confidence, 2)}`);
  }
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
    // v37.2: sample size must gate trust labels. A 1/2 or 2/5 deployer can show
    // a huge percentage by luck; scanner treats <15 launches as unproven too.
    const flag = dp.totalLaunches < 5  ? ' ⚪ TOO SMALL SAMPLE'
               : dp.totalLaunches < 15 ? ' 🟡 UNPROVEN SAMPLE'
               : pct < 0.5             ? ' 🔴 ZERO SURVIVAL'
               : pct < 5               ? ' 🟡 NETWORK AVERAGE'
               : pct < 15              ? ' 🟢 PRO PILOT'
               :                          ' 💎 ELITE DEPLOYER';
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
      if (healthPct >= 200 && signals.isEliteDev) { label = 'PRO-CONTROLLED FLOOR'; icon = '💎'; }
      else if (healthPct >= 200)                  { label = 'OVERDISTRIBUTED / BOT-LIKELY'; icon = '🔴'; }
      else if (healthPct >= 50)                   { label = 'PASS (floor)';                 icon = '✅'; }
      else                                        { label = 'UNVERIFIED';                   icon = '⚪'; }
      holderDisplay = `≥${effectiveCount} | Health: ≥${healthPct}% ${icon} ${esc(label)} (target ~${target})`;
    } else {
      if (healthPct < 50)                         { label = 'LOW ORGANIC';                  icon = '🟡'; }
      else if (healthPct > 200 && signals.isEliteDev) { label = 'PRO-CONTROLLED FLOOR';     icon = '💎'; }
      else if (healthPct > 200)                   { label = 'OVERDISTRIBUTED / BOT-LIKELY'; icon = '🔴'; }
      else                                        { label = 'PASS';                         icon = '✅'; }
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

  // v37.0: MC-aware top10 display mirrors scanner hard caps.
  const top10Threshold = (mc != null && mc < 100_000)
    ? signals.isEliteDev ? 45 : signals.isProPilot ? 42 : 40
    : 25;
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

  // ── SOCIAL INTELLIGENCE (SocialData — always shown when available) ──────────
  const social = result.social ?? null;
  if (social?.available) {
    const trendIcon    = social.isTrending ? '🔥' : '🟡';
    const trendLabel   = social.isTrending ? 'SOCIAL BREAKOUT' : 'NEUTRAL';
    const velocityNote = social.isTrending ? ' ↗ Trending' : '';
    L.push(b('── SOCIAL INTELLIGENCE ──'));
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
              : dv.action === 'SKIPPED'   ? '⚪ SKIPPED'
              :                             '⚪ UNAVAILABLE';
    L.push(b('── VERIFICATION ──'));
    L.push(`• ${b('DeFade:')} ${tag}`);
    L.push(`• ${b('Reason:')} ${esc(dv.reason || 'n/a')}`);
    L.push('');
  }

  // ── TRUST STATUS ─────────────────────────────────────────────────────────
  const oracleClass = result.oracleScore?.class || (verdict === 'BUY' ? 'ORACLE_BUY' : verdict);
  const coreScanner = oracleClass === 'ORACLE_BUY'
    ? '✅ VALID'
    : oracleClass === 'DIRTY_RUNNER_WATCH' || String(verdict).startsWith('WATCH')
      ? '⚠️ WATCH'
      : '🚫 NO-GO';
  const requiredStack = result.requiredStack?.pass ? '✅ PASS' : '🔴 FAIL';
  const paidVerification = !dv || dv.action === 'SKIPPED'
    ? '⚪ SKIPPED'
    : dv.action === 'PASS'
      ? '✅ VERIFIED'
      : dv.action === 'UNAVAILABLE' || dv.action === 'NOT_INDEXED'
        ? '⚪ OPTIONAL OFFLINE'
        : dv.action === 'AUTH_FAIL' || dv.action === 'PLAN_RESTRICTED' || dv.action === 'HARD_SKIP'
          ? '🔴 FAIL'
          : '⚪ OPTIONAL OFFLINE';
  const reasoningStatus = result.soulVerdict?.available
    ? '✅ GROK ONLINE'
    : (config.GROK_REQUIRED_FOR_BUY ? '⚪ OFFLINE' : '⚪ NOT REQUIRED');
  const apiIntegrity = (() => {
    const used = result.dataUsed || {};
    const statuses = Object.values(used).map(v => typeof v === 'object' ? String(v.status || '') : (v ? 'ok' : 'failed'));
    const fail = statuses.filter(st => st === 'failed').length;
    const ok = statuses.filter(st => st === 'ok').length;
    if (fail === 0 && ok >= 4) return '✅ FULL';
    if (fail <= 2) return '🟡 PARTIAL';
    return '🔴 DEGRADED';
  })();
  L.push(b('── TRUST STATUS ──'));
  L.push(`Core Scanner: ${coreScanner}`);
  L.push(`Required Stack: ${requiredStack}`);
  L.push(`Paid Verification: ${paidVerification}`);
  L.push(`Reasoning Layer: ${reasoningStatus}`);
  L.push(`API Integrity: ${apiIntegrity}`);
  L.push('');

  // ── LIVE METRICS ──────────────────────────────────────────────────────────

  L.push(b('── LIVE METRICS ──'));
  L.push(`• ${b('MC:')} ${fmtUsd(mc)} | ${b('LP:')} ${liquidityDisplay(signals)} | ${b('Vol 1h:')} ${fmtUsd(signals.volume1h)}`);
  L.push(`• ${b('Price:')} $${signals.priceUsd != null ? signals.priceUsd.toFixed(8) : 'N/A'} | ${b('1H \u0394:')} ${fmtChange(signals.change1h)}`);
  L.push(`• ${b('Age:')} ${signals.ageMinutes != null ? signals.ageMinutes + 'min' : 'N/A'} | ${b('Buys/Sells:')} ${signals.buyCount ?? 'N/A'}/${signals.sellCount ?? 'N/A'}`);
  L.push('');

  // ── TPs (class-calibrated) ───────────────────────────────────────────────

  if (oracleClass === 'ORACLE_BUY' || oracleClass === 'DIRTY_RUNNER_WATCH' || oracleClass === 'MISSED_WINNER_MATCH' || verdict === 'BUY' || verdict === 'DIRTY_RUNNER_WATCH' || verdict === 'MISSED_WINNER_MATCH') {
    L.push(b('── TAKE PROFITS ──'));
    if (oracleClass === 'MISSED_WINNER_MATCH' || verdict === 'MISSED_WINNER_MATCH') {
      L.push('TP1: 2x');
      L.push('TP2: 5x');
      L.push('TP3: 10x');
      L.push('Trail: 25–35% Guardian Peak retrace');
      L.push(`Sizing: ${recommendedSizing(result).size} scout`);
    } else if (oracleClass === 'DIRTY_RUNNER_WATCH' || verdict === 'DIRTY_RUNNER_WATCH') {
      L.push('TP1: 2x');
      L.push('TP2: 5x');
      L.push('TP3: 10x');
      L.push('Trail: 25–35% Guardian Peak retrace');
      L.push(`Sizing: ${recommendedSizing(result).size}`);
      if (signals.isSerialDeployer) {
        L.push('Serial deployer note: faster TP cadence, smaller scout, moonbag only after principal removed');
      }
    } else if (mc > 0 && mc < 50000) {
      L.push('TP1: $100K');
      L.push('TP2: $250K');
      L.push('TP3: $500K');
      L.push('TP4: $1M');
      L.push('Moonbag: 10–20%');
    } else if (mc >= 50000 && mc <= 100000) {
      L.push('TP1: 2x');
      L.push('TP2: 5x');
      L.push('TP3: 10x');
      L.push('TP4: $1M if momentum holds');
      L.push('Moonbag: 10–20%');
    } else {
      L.push(`TP1: ${fmtUsd(config.TP1_MC)}`);
      L.push(`TP2: ${fmtUsd(config.TP2_MC)}`);
      L.push(`TP3: ${fmtUsd(config.TP3_MC)}`);
    }
    L.push('');
  }

  if (result.dataUsed) {
    L.push('');
    L.push(`<b>── DATA USED ──</b>`);
    L.push(dataUsedHtml(result.dataUsed));

    L.push('');
    L.push(b('── REQUIRED STACK ──'));
    L.push(result.dataUsed.dex?.status === 'ok' ? '✅ Dex' : '🔴 Dex');
    L.push(result.dataUsed.solanaTracker?.status === 'ok' ? '✅ SolanaTracker' : '🔴 SolanaTracker');
    L.push(result.dataUsed.socialData?.status === 'ok' ? '✅ SocialData' : '🔴 SocialData');
    L.push(!(result.oracleScore?.hardBlocks || []).includes('confirmed_sybil') ? '✅ Bundle Heuristic' : '🔴 Bundle Heuristic');
    L.push(`Result: ${result.requiredStack?.pass ? '✅ REQUIRED STACK PASS' : `🔴 REQUIRED STACK FAIL (${esc((result.requiredStack?.reasons || []).join(', '))})`}`);

    L.push('');
    L.push(b('── OPTIONAL STACK ──'));
    L.push('⚪ Birdeye skipped: hunt hard block');
    if (dv && (dv.action === 'PASS' || dv.action === 'FLAG')) L.push('✅ DeFade verified optional');
    else if (dv && dv.action === 'HARD_SKIP') L.push('🔴 DeFade hard fail');
    else L.push('⚪ DeFade skipped/offline optional');
    L.push('⚪ GMGN audit-only');
    L.push(`⚪ Codex ${config.CODEX_MODE === 'off' ? 'off' : 'optional'}`);
    L.push(`⚪ RugCheck ${config.RUGCHECK_MODE}`);
    if (result.soulVerdict?.available) L.push('✅ Grok');
    else L.push(config.GROK_REQUIRED_FOR_BUY ? '🔴 Grok required missing' : '⚪ Grok not required');
  }

  L.push(`CA: ${code(ca)}`);
  return L.join('\n');
}

module.exports = { formatVerdict };
