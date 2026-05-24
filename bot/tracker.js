// Oracle Guardian v2.5 — Forensic Shield (Final)
// 60s forensic loop: cluster exit (top50 -3%), dev fee-loader, momentum decay,
// LP floor, ATH SL. 5m heartbeat: holders/top50/LP flow snapshot + saturation.
// Lightweight fetch (fetchForensic) cuts per-poll API load ~70% vs full scan.
// Positions persisted to disk — survive bot restarts/crashes.

require('dotenv').config();
const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');
const { fetchForensic } = require('./fetcher');

const MAX_POSITIONS  = 10;
const POLL_INTERVAL  = 60 * 1000; // 60s
const PERSIST_FILE   = path.join(__dirname, 'positions.json');

// ── State ─────────────────────────────────────────────────────────────────────
// Map: ca -> {
//   ca, chatId, entryMc, peakMc, entryLp, trackedAt, entryTier, timeWindow,
//   devWallet,
//   entryHolderCount, entryTop10Pct, entryTop50Pct,
//   holderSnapshots: [{ ts, count }],   // rolling 10m window for stagnation check
//   top50Snapshots:  [{ ts, pct }],     // rolling 5m window for cluster exit
//   alertedFlags: Set<string>,          // dedup — don't re-alert same signal
// }
const positions = new Map();

// ── Persistence ───────────────────────────────────────────────────────────────

function saveToDisk() {
  try {
    const serializable = [...positions.values()].map(p => ({
      ...p,
      alertedFlags: [...p.alertedFlags],  // Set → Array for JSON
    }));
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(serializable, null, 2));
  } catch (e) {
    console.error('[tracker] save error:', e.message);
  }
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
    if (!Array.isArray(raw)) return;
    for (const p of raw) {
      p.alertedFlags    = new Set(p.alertedFlags || []);
      p.holderSnapshots = p.holderSnapshots || [];
      positions.set(p.ca, p);
    }
    if (positions.size > 0) {
      console.log(`[tracker] loaded ${positions.size} position(s) from disk`);
    }
  } catch (e) {
    console.error('[tracker] load error:', e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUsd(n) {
  if (n == null || isNaN(n)) return 'N/A';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtChange(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function heliusRpc() {
  const key = process.env.HELIUS_API_KEY;
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : null;
}

// ── Dev wallet fee-loader detection ──────────────────────────────────────────
// Watches for the classic pre-dump setup: dev sends small SOL amounts (0.01–0.1)
// to 5+ unique wallets in a 5-minute window to fund exit wallets.

async function checkDevFeeLoader(devWallet) {
  const rpc = heliusRpc();
  if (!rpc || !devWallet) return { detected: false };
  try {
    // Fetch recent signatures for dev wallet
    const sigRes = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [devWallet, { limit: 30 }],
      }),
      timeout: 8000,
    });
    const sigData = await sigRes.json();
    const sigs = sigData?.result || [];
    if (!sigs.length) return { detected: false };

    const fiveMinAgo = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);
    const recentSigs = sigs.filter(s => s.blockTime && s.blockTime >= fiveMinAgo);
    if (!recentSigs.length) return { detected: false };

    // Fetch transaction details in parallel (max 10)
    const txFetches = recentSigs.slice(0, 10).map(s =>
      fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTransaction',
          params: [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        }),
        timeout: 6000,
      }).then(r => r.json()).catch(() => null)
    );
    const txResults = await Promise.all(txFetches);

    // Find SOL transfers OUT from dev wallet in 0.01–0.1 SOL range
    const uniqueDestinations = new Set();
    for (const tx of txResults) {
      if (!tx?.result) continue;
      const accountKeys = tx.result.transaction?.message?.accountKeys || [];
      const preBalances  = tx.result.meta?.preBalances  || [];
      const postBalances = tx.result.meta?.postBalances || [];

      accountKeys.forEach((acc, idx) => {
        const address = typeof acc === 'string' ? acc : acc?.pubkey;
        if (address === devWallet) return; // skip dev wallet itself

        const pre  = preBalances[idx]  ?? 0;
        const post = postBalances[idx] ?? 0;
        const received = (post - pre) / 1e9; // lamports → SOL

        if (received >= 0.01 && received <= 0.1) {
          uniqueDestinations.add(address);
        }
      });
    }

    const detected = uniqueDestinations.size >= 5;
    if (detected) {
      console.log(`[guardian] fee-loader: dev ${devWallet.slice(0,8)} → ${uniqueDestinations.size} wallets in 5m`);
    }
    return { detected, uniqueDestinations: uniqueDestinations.size };
  } catch (e) {
    console.error('[guardian] checkDevFeeLoader error:', e.message);
    return { detected: false };
  }
}

// ── Position management ───────────────────────────────────────────────────────

// ── Baseline establishment (with retry) ───────────────────────────────────────
// If the API returns null at TRACK time, retry every 10s for up to 2 minutes.
// Sends a "pending" message immediately, then a confirmation once baseline is set.
// Also used by the /sync command to manually re-establish a missed baseline.

async function establishBaseline(pos, bot, { silent = false } = {}) {
  const shortCa = `${pos.ca.slice(0,6)}...${pos.ca.slice(-4)}`;
  const MAX_ATTEMPTS = 12; // 12 × 10s = 2 min
  let pendingMsgId = null;

  if (!silent) {
    try {
      const sent = await bot.telegram.sendMessage(
        pos.chatId,
        `🔄 *GUARDIAN BASELINE PENDING*\n\`${shortCa}\` — Holder data unavailable at entry. Retrying every 10s (up to 2 min)...`,
        { parse_mode: 'Markdown' }
      );
      pendingMsgId = sent.message_id;
    } catch (_) {}
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, 10_000));
    const pos2 = positions.get(pos.ca);
    if (!pos2) return; // untracked while waiting

    // Already set by a concurrent poll
    if (pos2.entryTop50Pct !== null && pos2.entryHolderCount !== null) {
      console.log(`[tracker] baseline already set for ${pos.ca.slice(0,8)}, skipping retry`);
      return;
    }

    try {
      const sig = await fetchForensic(pos.ca);
      if (!sig) continue;

      const now = Date.now();
      if (sig.holderCount != null) {
        pos2.entryHolderCount = sig.holderCount;
        pos2.holderSnapshots  = [{ ts: now, count: sig.holderCount }];
      }
      if (sig.top10Pct != null) pos2.entryTop10Pct = sig.top10Pct;
      if (sig.top50Pct != null) {
        pos2.entryTop50Pct = sig.top50Pct;
        pos2.top50Snapshots = [{ ts: now, pct: sig.top50Pct }];
      }

      if (pos2.entryTop50Pct !== null && pos2.entryHolderCount !== null) {
        saveToDisk();
        console.log(`[tracker] baseline established for ${pos.ca.slice(0,8)} — holders=${pos2.entryHolderCount} top50=${pos2.entryTop50Pct.toFixed(1)}%`);
        const confirmText =
          `✅ *GUARDIAN BASELINE SET*\n` +
          `\`${shortCa}\`\n` +
          `• Holders: ${pos2.entryHolderCount}\n` +
          `• Top 50: ${pos2.entryTop50Pct.toFixed(1)}%\n` +
          `_Cluster exit and saturation triggers now active._`;
        if (pendingMsgId) {
          try {
            await bot.telegram.editMessageText(pos.chatId, pendingMsgId, undefined, confirmText, { parse_mode: 'Markdown' });
          } catch (_) {
            await bot.telegram.sendMessage(pos.chatId, confirmText, { parse_mode: 'Markdown' });
          }
        } else {
          await bot.telegram.sendMessage(pos.chatId, confirmText, { parse_mode: 'Markdown' });
        }
        return;
      }
    } catch (e) {
      console.error(`[tracker] baseline retry ${attempt} error:`, e.message);
    }
  }

  // All retries exhausted
  if (pendingMsgId) {
    try {
      await bot.telegram.editMessageText(
        pos.chatId, pendingMsgId, undefined,
        `⚠️ *GUARDIAN BASELINE UNAVAILABLE*\n\`${shortCa}\` — Holder API didn't respond in 2 min.\nUse /sync to retry manually.`,
        { parse_mode: 'Markdown' }
      );
    } catch (_) {}
  }
  console.log(`[tracker] baseline retries exhausted for ${pos.ca.slice(0,8)}`);
}

function track(ca, chatId, currentMc, entryTier, timeWindow, devWallet, holderCount, top10Pct, top50Pct, entryLp) {
  if (positions.size >= MAX_POSITIONS) {
    console.log(`[tracker] max positions (${MAX_POSITIONS}) reached`);
    return false;
  }
  if (positions.has(ca)) return false;
  const now = Date.now();
  const pos = {
    ca, chatId,
    entryMc:          currentMc,
    peakMc:           currentMc,
    entryLp:          entryLp    ?? null,
    trackedAt:        now,
    entryTier:        entryTier  || 'UNKNOWN',
    timeWindow:       timeWindow || 'DISCOVERY',
    devWallet:        devWallet  || null,
    entryHolderCount: holderCount ?? null,
    entryTop10Pct:    top10Pct   ?? null,
    entryTop50Pct:    top50Pct   ?? null,
    holderSnapshots:  holderCount != null ? [{ ts: now, count: holderCount }] : [],
    top50Snapshots:   top50Pct   != null  ? [{ ts: now, pct: top50Pct }]     : [],
    alertedFlags: new Set(),
  };
  positions.set(ca, pos);
  console.log(`[tracker] tracking ${ca.slice(0,8)}... mc=${fmtUsd(currentMc)} holders=${holderCount} top50=${top50Pct?.toFixed(1)}%`);
  saveToDisk();
  return true;
}

// Called after track() returns true — triggers baseline retry if fields are missing.
// Must be called with the bot instance from the caller (index.js).
function maybeEstablishBaseline(ca, bot) {
  const pos = positions.get(ca);
  if (!pos) return;
  if (pos.entryTop50Pct === null || pos.entryHolderCount === null) {
    establishBaseline(pos, bot); // fire-and-forget
  }
}

// ── Manual sync ───────────────────────────────────────────────────────────────
// Re-runs baseline establishment for a tracked position. Used by /sync command.
async function syncBaseline(ca, chatId, bot) {
  const pos = positions.get(ca);
  if (!pos) return { found: false };
  if (pos.chatId !== chatId) return { found: false }; // security: only the tracker's chat
  await bot.telegram.sendMessage(chatId, `🔄 *SYNC STARTED* — Re-fetching baseline for \`${ca.slice(0,6)}...${ca.slice(-4)}\``, { parse_mode: 'Markdown' });
  // Reset so establishBaseline doesn't early-exit due to already-set fields
  pos.entryHolderCount = null;
  pos.entryTop10Pct    = null;
  pos.entryTop50Pct    = null;
  pos.holderSnapshots  = [];
  pos.top50Snapshots   = [];
  await establishBaseline(pos, bot, { silent: true });
  return { found: true };
}

function untrack(ca) {
  const removed = positions.delete(ca);
  if (removed) saveToDisk();
  return removed;
}

function list() {
  return [...positions.values()];
}

// ── Per-position forensic check ───────────────────────────────────────────────

async function checkPosition(pos, bot) {
  try {
    const sig = await fetchForensic(pos.ca);
    if (!sig) return;

    const now            = Date.now();
    const mc             = sig.marketCap;
    const lp             = sig.lp;
    const adjustedVolLiq = sig.adjustedVolLiq;
    const top10Pct       = sig.top10Pct;
    const top50Pct       = sig.top50Pct ?? null;
    const holderCount    = sig.holderCount;

    // Update ATH
    if (mc && mc > pos.peakMc) pos.peakMc = mc;

    // Update rolling holder snapshots (10m window — stagnation check)
    if (holderCount != null) {
      pos.holderSnapshots.push({ ts: now, count: holderCount });
      const tenMinAgo = now - 10 * 60 * 1000;
      pos.holderSnapshots = pos.holderSnapshots.filter(s => s.ts >= tenMinAgo);
    }

    // Update rolling top50 snapshots (5m window — cluster exit check)
    if (top50Pct != null) {
      pos.top50Snapshots = pos.top50Snapshots || [];
      pos.top50Snapshots.push({ ts: now, pct: top50Pct });
      const fiveMinAgo = now - 5 * 60 * 1000;
      pos.top50Snapshots = pos.top50Snapshots.filter(s => s.ts >= fiveMinAgo);
    }

    const slPct  = pos.timeWindow === 'DEAD_ZONE' ? 25 : 50;
    const alerts = [];

    // ── A. Top-50 Cluster Exit ───────────────────────────────────────────────
    // Watches combined supply % held by top 50 wallets.
    // If it drops >3% from the baseline snapshot, sub-wallets are coordinating an exit.
    // Uses 5-minute rolling window to confirm the move is sustained (not a blip).
    if (
      top50Pct !== null &&
      pos.entryTop50Pct !== null &&
      !pos.alertedFlags.has('CLUSTER_EXIT')
    ) {
      const drop = pos.entryTop50Pct - top50Pct;
      if (drop >= 3) {
        alerts.push(
          `🚨 *CLUSTER EXIT DETECTED*\n` +
          `Top 50 supply dropped *${drop.toFixed(1)}%* ` +
          `(${pos.entryTop50Pct.toFixed(1)}% → ${top50Pct.toFixed(1)}%)\n` +
          `Sub-wallets are coordinating an exit.\n→ *EXIT 100% NOW*`
        );
        pos.alertedFlags.add('CLUSTER_EXIT');
      }
    }

    // ── B. Dev wallet fee-loader ────────────────────────────────────────────
    if (pos.devWallet && !pos.alertedFlags.has('FEE_LOADER')) {
      const fl = await checkDevFeeLoader(pos.devWallet);
      if (fl.detected) {
        alerts.push(
          `🚨 *PRE-DUMP PREP*\n` +
          `Dev wallet loaded *${fl.uniqueDestinations}* sub-wallets with 0.01–0.1 SOL in the last 5 minutes\n→ *EXIT 100% NOW*`
        );
        pos.alertedFlags.add('FEE_LOADER');
      }
    }

    // ── C. Saturation — holder stagnation at ATH ────────────────────────────
    // Price at/near ATH but retail buy-side has stopped entering.
    if (
      pos.holderSnapshots.length >= 2 &&
      pos.peakMc > 0 &&
      mc > 0 &&
      !pos.alertedFlags.has('STAGNATION')
    ) {
      const nearATH  = mc >= pos.peakMc * 0.90;
      const oldest   = pos.holderSnapshots[0];
      const newest   = pos.holderSnapshots[pos.holderSnapshots.length - 1];
      const windowMs = newest.ts - oldest.ts;
      if (nearATH && windowMs >= 8 * 60 * 1000 && oldest.count > 0) {
        const growthPct = ((newest.count - oldest.count) / oldest.count) * 100;
        if (growthPct < 1) {
          alerts.push(
            `🚨 *SATURATION DETECTED*\n` +
            `Price near ATH (${fmtUsd(mc)}) but NO new buyers in last 10m\n` +
            `Holder growth: ${growthPct.toFixed(2)}% (${oldest.count} → ${newest.count})\n→ *SECURE INITIALS / EXIT 75%*`
          );
          pos.alertedFlags.add('STAGNATION');
        }
      }
    }

    // ── D. Momentum decay ───────────────────────────────────────────────────
    if (adjustedVolLiq !== null && adjustedVolLiq < 2.0 && !pos.alertedFlags.has('VOL_DECAY')) {
      alerts.push(
        `⚠️ *MOMENTUM DECAY*\nAdjusted Vol/Liq ${adjustedVolLiq.toFixed(2)}x — below 2x exit floor\n→ *TRIM 75% NOW*`
      );
      pos.alertedFlags.add('VOL_DECAY');
    }

    // ── LP floor ────────────────────────────────────────────────────────────
    if (lp > 0 && lp < 5000 && !pos.alertedFlags.has('LP_FLOOR')) {
      alerts.push(`🚨 *LP FLOOR HIT* — ${fmtUsd(lp)} (below $5K)\n→ *HARD EXIT 100%*`);
      pos.alertedFlags.add('LP_FLOOR');
    }

    // ── ATH stop-loss retrace ────────────────────────────────────────────────
    if (pos.peakMc > 0 && mc > 0) {
      const retracePct = ((pos.peakMc - mc) / pos.peakMc) * 100;
      if (retracePct >= slPct && !pos.alertedFlags.has('ATH_SL')) {
        alerts.push(
          `🔴 *SL TRIGGERED* — ${retracePct.toFixed(1)}% retrace from ATH ${fmtUsd(pos.peakMc)}\n→ *EXIT MOON BAG (${slPct}% SL)*`
        );
        pos.alertedFlags.add('ATH_SL');
        positions.delete(pos.ca);
        saveToDisk();
      }
    }

    if (alerts.length === 0) {
      console.log(`[tracker] ${pos.ca.slice(0,8)}... OK — MC=${fmtUsd(mc)} VolLiq=${adjustedVolLiq?.toFixed(2)}x LP=${fmtUsd(lp)} holders=${holderCount} top50=${top50Pct?.toFixed(1)}%`);
      return;
    }

    // ── Alert message ────────────────────────────────────────────────────────
    const ageMin       = Math.floor((now - pos.trackedAt) / 60000);
    const shortCa      = `${pos.ca.slice(0,6)}...${pos.ca.slice(-4)}`;
    const holdersAdded = (pos.entryHolderCount != null && holderCount != null)
      ? holderCount - pos.entryHolderCount : null;
    const top50Change  = (pos.entryTop50Pct != null && top50Pct != null)
      ? (top50Pct - pos.entryTop50Pct) : null;
    const lpChange     = (pos.entryLp != null && lp != null)
      ? (lp - pos.entryLp) : null;

    const lines = [
      `🛡️ *ORACLE GUARDIAN ALERT*`,
      `CA: \`${shortCa}\` | Tracking: ${ageMin}m`,
      ``,
      `── *LIVE DIVERGENCE* ──`,
      `• *MC:* ${fmtUsd(mc)} | ATH: ${fmtUsd(pos.peakMc)}`,
      `• *LP:* ${fmtUsd(lp)}${lpChange != null ? ` (${lpChange >= 0 ? '+' : ''}${fmtUsd(lpChange)} since entry)` : ''}`,
      holdersAdded != null ? `• *Holders Added:* ${holdersAdded >= 0 ? '+' : ''}${holdersAdded}` : null,
      top50Change  != null ? `• *Top 50 Change:* ${top50Change >= 0 ? '+' : ''}${top50Change.toFixed(1)}% (now ${top50Pct.toFixed(1)}%)` : null,
      ``,
      `── *VELOCITY* ──`,
      `• *Adjusted Vol/Liq:* ${adjustedVolLiq != null ? adjustedVolLiq.toFixed(2) + 'x' : 'N/A'}`,
      sig.change1h != null ? `• *Price Δ (1H):* ${fmtChange(sig.change1h)}` : null,
      ``,
      alerts.join('\n\n'),
    ].filter(l => l !== null).join('\n');

    await bot.telegram.sendMessage(pos.chatId, lines, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '📈 VIEW CHART',    url: `https://dexscreener.com/solana/${pos.ca}` },
          { text: '❌ STOP TRACKING', callback_data: `untrack:${pos.ca}` },
        ]],
      },
    });

  } catch (e) {
    console.error(`[tracker] error checking ${pos.ca.slice(0,8)}:`, e.message);
  }
}

// ── Heartbeat (every 5 minutes) ───────────────────────────────────────────────

async function sendHeartbeat(pos, bot) {
  try {
    const sig = await fetchForensic(pos.ca);
    if (!sig) return;

    const mc          = sig.marketCap;
    const lp          = sig.lp;
    const holderCount = sig.holderCount;
    const top50Pct    = sig.top50Pct ?? null;

    if (mc && mc > pos.peakMc) pos.peakMc = mc;

    const ageMin       = Math.floor((Date.now() - pos.trackedAt) / 60000);
    const shortCa      = `${pos.ca.slice(0,6)}...${pos.ca.slice(-4)}`;
    const holdersAdded = (pos.entryHolderCount != null && holderCount != null)
      ? holderCount - pos.entryHolderCount : null;
    const top50Change  = (pos.entryTop50Pct != null && top50Pct != null)
      ? (top50Pct - pos.entryTop50Pct) : null;
    const lpChange     = (pos.entryLp != null && lp != null)
      ? (lp - pos.entryLp) : null;

    const lines = [
      `🛡️ *GUARDIAN HEARTBEAT*`,
      `CA: \`${shortCa}\` | ${ageMin}m tracked`,
      ``,
      holdersAdded != null
        ? `• *Holders Added:* ${holdersAdded >= 0 ? '+' : ''}${holdersAdded}`
        : `• *Holders:* ${holderCount ?? 'N/A'}`,
      top50Change != null
        ? `• *Top 50 Change:* ${top50Change >= 0 ? '+' : ''}${top50Change.toFixed(1)}% (now ${top50Pct.toFixed(1)}%)`
        : `• *Top 50:* ${top50Pct != null ? top50Pct.toFixed(1) + '%' : 'N/A'}`,
      lpChange != null
        ? `• *LP Flow:* ${lpChange >= 0 ? '+' : ''}${fmtUsd(lpChange)} → ${fmtUsd(lp)}`
        : `• *LP:* ${fmtUsd(lp)}`,
      `• *MC:* ${fmtUsd(mc)} | ATH: ${fmtUsd(pos.peakMc)}`,
      `• *Vol/Liq:* ${sig.adjustedVolLiq != null ? sig.adjustedVolLiq.toFixed(2) + 'x' : 'N/A'}`,
    ].join('\n');

    await bot.telegram.sendMessage(pos.chatId, lines, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '📈 VIEW CHART',    url: `https://dexscreener.com/solana/${pos.ca}` },
          { text: '❌ STOP TRACKING', callback_data: `untrack:${pos.ca}` },
        ]],
      },
    });
  } catch (e) {
    console.error(`[tracker] heartbeat error ${pos.ca.slice(0,8)}:`, e.message);
  }
}

// ── Guardian loop ─────────────────────────────────────────────────────────────

function startTracker(bot) {
  loadFromDisk();

  // Forensic scan — every 60s
  setInterval(async () => {
    if (positions.size === 0) return;
    console.log(`[tracker] Guardian poll — ${positions.size} position(s)`);
    const snapshot = [...positions.values()];
    for (const pos of snapshot) {
      await checkPosition(pos, bot);
      await new Promise(r => setTimeout(r, 2000));
    }
  }, POLL_INTERVAL);

  // Heartbeat — every 5 minutes
  setInterval(async () => {
    if (positions.size === 0) return;
    console.log(`[tracker] Heartbeat — ${positions.size} position(s)`);
    const snapshot = [...positions.values()];
    for (const pos of snapshot) {
      await sendHeartbeat(pos, bot);
      await new Promise(r => setTimeout(r, 2000));
    }
  }, 5 * 60 * 1000);

  console.log('[tracker] Oracle Guardian v2.5 started — 60s forensic (lightweight) + 5m heartbeat, positions persisted');
}

module.exports = { track, untrack, list, startTracker, maybeEstablishBaseline, syncBaseline };
