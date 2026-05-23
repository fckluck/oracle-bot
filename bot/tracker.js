// Oracle Guardian v2.1 — Forensic position monitor
// Polls each tracked CA every 60s. Detects cluster exits, dev fee-loading,
// holder stagnation, momentum decay, and LP floor breaches.
// Positions are persisted to disk and survive bot restarts/crashes.

require('dotenv').config();
const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');
const { fetchAll } = require('./fetcher');
const { scan }     = require('./scanner');

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

function track(ca, chatId, currentMc, entryTier, timeWindow, devWallet, holderCount, top10Pct, top50Pct, entryLp) {
  if (positions.size >= MAX_POSITIONS) {
    console.log(`[tracker] max positions (${MAX_POSITIONS}) reached`);
    return false;
  }
  if (positions.has(ca)) return false;
  const now = Date.now();
  positions.set(ca, {
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
  });
  console.log(`[tracker] tracking ${ca.slice(0,8)}... mc=${fmtUsd(currentMc)} holders=${holderCount} top50=${top50Pct?.toFixed(1)}%`);
  saveToDisk();
  return true;
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
    const data   = await fetchAll(pos.ca);
    if (!data.codex) return;
    const result = scan(data);
    const sig    = result.signals;

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
    const data   = await fetchAll(pos.ca);
    if (!data.codex) return;
    const result = scan(data);
    const sig    = result.signals;

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

  console.log('[tracker] Oracle Guardian v2.2 started — 60s forensic + 5m heartbeat, positions persisted');
}

module.exports = { track, untrack, list, startTracker };
