// Oracle Dip Alert Watchlist
// Tracks high-quality dip/re-entry setups from 🔔 ALERT button presses.

const fs = require('fs');
const path = require('path');
const { fetchForensic } = require('./fetcher');

function resolveWatchlistFile() {
  if (process.env.WATCHLIST_FILE) return process.env.WATCHLIST_FILE;
  try { fs.accessSync('/data', fs.constants.W_OK); return '/data/watchlist.json'; } catch (_) {}
  return path.join(__dirname, 'watchlist.json');
}

const PERSIST_FILE = resolveWatchlistFile();
const POLL_INTERVAL = 60 * 1000;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const pending = new Map();

function keyFor(ca, chatId) {
  return `${chatId}:${ca}`;
}

function fmtUsd(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return 'N/A';
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${v.toFixed(2)}`;
}

function saveToDisk() {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify([...pending.values()], null, 2));
  } catch (e) {
    console.error('[watchlist] save error:', e.message);
  }
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
    if (!Array.isArray(raw)) return;
    const now = Date.now();
    for (const entry of raw) {
      if (!entry.ca || !entry.chatId) continue;
      if (now - (entry.addedAt || 0) > MAX_AGE_MS) continue;
      pending.set(keyFor(entry.ca, entry.chatId), entry);
    }
    console.log(`[watchlist] loaded ${pending.size} dip alert(s) from disk`);
  } catch (e) {
    console.error('[watchlist] load error:', e.message);
  }
}

function add(ca, chatId, symbol, baseline = {}) {
  const key = keyFor(ca, chatId);
  if (pending.has(key)) return false;
  const now = Date.now();
  pending.set(key, {
    ca,
    chatId,
    symbol: symbol || '???',
    baselineMc: Number(baseline.baselineMc || 0),
    athMc: Number(baseline.athMc || baseline.baselineMc || 0),
    baselineLp: baseline.baselineLp ?? null,
    baselineHolders: baseline.baselineHolders ?? null,
    baselineTop10: baseline.baselineTop10 ?? null,
    baselineTop50: baseline.baselineTop50 ?? null,
    baselineVolLiq: baseline.baselineVolLiq ?? null,
    addedAt: now,
    lastCheckedAt: 0,
  });
  saveToDisk();
  return true;
}

function remove(ca, chatId) {
  if (chatId != null) {
    const removed = pending.delete(keyFor(ca, chatId));
    if (removed) saveToDisk();
    return removed;
  }
  let removed = false;
  for (const [k, entry] of pending.entries()) {
    if (entry.ca !== ca) continue;
    pending.delete(k);
    removed = true;
  }
  if (removed) saveToDisk();
  return removed;
}

function has(ca, chatId) {
  if (chatId != null) return pending.has(keyFor(ca, chatId));
  for (const entry of pending.values()) if (entry.ca === ca) return true;
  return false;
}

function list() {
  return [...pending.values()];
}

async function checkEntry(entry, bot) {
  const key = keyFor(entry.ca, entry.chatId);
  try {
    const sig = await fetchForensic(entry.ca);
    if (!sig) return;
    const now = Date.now();
    const currentMc = Number(sig.marketCap || 0);
    if (currentMc > entry.athMc) entry.athMc = currentMc;
    const ath = Math.max(entry.athMc || 0, entry.baselineMc || 0, currentMc || 0);
    const retracePct = ath > 0 && currentMc > 0 ? ((ath - currentMc) / ath) * 100 : 0;
    const lpStable = entry.baselineLp == null || sig.lp == null || sig.lp >= Number(entry.baselineLp) * 0.88;
    const holdersStable = entry.baselineHolders == null || sig.holderCount == null || sig.holderCount >= Number(entry.baselineHolders) * 0.92;
    const top10Stable = entry.baselineTop10 == null || sig.top10Pct == null || sig.top10Pct <= Number(entry.baselineTop10) + 3;
    const top50Stable = entry.baselineTop50 == null || sig.top50Pct == null || sig.top50Pct <= Number(entry.baselineTop50) + 3;
    const volumeAlive = (sig.adjustedVolLiq ?? 0) >= 2.5 ||
      (entry.baselineVolLiq != null && (sig.adjustedVolLiq ?? 0) >= Number(entry.baselineVolLiq) * 0.45);
    const noLpDrain = entry.baselineLp == null || sig.lp == null || sig.lp >= Number(entry.baselineLp) * 0.8;
    const qualified = retracePct >= 20 && retracePct <= 55 && lpStable && holdersStable && top10Stable && top50Stable && noLpDrain && volumeAlive;

    entry.lastCheckedAt = now;
    if (!qualified) {
      saveToDisk();
      return;
    }

    const lpStatus = lpStable ? 'stable' : 'unstable';
    const holderStatus = holdersStable ? 'stable' : 'falling';
    const risk = noLpDrain && volumeAlive ? 'moderate' : 'elevated';

    pending.delete(key);
    saveToDisk();

    await bot.telegram.sendMessage(
      entry.chatId,
      `🔔 *DIP ALERT*\n\n` +
      `High-quality retest forming.\n` +
      `MC: $${fmtUsd(currentMc)}\n` +
      `Retrace: ${retracePct.toFixed(1)}%\n` +
      `LP: ${lpStatus}\n` +
      `Holders: ${holderStatus}\n` +
      `Risk: ${risk}\n` +
      `CA: \`${entry.ca}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error(`[watchlist] dip check error for ${entry.ca.slice(0, 8)}:`, e.message);
  }
}

function start(bot) {
  loadFromDisk();
  const now = Date.now();
  for (const [k, entry] of pending.entries()) {
    if (now - (entry.addedAt || 0) > MAX_AGE_MS) pending.delete(k);
  }
  saveToDisk();

  setInterval(async () => {
    if (!pending.size) return;
    const snapshot = [...pending.values()];
    for (const entry of snapshot) {
      if (Date.now() - (entry.addedAt || 0) > MAX_AGE_MS) {
        pending.delete(keyFor(entry.ca, entry.chatId));
        continue;
      }
      await checkEntry(entry, bot);
      await new Promise(r => setTimeout(r, 1500));
    }
  }, POLL_INTERVAL);

  console.log(`[watchlist] dip alert monitoring started — ${pending.size} active`);
}

module.exports = { start, add, remove, list, has };
