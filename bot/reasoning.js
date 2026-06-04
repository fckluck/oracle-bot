const fetch = require('node-fetch');
const { markApi } = require('./telemetry');
const config = require('./config');

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';
const TIMEOUT_MS  = 15_000;

const HALL_OF_FAME = `
CONTROLLED-DIRTY WINNER SIGNATURES:
- Early MC $9K-$90K, adjusted Vol/Liq 4.25x-20x+, clean/tolerable wash, no confirmed sybil.
- Controlled concentration can be scoutable when Top10 is 31%-40% and organic demand is real.
- Elevated Top10 45%-58% is scout-only and needs strict clean wash, small bundle, holder sanity, and social confirmation.
- Moderate bundle 5-10/slot is tolerated only when adjusted Vol/Liq is strong and wash is clean.
RUG / FAILURE SIGNATURES:
- Confirmed sybil, wash >50%, malformed MC/liquidity, LP drain, holder collapse, or Top10 death-zone must be respected.
`;

const SYSTEM_PROMPT = `You are the Oracle Soul - a pattern-matching risk analyst.
Your job is to compare incoming token data to prior winner, prior rug/failure, or uncertain patterns.
You explain risk; you do not override scanner verdicts.
${HALL_OF_FAME}
RULES:
1. If a deterministic blueprint action exists, explain that action first.
2. If it resembles a rug/failure or scanner hard gate, say [ RISK PATTERN ] and explain the danger.
3. If the scanner hard gate is sybil bundle, wash fail, distribution, top10 fail, or LP fail, explicitly respect that gate.
4. Use fresh blueprint memory before stale Hall-of-Fame examples.
5. Do not mention removed failed/loss examples as positive winner comparables.
6. Grok does not override scanner or blueprint decisions; explanation and learning only.
7. If unclear, say [ UNCERTAIN PATTERN ] and give the strongest reason.
8. Keep total response under 3 sentences, and under 2 sentences for Hunt mode. No bullet points. No forced bullishness.`;

function parseSoulVerdict(text) {
  if (!text) return null;
  if (text.includes('WINNER PATTERN') || text.includes('BLUEPRINT MATCH: BUY')) return 'BUY';
  if (text.includes('RISK PATTERN') || text.includes('RUG PATTERN: SKIP')) return 'SKIP';
  if (text.includes('UNCERTAIN PATTERN') || text.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return null;
}

function buildPatternMemoryBlock(patternMemory) {
  if (!patternMemory) return '';

  const fmt = r => {
    const mc = r.scanMc != null ? `$${(r.scanMc / 1000).toFixed(0)}K` : 'unknown MC';
    const peak = r.peakMc != null ? `$${(r.peakMc / 1000).toFixed(0)}K` : 'unknown peak';
    const mult = r.scanMc > 0 && r.peakMc > 0 ? `${(r.peakMc / r.scanMc).toFixed(1)}x` : '?x';
    const vol = r.adjustedVolLiq != null ? `${r.adjustedVolLiq.toFixed(1)}x vol` : 'unknown vol';
    const top10 = r.top10Pct != null ? `${r.top10Pct.toFixed(0)}% top10` : 'unknown top10';
    return `$${r.symbol ?? r.ticker ?? '???'}: ${r.verdict}${r.entryTier ? '/' + r.entryTier : ''}, ${mc} → ${peak} (${mult}), ${vol}, ${top10}`;
  };

  const parts = [];

  const blueprintWinners = (patternMemory.blueprintWinners || []).filter(r =>
    String(r.symbol || r.ticker || '').toLowerCase() !== 'sigeonpex'
  );
  if (blueprintWinners.length) {
    const compact = blueprintWinners.slice(0, 12).map(r => {
      const mult = r.multiple != null ? `${r.multiple.toFixed(1)}x` : '?x';
      const matches = (r.blueprintMatches || []).slice(0, 3).join('+') || 'blueprint';
      const top10 = r.top10Pct != null ? `${r.top10Pct.toFixed(1)}% top10` : 'top10 N/A';
      const vol = r.adjustedVolLiq != null ? `${r.adjustedVolLiq.toFixed(1)}x vol` : 'vol N/A';
      const wash = r.washPct != null ? `${r.washPct.toFixed(1)}% wash` : 'wash N/A';
      const bundle = r.bundleCount != null ? `${r.bundleCount}/slot` : 'bundle N/A';
      return `$${r.symbol ?? r.ticker ?? '???'}: ${mult}, ${matches}, ${top10}, ${vol}, ${wash}, ${bundle}`;
    });
    parts.push(`BLUEPRINT WINNERS: ${compact.join(' | ')}`);
  }

  const missed = patternMemory.missedWinners3x || patternMemory.missedWinners || [];
  if (missed.length) {
    parts.push(`RECENT 3x+ MISSED WINNERS: ${missed.slice(0, 8).map(fmt).join(' | ')}`);
  }

  const monsters = patternMemory.monsterWinners10x || [];
  if (monsters.length) {
    parts.push(`RECENT 10x+ MONSTER WINNERS: ${monsters.slice(0, 8).map(fmt).join(' | ')}`);
  }

  const failed = patternMemory.recentFailedAlerts || patternMemory.rugs || [];
  if (failed.length) {
    parts.push(`RECENT FAILED ALERTS / FLAT-RUGS: ${failed.slice(0, 10).map(fmt).join(' | ')}`);
  }

  const winnerFp = patternMemory.winnerFingerprints || [];
  if (winnerFp.length) {
    const compact = winnerFp.slice(-8).map(fp =>
      `${fp.ticker || fp.symbol || '???'}(${fp.multiple != null ? fp.multiple.toFixed(1) + 'x' : '?x'}, top10 ${fp.top10Pct != null ? fp.top10Pct.toFixed(1) : 'N/A'}%, wash ${fp.washPct != null ? fp.washPct.toFixed(1) : 'N/A'}%, bundle ${fp.bundleCount ?? 'N/A'})`
    );
    parts.push(`WINNER-FAMILY FINGERPRINTS: ${compact.join(' | ')}`);
  }

  const failedFp = patternMemory.failedWarnings || patternMemory.failedFingerprints || [];
  if (failedFp.length) {
    const compact = failedFp.slice(0, 8).map(fp =>
      `${fp.ticker || fp.symbol || '???'}(${fp.outcome || 'UNKNOWN'}, reason: ${fp.failureReason || 'n/a'})`
    );
    parts.push(`FAILED-FINGERPRINT WARNINGS: ${compact.join(' | ')}`);
  }

  if (!parts.length) return '';

  return `\n\nLIVE ORACLE AUDIT MEMORY:\n${parts.join('\n')}\n`;
}

async function postGrok(messages, maxTokens = 150, temperature = 0.3) {
  const key = process.env.XAI_API_KEY;
  if (!key) return null;
  const model = config.XAI_MODEL || 'grok-4.3';
  const res = await fetch(XAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
    timeout: TIMEOUT_MS,
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (/model|unsupported|unknown model|does not exist|not found/i.test(body)) {
      const err = new Error(`MODEL_INVALID:${model}`);
      err.code = 'MODEL_INVALID';
      err.model = model;
      throw err;
    }
    throw new Error(`xAI HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

async function getSoulVerdict(scanResult, tokenData = {}) {
  if (!process.env.XAI_API_KEY) {
    markApi('Grok', { skipped: true, meta: { reason: 'missing_key' } });
    return {
      available: false,
      verdict: null,
      reasoning: '⚪ OFFLINE — XAI_API_KEY missing or billing unavailable. Scanner verdict only.',
    };
  }
  const { signals = {}, devProfile = {} } = scanResult;
  const blueprint = scanResult.blueprintMatch || {};
  const patternMemoryBlock = buildPatternMemoryBlock(tokenData.patternMemory ?? scanResult.patternMemory);
  const ticker = tokenData.codex?.symbol || tokenData.pump?.symbol || tokenData.symbol || 'UNKNOWN';
  const userMessage = `
Token Analysis Request:
- Token: $${ticker}
- Verdict from scanner: ${scanResult.verdict} (${scanResult.entryTier ?? 'N/A'})
- Market Cap: $${signals.marketCap?.toLocaleString() ?? 'unknown'}
- Adjusted Vol/Liq: ${signals.adjustedVolLiq?.toFixed(2) ?? 'N/A'}x
- Top 10 Concentration: ${signals.top10Pct?.toFixed(1) ?? 'N/A'}%
- Wash %: ${signals.washPct?.toFixed(1) ?? 'unverified'}%
- Dev Launches: ${devProfile.totalLaunches ?? signals.totalLaunches ?? 'unknown'}
- Dev Success Rate: ${signals.successRatePct != null ? signals.successRatePct.toFixed(1) + '%' : 'unknown'}
- Dev Peak Multiplier: ${devProfile.topPerformerMultiplier != null ? devProfile.topPerformerMultiplier + 'x' : (signals.peakMultiplier != null ? signals.peakMultiplier + 'x' : 'unknown')}
- Token Age: ${signals.ageMinutes?.toFixed(0) ?? 'unknown'} min
- Is Elite Dev: ${signals.isEliteDev}
- Bundle Count: ${signals.bundleCount ?? 0}/slot
- Social mentions (15m): ${scanResult.social?.mentions15m ?? tokenData.social?.mentions15m ?? 'N/A'}
- Deterministic Blueprint Action: ${blueprint.action ?? 'NONE'}
- Blueprint Matches: ${(blueprint.matches || []).join(', ') || 'none'}
- Blueprint Confidence: ${blueprint.confidence != null ? blueprint.confidence : 'N/A'}
- Blueprint Reason: ${blueprint.reason || 'none'}
- Scanner hard gate/reason: ${scanResult.noGoReason ?? scanResult.watchReason ?? scanResult.headlineType ?? scanResult.momentumStatus ?? 'none'}
Explain whether this is a prior winner pattern, rug/failure pattern, or uncertain pattern.
Question to answer directly: Does this token resemble recent missed winners more than recent failed alerts?
Respect scanner hard gates.`;

  try {
    const data = await postGrok([
      { role: 'system', content: SYSTEM_PROMPT + patternMemoryBlock },
      { role: 'user', content: userMessage },
    ]);
    const text = data?.choices?.[0]?.message?.content?.trim() ?? '';
    markApi('Grok', { ok: true, meta: { verdict: scanResult.verdict, hasReasoning: !!text } });
    return {
      available: true,
      verdict: parseSoulVerdict(text),
      reasoning: text || null,
    };
  } catch (err) {
    console.warn('[reasoning] Grok call failed:', err.message);
    if (err?.code === 'MODEL_INVALID') {
      markApi('Grok', { skipped: true, meta: { reason: 'invalid_model', model: err.model || config.XAI_MODEL } });
      return {
        available: false,
        verdict: null,
        reasoning: `⚪ OFFLINE — Grok model invalid: [${err.model || config.XAI_MODEL}]. Set XAI_MODEL.`,
      };
    }
    markApi('Grok', { ok: false, error: err.message });
    return {
      available: false,
      verdict: null,
      reasoning: `⚪ OFFLINE — Grok call failed: ${String(err.message).slice(0, 120)}. Scanner verdict only.`,
    };
  }
}

// Backward-compatible wrapper for older callers. It still returns a string so
// formatVerdict remains the single place that appends Soul text to alerts.
async function getSoulReasoning(args = {}) {
  const scanResult = {
    verdict: args.verdict,
    entryTier: args.entryTier,
    social: { mentions15m: args.socialMentions },
    signals: {
      adjustedVolLiq: args.adjustedVolLiq,
      top10Pct: args.top10Pct,
      successRatePct: args.successRatePct,
      marketCap: args.marketCap,
      isEliteDev: args.isEliteDev,
      peakMultiplier: args.peakMultiplier,
    },
    devProfile: {
      totalLaunches: args.devLaunches,
      topPerformerMultiplier: args.peakMultiplier,
    },
  };
  const soul = await getSoulVerdict(scanResult, {
    symbol: args.ticker,
    patternMemory: args.patternMemory,
  });
  return soul.reasoning;
}

async function probeXaiConnection() {
  if (!process.env.XAI_API_KEY) {
    console.log('[reasoning] XAI_API_KEY not set - Oracle Soul disabled');
    return;
  }
  const model = config.XAI_MODEL || 'grok-4.3';
  console.log(`[reasoning] probing xAI (model: ${model})...`);
  try {
    const data = await postGrok(
      [{ role: 'user', content: 'Reply with the single word: ONLINE' }],
      10,
      0
    );
    const reply = (data?.choices?.[0]?.message?.content ?? '').trim();
    console.log(`[reasoning] PROBE OK - model=${model} reply="${reply}"`);
  } catch (e) {
    console.error(`[reasoning] PROBE ERROR: ${e.message}`);
  }
}

module.exports = { getSoulVerdict, getSoulReasoning, probeXaiConnection };
