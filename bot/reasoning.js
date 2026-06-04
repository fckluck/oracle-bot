const fetch = require('node-fetch');
const { markApi } = require('./telemetry');
const config = require('./config');

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';
const TIMEOUT_MS  = 15_000;

const HALL_OF_FAME = `
WINNERS (Blueprint Signatures):
- $!ng: Elite Dev, 36% Top10, 9x organic vol -> $2M ATH. Key: high concentration + elite profile.
- $SOREN: Elite Dev, 34% Top10, 14x vol -> $650K ATH. Key: same controlled-floor pattern.
- $ballish: Elite Dev, 31% Top10, 15x vol -> $313K ATH. Key: trust the blueprint.
- $SPEED: $19K MC, 12x organic vol, unverified holders -> $230K ATH. Key: nano-cap vol was the signal.
- $GRAIL: Elite dev, high vol, managed concentration -> runner confirmed.
HALL OF SHAME (Rug Signatures):
- $MANNY: Inflated holders (>250% health), looked organic, was botted.
- $Bingus: Age >60m, MC <$30K, negative 1H, zero X mentions. Classic stale rug.
`;

const SYSTEM_PROMPT = `You are the Oracle Soul - a pattern-matching risk analyst.
Your job is to compare incoming token data to prior winner, prior rug/failure, or uncertain patterns.
You explain risk; you do not override scanner verdicts.
${HALL_OF_FAME}
RULES:
1. If it resembles a prior winner, say [ WINNER PATTERN ] and name the matching imprint.
2. If it resembles a rug/failure or scanner hard gate, say [ RISK PATTERN ] and explain the danger.
3. If the scanner hard gate is sybil bundle, wash fail, distribution, top10 fail, or LP fail, explicitly respect that gate.
4. If unclear, say [ UNCERTAIN PATTERN ] and give the strongest reason.
5. You may say SOUL OVERRIDE CANDIDATE for human review, but never claim to override hard gates.
6. Keep total response under 3 sentences. No bullet points. No forced bullishness.`;

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
