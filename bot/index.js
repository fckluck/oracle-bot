require('dotenv').config();
const http     = require('http');
const { Telegraf } = require('telegraf');
const { fetchAll, fetchDeFadeVerification, fetchSocialData, fetchForensic } = require('./fetcher');
const { scan }     = require('./scanner');
const { formatVerdict } = require('./verdict');
const tracker   = require('./tracker');
const hunt      = require('./hunt');
const watchlist = require('./watchlist');
const config    = require('./config');
const { probeXaiConnection } = require('./reasoning');

// ── Railway health check ───────────────────────────────────────────────────────
// Railway treats every service as a web service and kills the process if it
// gets no HTTP 200 on $PORT within the health-check window (~60s). Without
// this listener the bot fires its startup polls, sends a burst of signals, then
// Railway kills it — making Hunt Mode look like it "only works at deploy."
// This tiny server costs nothing and keeps the process alive indefinitely.
const HEALTH_PORT = parseInt(process.env.PORT, 10) || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    bot:    'Oracle v10.2.7',
    uptime: Math.floor(process.uptime()),
  }));
}).listen(HEALTH_PORT, () => {
  console.log(`[health] HTTP check listening on :${HEALTH_PORT}`);
});

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
  `🛠️ <b>ORACLE COMMAND CENTER (v10.2.7 — Spine Lock)</b>\n` +
  `<i>The spine is aligned. The Predator is hunting.</i>\n\n` +
  `<b>── CORE ──</b>\n` +
  `• /start — Re-initialize the Oracle interface\n` +
  `• /help — Show this command menu\n` +
  `• /status — API + Guardian health snapshot\n\n` +
  `<b>── HUNT MODE (Automated) ──</b>\n` +
  `• /hunt — 🎯 <b>ACTIVATE 24/7 HUNTER.</b> Alerts on 3x+ Adjusted Vol/Liq launches\n` +
  `• /unhunt — Disable automated alerts\n` +
  `• /huntstatus — Live hunt diagnostics (scanned/broadcast/queue)\n` +
  `• /huntdebug — Deep lifecycle debug (start/watchdog/connect counters)\n` +
  `• /huntping — Force one Dex fallback poll and report results\n` +
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

// v10.2.7: forces one Dex fallback poll on demand and reports the stat delta,
// so users can verify the fallback path is alive without waiting up to 90s
// for the next scheduled poll. Distinguishes "fallback never runs" from
// "fallback runs but never finds usable launches".
bot.command('huntping', async ctx => {
  await ctx.reply('🛰️ Forcing one Dex fallback poll...');
  const r = await hunt.pingFallback();
  if (!r.ok) return ctx.replyWithHTML(`⚠️ /huntping failed: ${r.reason}`);
  const d = r.delta;
  const note = d.enqueued === 0
    ? '⚠️ Fallback polled DexScreener but found no new launches passing dust filter (this is normal in quiet windows).'
    : '✅ Fallback enqueued tokens for scanning.';
  return ctx.replyWithHTML(
    `<b>/huntping result (delta this call)</b>\n` +
    `attempts:  ${d.attempts}\n` +
    `polls:     ${d.polls}\n` +
    `enqueued:  ${d.enqueued}\n` +
    `scanned:   ${d.scanned}\n` +
    `broadcast: ${d.broadcast}\n` +
    `skipped:   ${d.skipped}\n` +
    `errors:    ${d.errors}\n\n${note}`
  );
});

bot.command('huntstatus', ctx => {
  const h   = hunt.status();
  const now = Date.now();
  const ago = ts => ts ? Math.floor((now - ts) / 1000) + 's ago' : 'never';
  const wsLabel   = !h.connected ? '🔴 DISCONNECTED' : h.staleWs ? '🟡 CONNECTED / STALE' : '🟢 CONNECTED';
  const uptime    = h.uptimeMs ? Math.floor(h.uptimeMs / 1000) + 's' : '—';
  // Mask hunter IDs for privacy: show first 3 + last 2 digits, e.g. 123***89
  const maskedIds = (h.hunterIds || []).map(id => {
    const s = String(id);
    return s.length <= 5 ? '****' : s.slice(0, 3) + '***' + s.slice(-2);
  }).join(', ') || 'none';

  const text =
    `<b>Hunt Mode Diagnostics</b>\n\n` +
    `WS:         ${wsLabel}\n` +
    `Uptime:     ${uptime}\n` +
    `Hunters:    ${h.hunters}\n` +
    `Hunter IDs: ${maskedIds}\n` +
    `Your chat:  <code>${ctx.chat.id}</code>\n` +
    `PumpPortal key: ${h.pumpPortalApiKeyConfigured ? 'configured' : 'not configured'}\n` +
    `Last raw frame:    ${ago(h.lastRawEvent)}\n` +
    `Last usable event: ${ago(h.lastEvent)}\n` +
    `Last source: ${h.lastSource || 'none'}\n\n` +
    `<b>Traffic</b>\n` +
    `Raw WS frames: ${h.rawEvents ?? 0}\n` +
    `Ignored:   ${h.ignoredEvents ?? 0}${h.lastIgnoredReason ? ` (${h.lastIgnoredReason})` : ''}\n` +
    `Scanned:   ${h.scanned}\n` +
    `Skipped:   ${h.skipped}\n` +
    `Errors:    ${h.errors}\n\n` +
    `<b>Broadcast delivery</b>\n` +
    `Candidates (passed filter): ${h.broadcastCandidates ?? h.broadcast ?? 0}\n` +
    `Telegram attempts:  ${h.broadcastAttempts ?? 0}\n` +
    `✅ Delivered:       ${h.broadcastDelivered ?? 0}\n` +
    `❌ Failed:          ${h.broadcastFailed ?? 0}\n` +
    `Last candidate:  ${h.lastBroadcastCA ? `<code>${h.lastBroadcastCA.slice(0,8)}...</code> ${ago(h.lastBroadcastAt)}` : 'none'}\n` +
    `Last delivered:  ${ago(h.lastDeliveredAt)}\n` +
    `Last error:      ${h.lastBroadcastError || 'none'}\n\n` +
    `<b>Infrastructure</b>\n` +
    `Fallback:  ${h.fallbackEnabled ? 'ON' : 'OFF'} | polls ${h.fallbackPolls ?? 0} | enqueued ${h.fallbackEnqueued ?? 0} | errors ${h.fallbackErrors ?? 0}\n` +
    `Reconnects: ${h.hardReconnects ?? 0}${h.lastReconnectReason ? ` (${h.lastReconnectReason})` : ''}\n` +
    `Hammer:    every ${Math.floor((h.reconnectHammerMs || 15000) / 1000)}s if disconnected\n` +
    (h.lastWsClose ? `Last close: code ${h.lastWsClose.code ?? 'n/a'}${h.lastWsClose.reason ? ` | ${h.lastWsClose.reason}` : ''}\n` : '') +
    `Queue:     ${h.queueDepth} pending | ${h.activeScans} running\n\n` +
    (h.staleWs ? `⚠️ <b>PumpPortal unavailable</b> — WS connected but 0 raw frames in 2+ min. Dex fallback active.\n\n` : '') +
    (!h.connected ? `🚨 <b>WS disconnected</b> — reconnect hammer active.\n\n` : '') +
    (h.startedAt == null ? `❌ <b>FATAL:</b> Hunt engine never started. Use /huntdebug.\n\n` : '') +
    `You: ${hunt.isHunter(ctx.chat.id) ? '🎯 hunting' : '⚪ not hunting (/hunt to enable)'}\n` +
    `<i>Run /hunttest to verify delivery path. /huntlast to see last 5 candidates.</i>`;
  const extra = { parse_mode: 'HTML' };
  if (!h.connected || h.staleWs) {
    extra.reply_markup = { inline_keyboard: [[{ text: '🔄 RECONNECT', callback_data: 'hunt:reconnect' }]] };
  }
  return ctx.reply(text, extra);
});

bot.action('hunt:reconnect', async ctx => {
  try { await ctx.answerCbQuery('Reconnecting…'); } catch (_) {}
  const ok = hunt.forceReconnect();
  if (!ok) return ctx.replyWithHTML(`⚠️ Hunt engine has no broadcaster — start() likely never ran. Use /huntdebug.`);
  return ctx.replyWithHTML(`🔄 <b>Manual reconnect triggered.</b>\nRun /huntstatus in ~5s to verify 🟢 CONNECTED.`);
});

// v10.2.10: shows last 5 candidates that passed Hunt filter with delivery status.
bot.command('huntlast', ctx => {
  const h = hunt.status();
  const candidates = h.lastCandidates || [];
  if (!candidates.length) {
    return ctx.replyWithHTML(
      `<b>Hunt Last Candidates</b>\n\nNo candidates recorded yet this session.\n` +
      `<i>Hunt has scanned ${h.scanned ?? 0} token(s) but none passed the Vol/Liq ≥ 5x filter, or the session just started.</i>`
    );
  }
  const now = Date.now();
  const lines = candidates.map((c, i) => {
    const age    = Math.floor((now - c.ts) / 1000);
    const ageStr = age < 60 ? `${age}s ago` : `${Math.floor(age/60)}m ago`;
    const deliv  = c.delivered > 0 ? `✅ delivered` : c.attempted === 0 ? `⚪ no hunters` : `❌ FAILED`;
    const errStr = c.error ? `\n   ⚠️ <i>${c.error.slice(0, 80)}</i>` : '';
    return (
      `${i+1}. <b>$${c.symbol}</b> — <code>${c.ca.slice(0,8)}...</code>\n` +
      `   ${c.verdict} | ${c.adjustedVolLiq.toFixed(1)}x Vol/Liq | MC $${c.mc >= 1000 ? (c.mc/1000).toFixed(1)+'K' : c.mc.toFixed(0)}\n` +
      `   ${ageStr} — ${deliv}${errStr}\n` +
      `   <a href="https://dexscreener.com/solana/${c.ca}">Chart</a>`
    );
  });
  return ctx.replyWithHTML(
    `<b>Hunt Last ${candidates.length} Candidate(s)</b>\n\n` + lines.join('\n\n')
  );
});

// v10.2.10: tests the broadcaster path directly — same code path Hunt uses.
bot.command('hunttest', async ctx => {
  const result = await hunt.testBroadcast(ctx.chat.id);
  if (result.ok) {
    return ctx.replyWithHTML(
      `✅ <b>Hunt broadcaster test delivered to chatId <code>${ctx.chat.id}</code></b>\n` +
      `Delivery path is working. If you are still not receiving Hunt alerts, the issue is upstream — check /huntstatus for filter stats and delivery counts.`
    );
  }
  return ctx.replyWithHTML(
    `❌ <b>Hunt broadcaster test FAILED for chatId <code>${ctx.chat.id}</code></b>\n` +
    `Telegram error: <code>${result.reason}</code>\n\n` +
    `This means Hunt cannot deliver to you. Common causes: bot was blocked, chat ID mismatch, or Telegram API error.`
  );
});

// v10.2.6 — surfaces every internal lifecycle counter. Use this when /huntstatus
// looks wrong (e.g. WS disconnected with 0 reconnects) to see if start() ran,
// if the watchdog setInterval is actually ticking, and how many WS attempts
// have been made. Tells us what's broken without needing Railway logs.
bot.command('huntdebug', ctx => {
  const h = hunt.status();
  const now = Date.now();
  const ago = ts => ts ? Math.floor((now - ts) / 1000) + 's ago' : 'never';
  const ready = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][h.wsReadyState ?? -1] || 'no-socket';
  const verdict =
    h.startedAt == null               ? '❌ start() NEVER ran — try /unhunt then /hunt, or check Railway logs for tracker/watchlist crash' :
    h.connectAttempts === 0           ? '❌ connect() never called inside start()' :
    h.watchdogArmedAt == null         ? '❌ watchdog never armed' :
    h.watchdogTicks === 0 && (now - h.watchdogArmedAt) > 20_000 ? '❌ watchdog setInterval is NOT firing (event loop issue)' :
    h.lastConstructError              ? `❌ WS constructor failed: ${h.lastConstructError.msg}` :
    h.connected                       ? '✅ WS is connected' :
    h.fallbackAttempts > 0            ? '🟡 WS down but fallback is polling — alerts should still flow if launches occur' :
    '🟡 WS down, fallback not yet attempted';
  return ctx.replyWithHTML(
    `<b>Hunt Engine Deep Debug</b>\n\n` +
    `<b>Lifecycle</b>\n` +
    `start() called:     ${ago(h.startedAt)}\n` +
    `watchdog armed:     ${ago(h.watchdogArmedAt)}\n` +
    `watchdog ticks:     ${h.watchdogTicks} ${h.watchdogTicks === 0 && h.watchdogArmedAt ? '⚠️ (should be ≥1 every 15s)' : ''}\n` +
    `connect() attempts: ${h.connectAttempts}\n` +
    `last connect():     ${ago(h.lastConnectAt)}\n` +
    `WS readyState:      ${ready} (${h.wsReadyState ?? 'null'})\n` +
    `last construct err: ${h.lastConstructError ? `${h.lastConstructError.msg} (${ago(h.lastConstructError.ts)})` : 'none'}\n` +
    `\n<b>Traffic</b>\n` +
    `raw frames seen:    ${h.rawEvents ?? 0}\n` +
    `fallback attempts:  ${h.fallbackAttempts ?? 0}\n` +
    `fallback polls:     ${h.fallbackPolls ?? 0} (gated on hunters>0 + WS stale)\n` +
    `hard reconnects:    ${h.hardReconnects ?? 0}\n` +
    `\n<b>Diagnosis</b>\n${verdict}`
  );
});

// v10.2.7: real /untrack <CA> command. Previously only worked as inline button.
bot.command('untrack', ctx => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const ca    = parts[1];
  if (!ca || !isSolanaCA(ca)) {
    const lst = tracker.list();
    if (!lst.length) return ctx.reply('Usage: /untrack <CA>\n(No positions currently tracked.)');
    const lines = lst.map((p,i) => `${i+1}. <code>${p.ca}</code>`).join('\n');
    return ctx.replyWithHTML(`Usage: <code>/untrack &lt;CA&gt;</code>\n\n<b>Tracked positions:</b>\n${lines}`);
  }
  const pos = tracker.list().find(p => p.ca === ca);
  if (!pos) return ctx.reply(`Not currently tracking ${ca.slice(0,6)}...${ca.slice(-4)}.`);
  if (pos.chatId !== ctx.chat.id) return ctx.reply('You can only untrack your own positions.');
  const removed = tracker.untrack(ca);
  return ctx.replyWithHTML(removed
    ? `❌ Stopped tracking <code>${ca.slice(0,6)}...${ca.slice(-4)}</code>. Guardian poll halted.`
    : `Untrack failed for <code>${ca.slice(0,6)}...${ca.slice(-4)}</code>.`);
});

bot.command('watchlist', ctx => {
  const all = watchlist.list();
  const mine = all.filter(e => e.chatId === ctx.chat.id);
  if (!mine.length) return ctx.reply('No tokens on your watchlist. Use the 🔔 ALERT button on any WATCH_VOL result to add one.');
  const now = Date.now();
  const lines = mine.map((e, i) => {
    const ageMin = Math.floor((now - e.addedAt) / 60000);
    const expiresIn = Math.max(0, Math.floor((e.addedAt + 6 * 60 * 60 * 1000 - now) / 60000));
    return `${i + 1}. <code>${e.ca.slice(0, 8)}...</code> $${e.symbol} — added ${ageMin}m ago, expires in ${expiresIn}m`;
  });
  return ctx.replyWithHTML(
    `<b>Your Watchlist (${mine.length})</b>\n` +
    `<i>Waiting for Vol/Liq ≥ 5x + Holder Health ≥ 50%</i>\n\n` +
    lines.join('\n') +
    `\n\n<i>Alerts auto-expire after 6 hours.</i>`
  );
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

    if (!added) {
      const reason = tracker.list().length >= 10 ? 'max 10 positions reached' : 'already tracking this token';
      await ctx.answerCbQuery(`⚠️ ${reason}`);
      return;
    }
    await ctx.answerCbQuery(`✅ Tracking ${shortCa}`);

    // v10.2.7: synchronous baseline with 3-attempt retry.
    // Solana API lag is common in the first few seconds after a new launch.
    // A single-shot fetch would untrack good tokens unnecessarily. Retry 3×
    // at 2s intervals — baseline message arrives within ~6s worst case (the
    // callback was already answered, so the user isn't blocked).
    const MAX_BASELINE_ATTEMPTS = 3;
    const BASELINE_RETRY_MS     = 2000;
    let sig = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_BASELINE_ATTEMPTS; attempt++) {
      try {
        sig = await fetchForensic(ca);
        if (sig) { console.log(`[track] baseline attempt ${attempt} OK for ${shortCa}`); break; }
        lastErr = new Error('forensic returned null (DexScreener/SolanaTracker unreachable)');
        console.log(`[track] baseline attempt ${attempt} returned null — retry in ${BASELINE_RETRY_MS}ms`);
      } catch (e) {
        lastErr = e;
        console.log(`[track] baseline attempt ${attempt} threw: ${e.message} — retry in ${BASELINE_RETRY_MS}ms`);
      }
      if (attempt < MAX_BASELINE_ATTEMPTS) await new Promise(r => setTimeout(r, BASELINE_RETRY_MS));
    }

    if (!sig) {
      tracker.untrack(ca);
      await ctx.telegram.sendMessage(ctx.chat.id,
        `❌ *TRACK FAILED — forensic data unavailable*\n` +
        `\`${shortCa}\` is NOT actively monitored.\n` +
        `Tried ${MAX_BASELINE_ATTEMPTS}× — ${lastErr?.message ?? 'API unreachable'}.\n` +
        `Re-click [ ➕ TRACK ] in a few minutes once the token settles.`,
        { parse_mode: 'Markdown' });
    } else {
      const fmtUsd = (n) => !n ? 'N/A' : n >= 1e6 ? `$${(n/1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n/1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;
      await ctx.telegram.sendMessage(ctx.chat.id,
        `🔔 *Oracle Guardian — Baseline Set*\n` +
        `\`${shortCa}\`\n` +
        `• MC: ${fmtUsd(sig.marketCap)}\n` +
        `• LP: ${fmtUsd(sig.lp)}\n` +
        `• Holders: ${sig.holderCount ?? 'N/A'}\n` +
        `• Top 10: ${sig.top10Pct != null ? sig.top10Pct.toFixed(1) + '%' : 'N/A'}\n` +
        `• Top 50: ${sig.top50Pct != null ? sig.top50Pct.toFixed(1) + '%' : 'N/A'}\n` +
        `• Vol/Liq (1h): ${sig.adjustedVolLiq != null ? sig.adjustedVolLiq.toFixed(2) + 'x' : 'N/A'}\n\n` +
        `_Next forensic poll in 60s. All triggers active._`,
        { parse_mode: 'Markdown' });
      if (sig.top50Pct == null || sig.holderCount == null) {
        tracker.maybeEstablishBaseline(ca, bot);
      }
    }
  }
});

// ── Launch ────────────────────────────────────────────────────────────────────
// v10.2.8 FIX: Start subsystems BEFORE bot.launch().
//
// Root cause of "hunt.start() never called": when Railway deploys, the old
// instance keeps polling for a few seconds. The new instance calls bot.launch(),
// gets 409 Conflict, the old .catch() called process.exit(1), Railway restarted,
// and we were stuck in a boot loop. hunt.start() only ran inside .then(), so it
// was never reached during the loop — and when the loop finally broke, timing
// could still race. Fix: subsystems need only the bot object (they call
// bot.telegram.sendMessage directly, not via polling), so start them immediately.
// bot.launch() is retried with backoff; a 409 is not fatal.

try { tracker.startTracker(bot); }
catch (e) { console.error('[startup] tracker.startTracker error:', e?.stack || e.message); }

try { hunt.start(bot, buildKeyboard); }
catch (e) { console.error('[startup] hunt.start error:', e?.stack || e.message); }

try { watchlist.start(bot); }
catch (e) { console.error('[startup] watchlist.start error:', e?.stack || e.message); }

// Non-blocking xAI connectivity check — result appears in Railway logs within ~5s.
// Look for "[reasoning] PROBE OK" or "[reasoning] PROBE FAILED" to diagnose Grok issues.
probeXaiConnection().catch(() => {});

console.log('[startup] subsystems started — launching Telegram polling...');

async function launchWithRetry(maxAttempts = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      console.log(`Oracle Bot v10.2.8 (Safe Calibration) started — polling active (attempt ${attempt})`);

      // Startup ping — hunters already loaded by hunt.start() above.
      const hunters = hunt.listHunters();
      const startupMsg =
        `🚀 <b>Oracle v10.2.8 Online — Safe Calibration</b>\n` +
        `Top10 gate: 25% | Spine Lock: active\n` +
        `Hunt engine: running | Use /huntstatus to verify.`;
      for (const chatId of hunters) {
        try { await bot.telegram.sendMessage(chatId, startupMsg, { parse_mode: 'HTML' }); }
        catch (e) { console.error(`[startup] ping failed for ${chatId}:`, e.message); }
      }
      if (hunters.length) console.log(`[startup] pinged ${hunters.length} hunter(s)`);
      return; // success
    } catch (err) {
      const is409 = err.message?.includes('409') || err.description?.includes('Conflict');
      if (is409) {
        console.warn(`[launch] attempt ${attempt}/${maxAttempts}: 409 Conflict — old instance still holds polling lock. Retrying in ${delayMs}ms...`);
      } else {
        console.error(`[launch] attempt ${attempt}/${maxAttempts} failed:`, err.message);
      }
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        console.error('[launch] all attempts exhausted — polling inactive, but subsystems and health check are still running.');
      }
    }
  }
}

launchWithRetry().catch(err => console.error('[launch] launchWithRetry unexpected error:', err?.stack || err));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

process.on('unhandledRejection', err => {
  console.error('[process] unhandledRejection:', err?.stack || err);
});

process.on('uncaughtException', err => {
  console.error('[process] uncaughtException:', err?.stack || err);
  process.exit(1);
});
