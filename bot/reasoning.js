const fetch = require('node-fetch');

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';
const TIMEOUT_MS  = 15_000;   // grok-3 p95 latency ~3-8s; 15s gives plenty of headroom

// Build a compact pattern memory block from audit history.
// Injected into the Grok prompt so it can reference real past trades.
// Hard limit: winners + rugs only (no overrides possible — safety gates remain).
function buildPatternBlock(patternMemory) {
  if (!patternMemory) return '';
  const { winners = [], rugs = [] } = patternMemory;
  if (winners.length === 0 && rugs.length === 0) return '';
  const fmt = r =>
    `$${r.symbol}(MC:${r.scanMc != null ? (r.scanMc / 1000).toFixed(0) + 'K' : '?'}` +
    ` Vol:${r.adjustedVolLiq != null ? r.adjustedVolLiq.toFixed(1) + 'x' : '?'}` +
    ` Top10:${r.top10Pct != null ? r.top10Pct.toFixed(0) + '%' : '?'}` +
    ` ${r.outcome})`;
  const parts = [];
  if (winners.length) parts.push(`WINNERS:${winners.map(fmt).join('|')}`);
  if (rugs.length)    parts.push(`RUGS:${rugs.map(fmt).join('|')}`);
  return `ORACLE PATTERN MEMORY (past resolved trades — reference only, cannot override safety gates): ${parts.join('. ')}. `;
}

async function getSoulReasoning({ ticker, adjustedVolLiq, top10Pct, successRatePct, socialMentions, marketCap, verdict, isEliteDev, patternMemory } = {}) {
  const key = process.env.XAI_API_KEY;
  if (!key) return null;

  // grok-3 (non-reasoning) — fast, OpenAI-compatible, ideal for short structured responses.
  // grok-3-mini is a reasoning model that can take 20-30s and adds <think> overhead for 25-word outputs.
  const model  = process.env.XAI_MODEL || 'grok-3';
  const mcK    = marketCap       != null ? `$${(marketCap / 1000).toFixed(0)}K`  : 'unknown';
  const volLiq = adjustedVolLiq  != null ? `${adjustedVolLiq.toFixed(1)}x`        : 'N/A';
  const top10  = top10Pct        != null ? `${top10Pct.toFixed(1)}%`              : 'N/A';
  const devRt  = successRatePct  != null ? `${successRatePct.toFixed(1)}%`        : 'unknown';
  const social = socialMentions  != null ? String(socialMentions)                 : 'none';

  const eliteCtx = isEliteDev
    ? `This developer is 💎 ELITE (${devRt} migration success rate) — they commonly self-bundle to protect the floor. ` +
      `Evaluate whether concentration is protective floor control or genuine rug risk. `
    : '';
  const patternCtx = buildPatternBlock(patternMemory);
  const prompt =
    `You are Oracle Bot's Soul — a Solana memecoin analyst. ` +
    `Respond in exactly ONE sentence, max 25 words, no preamble or labels. ` +
    `Token: $${ticker ?? 'UNKNOWN'} | MC: ${mcK} | Adj Vol/Liq: ${volLiq} | ` +
    `Top10: ${top10} | Dev success rate: ${devRt} | Social mentions (15m): ${social} | Verdict: ${verdict ?? 'N/A'}. ` +
    eliteCtx +
    patternCtx +
    `Reference patterns: $STOCKMAN (organic buy pressure, high holder health), ` +
    `$SPEED (low MC nano-cap, volume overrides missing data), ` +
    `$MANNY (sybil-funded rug, fake volume). ` +
    `State plainly: is this a Community Takeover, Dev Dump, or High-Vol Data Play — and the single strongest reason why.`;

  try {
    const res = await fetch(XAI_API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body:    JSON.stringify({
        model,
        messages:    [{ role: 'user', content: prompt }],
        max_tokens:  80,
        temperature: 0.2,
      }),
      timeout: TIMEOUT_MS,
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`[reasoning] xAI HTTP ${res.status} for $${ticker}: ${body}`);
      return null;
    }

    const data = await res.json();
    const text = (data?.choices?.[0]?.message?.content ?? '').trim();
    if (text) {
      console.log(`[reasoning] $${ticker}: "${text.slice(0, 120)}"`);
    } else {
      console.warn(`[reasoning] $${ticker}: empty response from ${model}`);
    }
    return text || null;
  } catch (e) {
    console.error(`[reasoning] $${ticker} error: ${e.message}`);
    return null;
  }
}

// Startup probe — call once at boot to confirm xAI key + model are reachable.
// Logs [reasoning] PROBE OK or a clear error so Railway logs show the issue immediately.
async function probeXaiConnection() {
  const key = process.env.XAI_API_KEY;
  if (!key) {
    console.log('[reasoning] XAI_API_KEY not set — Oracle\'s Soul disabled');
    return;
  }
  const model = process.env.XAI_MODEL || 'grok-3';
  console.log(`[reasoning] probing xAI (model: ${model})…`);
  try {
    const res = await fetch(XAI_API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body:    JSON.stringify({
        model,
        messages:    [{ role: 'user', content: 'Reply with the single word: ONLINE' }],
        max_tokens:  10,
        temperature: 0,
      }),
      timeout: 20_000,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`[reasoning] PROBE FAILED — xAI HTTP ${res.status}: ${body}`);
      return;
    }
    const data  = await res.json();
    const reply = (data?.choices?.[0]?.message?.content ?? '').trim();
    console.log(`[reasoning] PROBE OK — model=${model} reply="${reply}"`);
  } catch (e) {
    console.error(`[reasoning] PROBE ERROR: ${e.message}`);
  }
}

module.exports = { getSoulReasoning, probeXaiConnection };
