require('dotenv').config();
const { Telegraf } = require('telegraf');
const { fetchAll, fetchDeFadeVerification, fetchSocialData } = require('./fetcher');
const { scan }     = require('./scanner');
const { formatVerdict } = require('./verdict');
const tracker   = require('./tracker');
const hunt      = require('./hunt');
const watchlist = require('./watchlist');
const config    = require('./config');

if (!config.TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set. Exiting.');
  process.exit(1);
}

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

bot.catch((err, ctx) => {
  const updateType = ctx?.updateType || 'unknown';
  console.error(`[telegram] handler error during ${updateType}:`, err?.stack || err.message);
});

function isSolanaCA(text) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(text.trim());
}

// ── Inline keyboard for each scan result ─────────────────────────────────────

function buildKeyboard(ca, currentMc, verdict) {
  const mc = Math.floor(currentMc || 0);
  const rows = [[
    { text: '➕ TRACK', callback_data: `track:${ca}:${mc}` },
    { text: '📈 CHART', url: `https://dexscreener.com/solana/${ca}` },
    { text: '🐦 X SEARCH', url: `https://x.com/search?q=${ca}&src=typed_query` },
  ]];
  if (verdict === 'WATCH_VOL') {
    rows.push([{ text: '🔔 ALERT ON ENTRY GRADE', callback_data: `alert:${ca}:${mc}` }]);
  }
  return { inline_keyboard: rows };
}

// ── Commands ──────────────────────────────────────────────────────────────────

const HELP_MENU =
  `🛠️ <b>ORACLE COMMAND CENTER (v10.2.3)</b>\n` +
  `<i>The spine is aligned. The Predator is hunting.</i>\n\n` +
  `<b>── CORE ──</b>\n` +
  `• /start — Re-initialize the Oracle interface\n` +
  `• /help — Show this command menu\n` +
  `• /status — API + Guardian health snapshot\n\n` +
  `<b>── HUNT MODE (Automated) ──</b>\n` +
  `• /hunt — 🎯 <b>ACTIVATE 24/7 HUNTER.</b> Alerts on 5x+ Adjusted Vol/Liq launches\n` +
  `• /unhunt — Disable automated alerts\n` +
  `• /huntstatus — Live hunt diagnostics (scanned/broadcast/queue)\n` +
  `• /window — Current trading mode (Discovery / Dead Zone / Research)\n\n` +
  `<b>── POSITION TRACKING (Guardian) ──</b>\n` +
  `• /tracking — List all tracked tokens + live state\n` +
  `• /sync [CA] — Force-sync Guardian baseline if entry was missed\n` +
  `• /untrack [CA] — Stop monitoring a specific token\n\n` +
  `<b>── RESEARCH ──</b>\n` +
  `• /watchlist — Tokens being watched for Entry Grade activation\n` +
  `• <i>[Paste any CA]</i> — Full 10-gate forensic Oracle Scorecard\n\n` +
  `<i>Type /hunt to begin. 🔒🛡️🚀</i>`;

bot.start(ctx => ctx.replyWithHTML(HELP_MENU));
bot.help(ctx  => ctx.replyWithHTML(HELP_MENU));

bot.command('status', ctx => {
  const h = hunt.status();
  const huntLine = h.connected
    ? `🎯 Hunt: <b>${h.staleWs ? 'STALE' : 'ACTIVE'}</b> | ${h.hunters} hunter(s) | scanned ${h.scanned} | broadcast ${h.broadcast} | queue ${h.queueDepth}`
    : `🎯 Hunt: <b>OFFLINE</b> (reconnecting)`;
  return ctx.replyWithHTML(
    `<b>Bot Status: ONLINE</b>\n\nData: DexScreener | PumpPortal${h.fallbackEnabled ? ' + Dex fallback' : ''} | Birdeye | Helius${process.env.DEFADE_API_KEY ? ' | DeFade' : ''}\n` +
    `Guardian: ${tracker.list().length} position(s) tracked\nSession: ${config.SESSION_SIZE_SOL} SOL\n${huntLine}`
  );
});

bot.command('hunt', ctx => {
  const added = hunt.addHunter(ctx.chat.id);
  return ctx.replyWithHTML(added
    ? `🎯 <b>Hunt Mode: ON</b>\nYou'll receive a full scorecard for every new launch / migration with Adjusted Vol/Liq ≥ 5x.\nPumpPortal WS is primary; DexScreener fallback arms automatically if WS goes stale.\nUse /unhunt to stop.`
    : `🎯 Hunt Mode already <b>ON</b> for this chat. Use /unhunt to stop.`);
});

bot.command('unhunt', ctx => {
  const removed = hunt.removeHunter(ctx.chat.id);
  return ctx.reply(removed ? '🎯 Hunt Mode: OFF for this chat.' : 'Hunt Mode was not active for this chat.');
});

bot.command('huntstatus', ctx => {
  const h = hunt.status();
  const uptime  = h.uptimeMs   ? Math.floor(h.uptimeMs   / 1000) + 's' : '—';
  const lastEv  = h.lastEvent  ? Math.floor((Date.now() - h.lastEvent)  / 1000) + 's ago' : 'never';
  const lastRaw = h.lastRawEvent ? Math.floor((Date.now() - h.lastRawEvent) / 1000) + 's ago' : 'never';
  const wsLabel = !h.connected ? '🔴 DISCONNECTED' : h.staleWs ? '🟡 CONNECTED / STALE' : '🟢 CONNECTED';
  const text =
    `<b>Hunt Mode Diagnostics</b>\n\n` +
    `WS:       ${wsLabel}\n` +
    `Uptime:   ${uptime}\n` +
    `Hunters:  ${h.hunters}\n` +
    `PumpPortal key: ${h.pumpPortalApiKeyConfigured ? 'configured' : 'not configured'}\n` +
    `Last raw frame: ${lastRaw}\n` +
    `Last usable event: ${lastEv}\n` +
    `Last source: ${h.lastSource || 'none'}\n\n` +
    `<b>Lifetime stats</b>\n` +
    `Raw WS frames: ${h.rawEvents ?? 0}\n` +
    `Ignored WS frames: ${h.ignoredEvents ?? 0}${h.lastIgnoredReason ? ` (${h.lastIgnoredReason})` : ''}\n` +
    `Scanned:   ${h.scanned}\n` +
    `Broadcast: ${h.broadcast} (vol/liq ≥ 5x)\n` +
    `Skipped:   ${h.skipped}\n` +
    `Errors:    ${h.errors}\n` +
    `Fallback:  ${h.fallbackEnabled ? 'ON' : 'OFF'} | polls ${h.fallbackPolls ?? 0} | enqueued ${h.fallbackEnqueued ?? 0} | errors ${h.fallbackErrors ?? 0}\n` +
    `Queue:     ${h.queueDepth} pending | ${h.activeScans} running\n\n` +
    (h.staleWs ? `⚠️ <b>WS is stale:</b> PumpPortal connected but not producing usable launch CAs. Fallback covering partial discovery.\n\n` : '') +
    `You: ${hunt.isHunter(ctx.chat.id) ? '🎯 hunting' : '⚪ not hunting (/hunt to enable)'}`;
  const extra = { parse_mode: 'HTML' };
  if (!h.connected || h.staleWs) {
    extra.reply_markup = { inline_keyboard: [[
      { text: '🔄 RECONNECT', callback_data: 'hunt:reconnect' }
    ]]};
  }
  return ctx.reply(text, extra);
});

bot.action('hunt:reconnect', async ctx => {
  try { await ctx.answerCbQuery('Reconnecting…'); } catch (_) {}
  const ok = hunt.forceReconnect();
  if (!ok) return ctx.replyWithHTML(`⚠️ Hunt Mode not initialized — try /hunt first.`);
  return ctx.replyWithHTML(`🔄 <b>Manual reconnect triggered.</b>\nRun /huntstatus in ~5s to verify 🟢 CONNECTED.`);
});

bot.command('tracking', ctx => {
  const positions = tracker.list();
  if (!positions.length) return ctx.reply('No positions currently tracked.');
  const lines = positions.map((p, i) => {
    const baselineOk = p.entryTop50Pct !== null && p.entryHolderCount !== null;
    return `${i+1}. <code>${p.ca.slice(0,8)}...</code> — entry MC: $${(p.entryMc/1000).toFixed(1)}K | peak: $${(p.peakMc/1000).toFixed(1)}K${baselineOk ? '' : ' ⚠️ baseline pending'}`;
  });
  return ctx.replyWithHTML(`<b>Tracked Positions (${positions.length}):</b>\n\n${lines.join('\n')}\n\n<i>Use /sync &lt;CA&gt; to re-establish a pending baseline.</i>`);
});

bot.command('sync', async ctx => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const ca    = parts[1];
  if (!ca || !isSolanaCA(ca)) {
    // Show which tracked positions have a pending baseline
    const pending = tracker.list().filter(p => p.entryTop50Pct === null || p.entryHolderCount === null);
    if (!pending.length) return ctx.reply('All tracked positions have baselines set. Nothing to sync.');
    const lines = pending.map(p => `• <code>${p.ca}</code>`).join('\n');
    return ctx.replyWithHTML(`<b>Pending baselines:</b>\n${lines}\n\nUsage: /sync &lt;CA&gt;`);
  }
  const result = await tracker.syncBaseline(ca, ctx.chat.id, bot);
  if (!result.found) return ctx.reply(`CA not found in your tracked positions.`);
});

bot.command('window', ctx => {
  const etHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date()).find(p => p.type === 'hour')?.value ?? 0
  );
  const window = etHour >= 2 && etHour < 12 ? 'DISCOVERY' : etHour >= 12 && etHour < 19 ? 'DEAD_ZONE' : 'RESEARCH';
  return ctx.replyWithHTML(
    `<b>Scan Thresholds</b>\n\nLP min: $${config.LP_MIN_USD.toLocaleString()}\nAge max: ${config.AGE_MAX_MIN}min\n` +
    `Vol/Liq: ${window === 'DEAD_ZONE' ? '8x' : '5x'} (${window})\nTop 10 max: ${config.TOP10_MAX_PCT}%\n` +
    `Curve max: ${config.CURVE_MAX_PCT}% (hard skip: ${config.CURVE_HARD_SKIP_PCT}%)\n` +
    `Top 10 hard NO-GO: ${config.TOP10_HARD_MAX_PCT}%\nSession: ${config.SESSION_SIZE_SOL} SOL\n\n` +
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
    // Social fetch runs in parallel with the main data fetch to avoid adding latency.
    // fetchAll is the expensive chain; social is a single fast endpoint.
    const [data, social] = await Promise.all([
      fetchAll(ca),
      fetchSocialData(ca),
    ]);

    if (!data.codex && !data.pump) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, scanning.message_id, undefined,
        `No data found for <code>${ca}</code>. Check the address and try again.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Attach social data to the fetchAll result so scanner can read it
    data.social = social;

    const result  = scan(data);

    // Attach social data to result so verdict formatter can render GROK NARRATIVE
    result.social = social;

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
        reply_markup: buildKeyboard(ca, mc, result.verdict),
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

  if (data.startsWith('alert:')) {
    const parts  = data.split(':');
    const ca     = parts[1];
    const mc     = parseFloat(parts[2]) || 0;
    const shortCa = `${ca.slice(0,6)}...${ca.slice(-4)}`;
    if (watchlist.has(ca)) {
      await ctx.answerCbQuery(`🔔 Already watching ${shortCa}`);
      return;
    }
    // Pull symbol from a quick re-read of the callback message text (best-effort)
    const symbol = ctx.callbackQuery?.message?.text?.match(/\$([A-Z]{2,10})\b/)?.[1] || '???';
    const added = watchlist.add(ca, ctx.chat.id, symbol, mc);
    if (added) {
      await ctx.answerCbQuery(`🔔 Alert set for ${shortCa}`);
      await bot.telegram.sendMessage(
        ctx.chat.id,
        `🔔 *ENTRY GRADE ALERT SET*\n\`${shortCa}\`\n\nI'll notify you the moment Vol/Liq ≥ 5x AND Holder Health ≥ 50% are both met.\n_Auto-expires in 6 hours._`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.answerCbQuery(`Already watching ${shortCa}`);
    }
    return;
  }

  if (data.startsWith('untrack:')) {
    const ca      = data.split(':')[1];
    const removed = tracker.untrack(ca);
    const shortCa = `${ca.slice(0,6)}...${ca.slice(-4)}`;
    await ctx.answerCbQuery(removed ? `❌ Stopped tracking ${shortCa}` : 'Not currently tracking this token');
    return;
  }

  if (data.startsWith('track:')) {
    const parts = data.split(':');
    const ca    = parts[1];
    const mc    = parseFloat(parts[2]) || 0;

    // Re-scan to get entryTier, timeWindow, devWallet, holderCount, top10Pct
    let entryTier = null, timeWindow = 'DISCOVERY';
    let devWallet = null, holderCount = null, top10Pct = null, top50Pct = null, entryLp = null;
    try {
      const scanData = await fetchAll(ca);
      const result   = scan(scanData);
      entryTier   = result.entryTier;
      timeWindow  = result.timeWindow;
      devWallet   = result.devProfile?.wallet   ?? null;
      entryLp     = result.signals?.lp          ?? null;
      holderCount = result.signals?.holderCount ?? null;
      top10Pct    = result.signals?.top10Pct    ?? null;
      top50Pct    = result.signals?.top50Pct    ?? null;
    } catch (_) {}

    const added = tracker.track(ca, ctx.chat.id, mc, entryTier, timeWindow, devWallet, holderCount, top10Pct, top50Pct, entryLp);
    const shortCa = `${ca.slice(0,6)}...${ca.slice(-4)}`;

    if (added) {
      await ctx.answerCbQuery(`✅ Tracking ${shortCa} — Guardian active`);
      const baselineReady = top50Pct !== null && holderCount !== null;
      await ctx.telegram.sendMessage(
        ctx.chat.id,
        `🔔 *Oracle Guardian activated*\nTracking \`${shortCa}\`\nEntry MC: $${(mc/1000).toFixed(1)}K\n` +
        (baselineReady
          ? `Baseline: ${holderCount} holders | Top 50: ${top50Pct.toFixed(1)}%\n\nAll triggers active. Forensic scan every 60s.`
          : `\n⏳ Holder data pending — establishing baseline in background...`),
        { parse_mode: 'Markdown' }
      );
      // If holder/top50 data was null at entry, retry in background until set
      tracker.maybeEstablishBaseline(ca, bot);
    } else {
      const reason = tracker.list().length >= 10
        ? 'max 10 positions reached'
        : 'already tracking this token';
      await ctx.answerCbQuery(`⚠️ ${reason}`);
    }
  }
});

// ── Launch ────────────────────────────────────────────────────────────────────

bot.launch({ dropPendingUpdates: true })
  .then(async () => {
    console.log('Oracle Bot v10.2.3 (Hunt-Resilient) started');
    tracker.startTracker(bot);
    hunt.start(bot, buildKeyboard);
    watchlist.start(bot);

    // Broadcast startup ping to all persisted hunters so they know the bot
    // restarted (Railway redeploys would otherwise be invisible).
    const hunters = hunt.listHunters();
    const startupMsg = `🚀 <b>Oracle v10.2.3 Online &amp; Hunt-Resilient</b>\nType /hunt to begin.`;
    for (const chatId of hunters) {
      try { await bot.telegram.sendMessage(chatId, startupMsg, { parse_mode: 'HTML' }); }
      catch (e) { console.error(`[startup] ping failed for ${chatId}:`, e.message); }
    }
    if (hunters.length) console.log(`[startup] pinged ${hunters.length} hunter(s)`);
  })
  .catch(err => {
    console.error('Failed to launch bot:', err.message);
    process.exit(1);
  });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

process.on('unhandledRejection', err => {
  console.error('[process] unhandledRejection:', err?.stack || err);
});

process.on('uncaughtException', err => {
  console.error('[process] uncaughtException:', err?.stack || err);
  process.exit(1);
});
