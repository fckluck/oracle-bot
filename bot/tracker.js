// Oracle Guardian — Real-time position tracker
// Polls each tracked CA every 60s and sends exit alerts via Telegram.

const { fetchAll } = require('./fetcher');
const { scan }     = require('./scanner');

const MAX_POSITIONS = 10;

// Map: ca -> { ca, chatId, entryMc, peakMc, trackedAt, entryTier, timeWindow }
const positions = new Map();

function track(ca, chatId, currentMc, entryTier, timeWindow) {
  if (positions.size >= MAX_POSITIONS) {
    console.log(`[tracker] max positions (${MAX_POSITIONS}) reached`);
    return false;
  }
  if (positions.has(ca)) return false; // already tracking
  positions.set(ca, {
    ca, chatId,
    entryMc:   currentMc,
    peakMc:    currentMc,
    trackedAt: Date.now(),
    entryTier: entryTier || 'UNKNOWN',
    timeWindow: timeWindow || 'DISCOVERY',
  });
  console.log(`[tracker] tracking ${ca.slice(0,8)}... chatId=${chatId} mc=${currentMc}`);
  return true;
}

function untrack(ca) {
  return positions.delete(ca);
}

function list() {
  return [...positions.values()];
}

function fmtUsd(n) {
  if (!n) return 'N/A';
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

async function checkPosition(pos, bot) {
  try {
    const data = await fetchAll(pos.ca);
    if (!data.codex) return;
    const result = scan(data);
    const sig = result.signals;

    // Update ATH
    if (sig.marketCap && sig.marketCap > pos.peakMc) pos.peakMc = sig.marketCap;

    const slPct = pos.timeWindow === 'DEAD_ZONE' ? 25 : 50;
    const alerts = [];

    // Exit trigger 1: Vol/Liq decay
    if (sig.volLiq !== null && sig.volLiq < 2.0) {
      alerts.push(`⚠️ *Vol/Liq Decay* — ${sig.volLiq.toFixed(2)}x (below 2x)\n→ *TRIM 75% NOW*`);
    }

    // Exit trigger 2: LP floor
    if (sig.lp > 0 && sig.lp < 5000) {
      alerts.push(`🚨 *LP Floor Hit* — ${fmtUsd(sig.lp)} (below $5K)\n→ *HARD EXIT 100%*`);
    }

    // Exit trigger 3: Moon bag SL — retrace from ATH
    if (pos.peakMc > 0 && sig.marketCap > 0) {
      const retracePct = ((pos.peakMc - sig.marketCap) / pos.peakMc) * 100;
      if (retracePct >= slPct) {
        alerts.push(`🔴 *SL Triggered* — ${retracePct.toFixed(1)}% retrace from ATH ${fmtUsd(pos.peakMc)}\n→ *EXIT MOON BAG (${slPct}% SL)*`);
        positions.delete(pos.ca); // auto-untrack after SL fires
      }
    }

    // Exit trigger 4: concentration spike (top10 > 25% — emergency)
    if (sig.top10Pct !== null && sig.top10Pct > 25) {
      alerts.push(`⚠️ *Concentration Spike* — Top 10: ${sig.top10Pct.toFixed(1)}% (> 25%)\n→ *Monitor closely*`);
    }

    if (alerts.length === 0) {
      console.log(`[tracker] ${pos.ca.slice(0,8)}... OK — MC=${fmtUsd(sig.marketCap)} Vol/Liq=${sig.volLiq?.toFixed(2)}x LP=${fmtUsd(sig.lp)}`);
      return;
    }

    const shortCa = `${pos.ca.slice(0,6)}...${pos.ca.slice(-4)}`;
    const header  = `🔔 *ORACLE GUARDIAN ALERT*\nCA: \`${shortCa}\` | MC: ${fmtUsd(sig.marketCap)} | LP: ${fmtUsd(sig.lp)}\n`;
    const msg = header + '\n' + alerts.join('\n\n');
    await bot.telegram.sendMessage(pos.chatId, msg, { parse_mode: 'Markdown' });

  } catch (e) {
    console.error(`[tracker] error checking ${pos.ca.slice(0,8)}:`, e.message);
  }
}

function startTracker(bot) {
  setInterval(async () => {
    if (positions.size === 0) return;
    console.log(`[tracker] Guardian poll — ${positions.size} position(s)`);
    const snapshot = [...positions.values()];
    for (const pos of snapshot) {
      await checkPosition(pos, bot);
      await new Promise(r => setTimeout(r, 2000)); // 2s gap between polls
    }
  }, 60000);
  console.log('[tracker] Oracle Guardian started — polling every 60s');
}

module.exports = { track, untrack, list, startTracker };
