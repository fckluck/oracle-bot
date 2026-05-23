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
//   ca, chatId, entryMc, peakMc, trackedAt, entryTier, timeWindow,
//   devWallet,
//   entryHolderCount, entryTop10Pct,
//   holderSnapshots: [{ ts, count }],   // rolling 10m window
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

function track(ca, chatId, currentMc, entryTier, timeWindow, devWallet, holderCount, top10Pct) {
  if (positions.size >= MAX_POSITIONS) {
    console.log(`[tracker] max positions (${MAX_POSITIONS}) reached`);
    return false;
  }
  if (positions.has(ca)) return false;
  positions.set(ca, {
    ca, chatId,
    entryMc:          currentMc,
    peakMc:           currentMc,
    trackedAt:        Date.now(),
    entryTier:        entryTier  || 'UNKNOWN',
    timeWindow:       timeWindow || 'DISCOVERY',
    devWallet:        devWallet  || null,
    entryHolderCount: holderCount ?? null,
    entryTop10Pct:    top10Pct   ?? null,
    holderSnapshots:  holderCount != null
      ? [{ ts: Date.now(), count: holderCount }]
      : [],
    alertedFlags: new Set(),
  });
  console.log(`[tracker] tracking ${ca.slice(0,8)}... chatId=${chatId} mc=${currentMc} holders=${holderCount} top10=${top10Pct?.toFixed(1)}%`);
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

    const mc             = sig.marketCap;
    const lp             = sig.lp;
    const adjustedVolLiq = sig.adjustedVolLiq;  // was incorrectly `sig.volLiq` before
    const top10Pct       = sig.top10Pct;
    const holderCount    = sig.holderCount;

    // Update ATH
    if (mc && mc > pos.peakMc) pos.peakMc = mc;

    // Update holder snapshot (rolling 10m window)
    if (holderCount != null) {
      pos.holderSnapshots.push({ ts: Date.now(), count: holderCount });
      // Keep only last 10 minutes of snapshots
      const tenMinAgo = Date.now() - 10 * 60 * 1000;
      pos.holderSnapshots = pos.holderSnapshots.filter(s => s.ts >= tenMinAgo);
    }

    const slPct  = pos.timeWindow === 'DEAD_ZONE' ? 25 : 50;
    const alerts = [];

    // ── A. Cluster exit — top10 concentration drop ──────────────────────────
    // If top10Pct drops >5pp from entry AND price is falling, coordinated selling.
    // (Full top-50 funder analysis would require ~50 RPC calls/min per position —
    //  impractical on free tier. Top10 delta gives the same exit signal.)
    if (
      top10Pct !== null &&
      pos.entryTop10Pct !== null &&
      !pos.alertedFlags.has('CLUSTER_EXIT')
    ) {
      const top10Drop = pos.entryTop10Pct - top10Pct;
      const priceFalling = sig.change1h !== null && sig.change1h < -10;
      if (top10Drop >= 5 && priceFalling) {
        alerts.push(
          `🚨 *CLUSTER EXIT* — Top 10 concentration dropped ${top10Drop.toFixed(1)}pp ` +
          `(${pos.entryTop10Pct.toFixed(1)}% → ${top10Pct.toFixed(1)}%) while price falling\n→ *EXIT 75% NOW*`
        );
        pos.alertedFlags.add('CLUSTER_EXIT');
      }
    }

    // ── B. Dev wallet fee-loader ────────────────────────────────────────────
    if (pos.devWallet && !pos.alertedFlags.has('FEE_LOADER')) {
      const fl = await checkDevFeeLoader(pos.devWallet);
      if (fl.detected) {
        alerts.push(
          `🚨 *PRE-DUMP PREP* — Dev wallet loaded *${fl.uniqueDestinations}* sub-wallets with 0.01–0.1 SOL in the last 5 minutes\n→ *EXIT 100% NOW*`
        );
        pos.alertedFlags.add('FEE_LOADER');
      }
    }

    // ── C. Community exhaustion — holder stagnation at ATH ──────────────────
    if (
      pos.holderSnapshots.length >= 2 &&
      pos.peakMc > 0 &&
      mc > 0 &&
      !pos.alertedFlags.has('STAGNATION')
    ) {
      const nearATH = mc >= pos.peakMc * 0.90; // within 10% of ATH
      const oldest  = pos.holderSnapshots[0];
      const newest  = pos.holderSnapshots[pos.holderSnapshots.length - 1];
      const windowMs = newest.ts - oldest.ts;
      if (nearATH && windowMs >= 8 * 60 * 1000 && oldest.count > 0) {
        const holderGrowthPct = ((newest.count - oldest.count) / oldest.count) * 100;
        if (holderGrowthPct < 1) {
          alerts.push(
            `⚠️ *COMMUNITY EXHAUSTION* — Price near ATH (${fmtUsd(mc)}) but holder growth ` +
            `${holderGrowthPct.toFixed(2)}% over 10m (${oldest.count} → ${newest.count})\n→ *SECURE INITIALS*`
          );
          pos.alertedFlags.add('STAGNATION');
        }
      }
    }

    // ── D. Momentum decay — adjusted vol/liq floor ──────────────────────────
    if (adjustedVolLiq !== null && adjustedVolLiq < 2.0 && !pos.alertedFlags.has('VOL_DECAY')) {
      alerts.push(
        `⚠️ *MOMENTUM DECAY* — Adjusted Vol/Liq ${adjustedVolLiq.toFixed(2)}x (below 2x exit floor)\n→ *TRIM 75% NOW*`
      );
      pos.alertedFlags.add('VOL_DECAY');
    }

    // ── LP floor — hard exit ─────────────────────────────────────────────────
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
        positions.delete(pos.ca); // auto-untrack
        saveToDisk();
      }
    }

    if (alerts.length === 0) {
      console.log(`[tracker] ${pos.ca.slice(0,8)}... OK — MC=${fmtUsd(mc)} Vol/Liq=${adjustedVolLiq?.toFixed(2)}x LP=${fmtUsd(lp)} holders=${holderCount}`);
      return;
    }

    // ── Alert UI ─────────────────────────────────────────────────────────────
    const ageMin    = Math.floor((Date.now() - pos.trackedAt) / 60000);
    const shortCa   = `${pos.ca.slice(0,6)}...${pos.ca.slice(-4)}`;
    const holdersAdded = (pos.entryHolderCount != null && holderCount != null)
      ? holderCount - pos.entryHolderCount
      : null;

    const header = [
      `🛡️ *ORACLE GUARDIAN ALERT*`,
      `CA: \`${shortCa}\` | Since: ${ageMin}m ago`,
      ``,
      `── *LIVE DIVERGENCE* ──`,
      `• *MC:* ${fmtUsd(mc)} | ATH: ${fmtUsd(pos.peakMc)}`,
      `• *LP:* ${fmtUsd(lp)}`,
      holdersAdded !== null
        ? `• *Holders Added:* ${holdersAdded >= 0 ? '+' : ''}${holdersAdded} (since tracking)`
        : null,
      top10Pct !== null
        ? `• *Top 10 Concentration:* ${top10Pct.toFixed(1)}%${pos.entryTop10Pct != null ? ` (was ${pos.entryTop10Pct.toFixed(1)}% at entry)` : ''}`
        : null,
      ``,
      `── *VELOCITY* ──`,
      `• *Adjusted Vol/Liq:* ${adjustedVolLiq != null ? adjustedVolLiq.toFixed(2) + 'x' : 'N/A'}`,
      sig.change1h != null ? `• *Price Δ (1H):* ${fmtChange(sig.change1h)}` : null,
    ].filter(Boolean).join('\n');

    const body = alerts.join('\n\n');
    const footer = `\n\n📈 [Chart](https://dexscreener.com/solana/${pos.ca})`;

    await bot.telegram.sendMessage(
      pos.chatId,
      header + '\n\n' + body + footer,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '📈 VIEW CHART',   url: `https://dexscreener.com/solana/${pos.ca}` },
            { text: '❌ STOP TRACKING', callback_data: `untrack:${pos.ca}` },
          ]],
        },
      }
    );

  } catch (e) {
    console.error(`[tracker] error checking ${pos.ca.slice(0,8)}:`, e.message);
  }
}

// ── Guardian loop ─────────────────────────────────────────────────────────────

function startTracker(bot) {
  loadFromDisk();
  setInterval(async () => {
    if (positions.size === 0) return;
    console.log(`[tracker] Guardian poll — ${positions.size} position(s)`);
    const snapshot = [...positions.values()];
    for (const pos of snapshot) {
      await checkPosition(pos, bot);
      await new Promise(r => setTimeout(r, 2000));
    }
  }, POLL_INTERVAL);
  console.log('[tracker] Oracle Guardian v2.1 started — polling every 60s, positions persisted to disk');
}

module.exports = { track, untrack, list, startTracker };
