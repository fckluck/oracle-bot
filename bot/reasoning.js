const fetch = require('node-fetch');

const XAI_API_URL = 'https://api.x.ai/v1/chat/completions';
const TIMEOUT_MS  = 8_000;

async function getSoulReasoning({ ticker, adjustedVolLiq, top10Pct, successRatePct, socialMentions, marketCap, verdict } = {}) {
  const key = process.env.XAI_API_KEY;
  if (!key) return null;

  const model  = process.env.XAI_MODEL || 'grok-3-mini';
  const mcK    = marketCap       != null ? `$${(marketCap / 1000).toFixed(0)}K`  : 'unknown';
  const volLiq = adjustedVolLiq  != null ? `${adjustedVolLiq.toFixed(1)}x`        : 'N/A';
  const top10  = top10Pct        != null ? `${top10Pct.toFixed(1)}%`              : 'N/A';
  const devRt  = successRatePct  != null ? `${successRatePct.toFixed(1)}%`        : 'unknown';
  const social = socialMentions  != null ? String(socialMentions)                 : 'none';

  const prompt =
    `You are Oracle Bot's Soul — a Solana memecoin analyst. ` +
    `Respond in exactly ONE sentence, max 25 words, no preamble or labels. ` +
    `Token: $${ticker ?? 'UNKNOWN'} | MC: ${mcK} | Adj Vol/Liq: ${volLiq} | ` +
    `Top10: ${top10} | Dev success rate: ${devRt} | Social mentions (15m): ${social} | Verdict: ${verdict ?? 'N/A'}. ` +
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
      console.error(`[reasoning] xAI HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      return null;
    }

    const data = await res.json();
    const text = (data?.choices?.[0]?.message?.content ?? '').trim();
    if (text) console.log(`[reasoning] $${ticker}: "${text.slice(0, 100)}"`);
    return text || null;
  } catch (e) {
    console.error('[reasoning] error:', e.message);
    return null;
  }
}

module.exports = { getSoulReasoning };
