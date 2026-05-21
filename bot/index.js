require('dotenv').config();
const { Telegraf } = require('telegraf');
const { fetchAll, fetchDeFadeVerification } = require('./fetcher');
const { scan }     = require('./scanner');
const { formatVerdict } = require('./verdict');
const tracker = require('./tracker');
const hunt    = require('./hunt');
const config  = require('./config');

if (!config.TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set. Exiting.');
  process.exit(1);
}

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

function isSolanaCA(text) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(text.trim());
}

// ── Inline keyboard for each scan result ─────────────────────────────────────

function buildKeyboard(ca, currentMc) {
  const mc = Math.floor(currentMc || 0);
  return {
    inline_keyboard: [[
      { text: '➕ TRACK', callback_data: `track:${ca}:${mc}` },
      { text: '📈 CHART', url: `https://dexscreener.com/solana/${ca}` },
      { text: '🐦 X SEARCH', url: `https://x.com/search?q=${ca}&src=typed_query` },
    ]],
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────

bot.start(ctx => ctx.replyWithHTML(
  `🚀 <b>Oracle Solana Bot</b>\n\nSend a contract address to scan.\n/help for commands.`
));

bot.help(ctx => ctx.replyWithHTML(
  `<b>Oracle Solana Bot v8.1 (Predator)</b>\n\nPaste any Solana CA to get a full Oracle Scorecard.\n\n` +
  `<b>Commands:</b>\n/start — welcome\n/help — this message\n/status — bot health\n` +
  `/tracking — list tracked positions\n/window — current thresholds\n` +
  `/hunt — 🎯 24/7 auto-scan new launches (vol/liq ≥ 5x only)\n` +
  `/unhunt — stop hunt mode\n/huntstatus — hunt diagnostics`
));

bot.command('status', ctx => {
  const h = hunt.status();
  const huntLine = h.connected
    ? `🎯 Hunt: <b>ACTIVE</b> | ${h.hunters} hunter(s) | scanned ${h.scanned} | broadcast ${h.broadcast} | queue ${h.queueDepth}`
    : `🎯 Hunt: <b>OFFLINE</b> (reconnecting)`;
  return ctx.replyWithHTML(
    `<b>Bot Status: ONLINE</b>\n\nData: DexScreener | PumpPortal | Birdeye | Helius${process.env.DEFADE_API_KEY ? ' | DeFade' : ''}\n` +
    `Guardian: ${tracker.list().length} position(s) tracked\nSession: ${config.SESSION_SIZE_SOL} SOL\n${huntLine}`
  );
});

bot.command('hunt', ctx => {
  const added = hunt.addHunter(ctx.chat.id);
  return ctx.replyWithHTML(added
    ? `🎯 <b>Hunt Mode: ON</b>\nYou'll receive a full scorecard for every new launch / migration with Vol/Liq ≥ 5x.\nSilent below that threshold.\nUse /unhunt to stop.`
    : `🎯 Hunt Mode already <b>ON</b> for this chat. Use /unhunt to stop.`);
});

bot.command('unhunt', ctx => {
  const removed = hunt.removeHunter(ctx.chat.id);
  return ctx.reply(removed ? '🎯 Hunt Mode: OFF for this chat.' : 'Hunt Mode was not active for this chat.');
});

bot.command('huntstatus', ctx => {
  const h = hunt.status();
  const uptime = h.uptimeMs ? Math.floor(h.uptimeMs / 1000) + 's' : '—';
  const lastEv = h.lastEvent ? Math.floor((Date.now() - h.lastEvent) / 1000) + 's ago' : 'never';
  return ctx.replyWithHTML(
    `<b>Hunt Mode Diagnostics</b>\n\n` +
    `WS:       ${h.connected ? '🟢 CONNECTED' : '🔴 DISCONNECTED'}\n` +
    `Uptime:   ${uptime}\n` +
    `Hunters:  ${h.hunters}\n` +
    `Last event: ${lastEv}\n\n` +
    `<b>Lifetime stats</b>\n` +
    `Scanned:   ${h.scanned}\n` +
    `Broadcast: ${h.broadcast} (vol/liq ≥ 5x)\n` +
    `Skipped:   ${h.skipped}\n` +
    `Errors:    ${h.errors}\n` +
    `Queue:     ${h.queueDepth} pending | ${h.activeScans} running\n\n` +
    `You: ${hunt.isHunter(ctx.chat.id) ? '🎯 hunting' : '⚪ not hunting (/hunt to enable)'}`
  );
});

bot.command('tracking', ctx => {
  const positions = tracker.list();
  if (!positions.length) return ctx.reply('No positions currently tracked.');
  const lines = positions.map((p, i) =>
    `${i+1}. <code>${p.ca.slice(0,8)}...</code> — entry MC: $${(p.entryMc/1000).toFixed(1)}K | peak: $${(p.peakMc/1000).toFixed(1)}K`
  );
  return ctx.replyWithHTML(`<b>Tracked Positions (${positions.length}):</b>\n\n${lines.join('\n')}`);
});

bot.command('window', ctx => {
  const h = new Date().getUTCHours();
  const etOffset = new Date().getUTCMonth() + 1 >= 3 && new Date().getUTCMonth() + 1 <= 11 ? -4 : -5;
  const etHour = (h + 24 + etOffset) % 24;
  const window = etHour >= 2 && etHour < 12 ? 'DISCOVERY' : etHour >= 12 && etHour < 19 ? 'DEAD_ZONE' : 'RESEARCH';
  return ctx.replyWithHTML(
    `<b>Scan Thresholds</b>\n\nLP min: $${config.LP_MIN_USD.toLocaleString()}\nAge max: ${config.AGE_MAX_MIN}min\n` +
    `Vol/Liq: ${window === 'DEAD_ZONE' ? '8x' : '5x'} (${window})\nTop 10 max: ${config.TOP10_MAX_PCT}%\n` +
    `Curve max: ${config.CURVE_MAX_PCT}% (hard skip: ${config.CURVE_HARD_SKIP_PCT}%)\nSession: ${config.SESSION_SIZE_SOL} SOL\n\n` +
    `<b>TPs (${window === 'DEAD_ZONE' ? 'Dead Zone' : 'Normal'}):</b>\n` +
    `TP1 → ${window === 'DEAD_ZONE' ? '$50K' : '$100K'} MC\nTP2 → $250K MC\nTP3 → $500K MC\n\n` +
    `Time Mode: <b>${window}</b> (ET hour ${etHour})`
  );
});

// ── CA scan handler ───────────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  const tokens = text.split(/\s+/);
  const ca = tokens.find(t => isSolanaCA(t));
  if (!ca) return ctx.reply('Send a valid Solana contract address (32–50 base58 chars).');

  const scanning = await ctx.replyWithHTML(`🔍 Scanning <code>${ca}</code>...`);

  try {
    const data = await fetchAll(ca);

    if (!data.codex && !data.pump) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, scanning.message_id, undefined,
        `No data found for <code>${ca}</code>. Check the address and try again.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const result  = scan(data);

    // Post-scan DeFade verification — only on BUY candidates (free-plan quota).
    if (result.verdict === 'BUY') {
      const v = await fetchDeFadeVerification(ca, { lp: result.signals?.lp });
      result.deFadeVerification = v;
      if (v.action === 'HARD_SKIP') {
        result.verdict = 'NO_GO';
        result.entryTier = null;
        result.noGoReason = `DeFade verification: ${v.reason}`;
      }
    }

    const message = formatVerdict(result, ca);
    const mc      = result.signals.marketCap || 0;

    await ctx.telegram.editMessageText(
      ctx.chat.id, scanning.message_id, undefined,
      message,
      {
        parse_mode: 'HTML',
        reply_markup: buildKeyboard(ca, mc),
      }
    );
  } catch (err) {
    console.error('[scan error]', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, scanning.message_id, undefined,
      `Error scanning <code>${ca}</code>: ${err.message}`,
      { parse_mode: 'HTML' }
    );
  }
});

// ── Inline button callbacks ───────────────────────────────────────────────────

bot.on('callback_query', async ctx => {
  const data = ctx.callbackQuery?.data || '';

  if (data.startsWith('track:')) {
    const parts = data.split(':');
    const ca    = parts[1];
    const mc    = parseFloat(parts[2]) || 0;

    // Quick re-scan to get entryTier and timeWindow
    let entryTier = null, timeWindow = 'DISCOVERY';
    try {
      const scanData = await fetchAll(ca);
      const result   = scan(scanData);
      entryTier  = result.entryTier;
      timeWindow = result.timeWindow;
    } catch (_) {}

    const added = tracker.track(ca, ctx.chat.id, mc, entryTier, timeWindow);
    const shortCa = `${ca.slice(0,6)}...${ca.slice(-4)}`;

    if (added) {
      await ctx.answerCbQuery(`✅ Tracking ${shortCa} — Guardian active`);
      await ctx.telegram.sendMessage(
        ctx.chat.id,
        `🔔 *Oracle Guardian activated*\nTracking \`${shortCa}\`\nEntry MC: $${(mc/1000).toFixed(1)}K\n\nI'll alert you on exit triggers every 60s.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      const reason = tracker.list().length >= 10
        ? 'max 10 positions reached'
        : 'already tracking this token';
      await ctx.answerCbQuery(`⚠️ ${reason}`);
    }
  }
});

// ── Launch ────────────────────────────────────────────────────────────────────

bot.launch()
  .then(() => {
    console.log('Oracle Bot started');
    tracker.startTracker(bot);
    hunt.start(bot, buildKeyboard);
  })
  .catch(err => {
    console.error('Failed to launch bot:', err.message);
    process.exit(1);
  });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
