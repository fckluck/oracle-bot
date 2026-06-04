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
const HARD_DANGER_TTL_MS = 10 * 60 * 1000;

// v10.2.7: persist on Railway volume if available. Order:
//   1. POSITIONS_FILE env override (explicit)
//   2. /data/positions.json (Railway volume convention)
//   3. bot/positions.json (dev / no volume — wiped on Railway redeploy)
function resolvePersistFile() {
  if (process.env.POSITIONS_FILE) return process.env.POSITIONS_FILE;
  try { fs.accessSync('/data', fs.constants.W_OK); return '/data/positions.json'; } catch (_) {}
  return path.join(__dirname, 'positions.json');
}
const PERSIST_FILE = resolvePersistFile();
const DATA_DIR = process.env.DATA_DIR || '/data';
console.log(`[tracker] persist file: ${PERSIST_FILE}`);

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
const { formatEt, formatUtc } = require('./time');
function actionTimeMarkdown(label = 'Action Time') { return `🕒 *${label}:* ${formatEt()} | ${formatUtc()}`; }

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
    const text = fs.readFileSync(PERSIST_FILE, 'utf8');
    let raw = null;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const corruptPath = PERSIST_FILE.replace(/\.json$/i, '') + `.corrupt.${ts}.json`;
      fs.renameSync(PERSIST_FILE, corruptPath);
      console.error(`[tracker] positions JSON parse failed (${e.message}). Preserved corrupt file: ${corruptPath}`);
      return;
    }
    if (!Array.isArray(raw)) return;
    for (const p of raw) {
      p.alertedFlags    = new Set(p.alertedFlags || []);
      p.holderSnapshots = p.holderSnapshots || [];
      p.top50Snapshots  = p.top50Snapshots || [];
      p.priceSnapshots  = p.priceSnapshots || [];
      p.hardDangerFlags = p.hardDangerFlags || [];
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
        `${actionTimeMarkdown('Guardian Time')}\n\n🔄 *GUARDIAN BASELINE PENDING*\n\`${shortCa}\` — Holder data unavailable at entry. Retrying every 10s (up to 2 min)...`,
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
          `${actionTimeMarkdown('Guardian Time')}\n\n✅ *GUARDIAN BASELINE SET*\n` +
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
  await bot.telegram.sendMessage(chatId, `${actionTimeMarkdown('Sync Time')}\n\n🔄 *SYNC STARTED* — Re-fetching baseline for \`${ca.slice(0,6)}...${ca.slice(-4)}\``, { parse_mode: 'Markdown' });
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

// ── Shakeout Diagnostic ────────────────────────────────────────────────────────
// Returns { jeetExit: bool } if data confirms a shakeout, null otherwise.
// A shakeout = price flush but on-chain health is intact.
// Requires holder baseline to be established — won't fire on missing data.
function detectShakeout(pos, lp, holderCount, top50Pct) {
  // Criterion 1: holder resilience (not dropped >3% from entry)
  if (pos.entryHolderCount == null || holderCount == null) return null;
  if (holderCount < pos.entryHolderCount * 0.97) return null;

  // Criterion 2: LP stability (not removed >10%)
  if (pos.entryLp != null && lp != null && pos.entryLp > 0) {
    if (lp < pos.entryLp * 0.90) return null;
  }

  // Criterion 3: top50 stable or improving (no cluster concentration rise).
  if (pos.entryTop50Pct != null && top50Pct != null && top50Pct > pos.entryTop50Pct * 1.05) return null;

  // Jeet-exit confirmation: top 50 wallets are still holding firm
  const jeetExit = (top50Pct != null && pos.entryTop50Pct != null)
    ? top50Pct <= pos.entryTop50Pct * 1.05
    : false;

  return { jeetExit };
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

    // Baseline retry on normal Guardian polls for pending entries.
    if (pos.entryMc == null || pos.entryMc <= 0) pos.entryMc = mc ?? pos.entryMc ?? 0;
    if (pos.entryLp == null && lp != null) pos.entryLp = lp;
    if (pos.entryHolderCount == null && holderCount != null) {
      pos.entryHolderCount = holderCount;
      pos.holderSnapshots = [{ ts: now, count: holderCount }];
    }
    if (pos.entryTop10Pct == null && top10Pct != null) pos.entryTop10Pct = top10Pct;
    if (pos.entryTop50Pct == null && top50Pct != null) {
      pos.entryTop50Pct = top50Pct;
      pos.top50Snapshots = [{ ts: now, pct: top50Pct }];
    }

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

    // Update rolling price snapshots (90s window — candle-crush detection).
    // 90s gives ~2 polls of headroom so a slightly delayed poll still catches the move.
    if (mc != null && mc > 0) {
      pos.priceSnapshots = pos.priceSnapshots || [];
      pos.priceSnapshots.push({ ts: now, mc });
      const ninetySecAgo = now - 90 * 1000;
      pos.priceSnapshots = pos.priceSnapshots.filter(s => s.ts >= ninetySecAgo);
    }

    const slPct  = pos.timeWindow === 'DEAD_ZONE' ? 25 : 50;
    const alerts = [];
    const hardNow = [];
    pos.hardDangerFlags = pos.hardDangerFlags || [];

    const addHardDanger = (key, reason, action = 'EXIT') => {
      const existing = pos.hardDangerFlags.find(f => f.key === key);
      if (existing) {
        existing.ts = now;
        existing.reason = reason;
        existing.action = action;
      } else {
        pos.hardDangerFlags.push({ key, reason, action, ts: now });
      }
      hardNow.push({ key, reason, action, ts: now });
    };

    const activeHardDanger = () => (pos.hardDangerFlags || [])
      .filter(f => now - (f.ts || 0) <= HARD_DANGER_TTL_MS);

    // ── 0. CANDLE CRUSH (highest priority — sub-minute rug detection) ───────
    // If MC dropped >25% within the last 90s, broadcast IMMEDIATELY before any
    // other check. Beats the 60s forensic poll for fast rugs like $MANNY.
    if (mc != null && mc > 0 && (pos.priceSnapshots?.length ?? 0) >= 2 && !pos.alertedFlags.has('CANDLE_CRUSH')) {
      const maxMc = Math.max(...pos.priceSnapshots.map(s => s.mc));
      const dropPct = ((maxMc - mc) / maxMc) * 100;
      if (dropPct > 30) {
        addHardDanger('CANDLE_CRUSH', `candle crush ${dropPct.toFixed(1)}% in <90s`, 'EXIT');
        alerts.push(
          `🚨 *ORACLE EMERGENCY: CANDLE CRUSH*\n` +
          `Price dropped *${dropPct.toFixed(1)}%* in <90s ` +
          `(${fmtUsd(maxMc)} → ${fmtUsd(mc)})\n` +
          `→ *EXIT 100% IMMEDIATELY. RUG IN PROGRESS.*`
        );
        pos.alertedFlags.add('CANDLE_CRUSH');
        positions.delete(pos.ca);
        saveToDisk();
      }
    }

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
        addHardDanger('CLUSTER_EXIT', `top50 supply dropped ${drop.toFixed(1)}%`, 'EXIT');
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
        addHardDanger('FEE_LOADER', `dev wallet loaded ${fl.uniqueDestinations} sub-wallets`, 'EXIT');
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
      if ((sig.change1h ?? 0) < 0) addHardDanger('VOL_DECAY', `adjusted Vol/Liq ${adjustedVolLiq.toFixed(2)}x while price is falling`, 'TRIM');
      alerts.push(
        `⚠️ *MOMENTUM DECAY*\nAdjusted Vol/Liq ${adjustedVolLiq.toFixed(2)}x — below 2x exit floor\n→ *TRIM 75% NOW*`
      );
      pos.alertedFlags.add('VOL_DECAY');
    }

    // ── LP floor ────────────────────────────────────────────────────────────
    if (lp > 0 && lp < 5000 && !pos.alertedFlags.has('LP_FLOOR')) {
      addHardDanger('LP_FLOOR', `LP floor breached at ${fmtUsd(lp)}`, 'EXIT');
      alerts.push(`🚨 *LP FLOOR HIT* — ${fmtUsd(lp)} (below $5K)\n→ *HARD EXIT 100%*`);
      pos.alertedFlags.add('LP_FLOOR');
    }

    if (pos.entryLp != null && lp != null && pos.entryLp > 0 && lp < pos.entryLp * 0.80) {
      addHardDanger('LP_DRAIN', `LP dropped ${(((pos.entryLp - lp) / pos.entryLp) * 100).toFixed(1)}% from entry`, 'EXIT');
    }
    if (pos.entryHolderCount != null && holderCount != null && holderCount < pos.entryHolderCount * 0.90) {
      addHardDanger('HOLDER_DROP', `holders dropped ${(((pos.entryHolderCount - holderCount) / pos.entryHolderCount) * 100).toFixed(1)}% from entry`, 'EXIT');
    }
    if (pos.entryTop50Pct != null && top50Pct != null && top50Pct > pos.entryTop50Pct + 3) {
      addHardDanger('TOP50_RISE', `top50 concentration rose ${((top50Pct - pos.entryTop50Pct)).toFixed(1)}%`, 'EXIT');
    }

    // ── ATH stop-loss retrace + Shakeout Diagnostic ─────────────────────────
    if (pos.peakMc > 0 && mc > 0) {
      const retracePct = ((pos.peakMc - mc) / pos.peakMc) * 100;
      const hardActive = activeHardDanger();

      // Early advisory: ≥20% flush before SL fires — warn if on-chain health is still green.
      // Fires once (SHAKEOUT_20) so it doesn't spam every 60s poll.
      if (
        retracePct >= 20 &&
        !pos.alertedFlags.has('ATH_SL') &&
        !pos.alertedFlags.has('SHAKEOUT_20')
      ) {
        const shakeout = detectShakeout(pos, lp, holderCount, top50Pct);
        if (shakeout && hardActive.length === 0) {
          const jeetLine = shakeout.jeetExit
            ? `\n⚠️ *JEET EXIT:* Top 50 holding firm — weak hands are flushing.`
            : '';
          alerts.push(
            `💎 *SHAKEOUT DETECTED* — Price flushed *${retracePct.toFixed(1)}%* from ATH.\n` +
            `Holders are NOT selling. LP is stable.${jeetLine}\n` +
            `→ *HOLD THE LINE. Reversal expected.*`
          );
          pos.alertedFlags.add('SHAKEOUT_20');
        } else if (shakeout && hardActive.length > 0 && !pos.alertedFlags.has('SHAKEOUT_CONFLICT')) {
          const reasons = hardActive.map(f => `• ${f.reason}`).join('\n');
          const action = hardActive.some(f => f.action === 'EXIT') ? 'EXIT' : 'TRIM';
          alerts.push(
            `⚠️ *CONFLICT: EXIT SIGNAL HAS PRIORITY*\n` +
            `Shakeout invalidated by:\n${reasons}\n` +
            `Action: *${action}* based on highest severity.`
          );
          pos.alertedFlags.add('SHAKEOUT_CONFLICT');
        }
      }

      // SL check — paused once if shakeout is confirmed (one grace poll).
      // If price keeps falling through the grace, SL fires on the next trigger.
      if (retracePct >= slPct && !pos.alertedFlags.has('ATH_SL')) {
        const shakeout = detectShakeout(pos, lp, holderCount, top50Pct);
        if (shakeout && !pos.alertedFlags.has('SHAKEOUT_SL_PAUSE') && hardActive.length === 0) {
          const jeetLine = shakeout.jeetExit
            ? `\n⚠️ *JEET EXIT:* Top 50 holding firm. Manufactured flush.`
            : '';
          alerts.push(
            `🛡️ *SL PAUSED — SHAKEOUT CONFIRMED*\n` +
            `${retracePct.toFixed(1)}% retrace from ATH ${fmtUsd(pos.peakMc)} — but holders are firm.${jeetLine}\n` +
            `→ *HOLD POSITION.* One SL grace given. If price continues lower, SL fires next poll.`
          );
          pos.alertedFlags.add('SHAKEOUT_SL_PAUSE');
        } else if (shakeout && hardActive.length > 0 && !pos.alertedFlags.has('SHAKEOUT_CONFLICT_SL')) {
          const reasons = hardActive.map(f => `• ${f.reason}`).join('\n');
          alerts.push(
            `⚠️ *CONFLICT: EXIT SIGNAL HAS PRIORITY*\n` +
            `Shakeout invalidated by:\n${reasons}\n` +
            `Action: *EXIT / TRIM* based on highest severity.`
          );
          pos.alertedFlags.add('SHAKEOUT_CONFLICT_SL');
        } else {
          // No shakeout detected (rug), or grace already used — fire the stop loss.
          alerts.push(
            `🔴 *SL TRIGGERED* — ${retracePct.toFixed(1)}% retrace from ATH ${fmtUsd(pos.peakMc)}\n→ *EXIT MOON BAG (${slPct}% SL)*`
          );
          pos.alertedFlags.add('ATH_SL');
          positions.delete(pos.ca);
          saveToDisk();
        }
      }
    }

    if (alerts.length === 0) {
      console.log(`[tracker] ${pos.ca.slice(0,8)}... OK — MC=${fmtUsd(mc)} VolLiq=${adjustedVolLiq?.toFixed(2)}x LP=${fmtUsd(lp)} holders=${holderCount} top50=${top50Pct?.toFixed(1)}%`);
      saveToDisk();
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
      `${actionTimeMarkdown('Guardian Alert Time')}\n\n🛡️ *ORACLE GUARDIAN ALERT*`,
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
    saveToDisk();

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
      `${actionTimeMarkdown('Heartbeat Time')}\n\n🛡️ *GUARDIAN HEARTBEAT*`,
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
    console.log(`[GUARDIAN] Heartbeat sent for CA: ${pos.ca}`);
  } catch (e) {
    console.error(`[GUARDIAN] Heartbeat FAILED for CA: ${pos.ca} —`, e.message);
  }
}

// ── Guardian loop ─────────────────────────────────────────────────────────────

function startTracker(bot) {
  loadFromDisk();

  // v10.2.8: re-trigger baseline for positions that survived a restart without
  // one (e.g. bot crashed during the 2-min retry window in the previous session).
  // Without this, Cluster Exit and Saturation triggers never fire for those
  // positions because entryTop50Pct / entryHolderCount stay null indefinitely.
  // Delay 8s so bot.launch() polling is established before we try to send msgs.
  setTimeout(() => {
    for (const pos of positions.values()) {
      if (pos.entryTop50Pct === null || pos.entryHolderCount === null) {
        console.log(`[tracker] restart: re-triggering baseline for ${pos.ca.slice(0,8)} (no baseline from prior session)`);
        maybeEstablishBaseline(pos.ca, bot);
      }
    }
  }, 8000);

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

  // Heartbeat — every 5 minutes, staggered non-blocking so a slow fetchForensic
  // on one position can't delay the heartbeat for all others.
  setInterval(() => {
    if (positions.size === 0) return;
    console.log(`[GUARDIAN] Heartbeat firing — ${positions.size} position(s)`);
    [...positions.values()].forEach((pos, i) => {
      setTimeout(() => {
        sendHeartbeat(pos, bot).catch(e =>
          console.error(`[GUARDIAN] Heartbeat error ${pos.ca.slice(0,8)}:`, e.message)
        );
      }, i * 2000);
    });
  }, 5 * 60 * 1000);

  console.log('[tracker] Oracle Guardian v10.2 (Spine-Aligned) — 60s forensic + 90s candle-crush + 5m heartbeat, positions persisted');
}

function getMemoryStats() {
  return {
    dataDir: DATA_DIR,
    positionsFile: PERSIST_FILE,
    trackedPositionsCount: positions.size,
    usingFallbackFile: !PERSIST_FILE.startsWith('/data/'),
  };
}

module.exports = {
  DATA_DIR,
  PERSIST_FILE,
  track,
  untrack,
  list,
  startTracker,
  maybeEstablishBaseline,
  syncBaseline,
  getMemoryStats,
};
