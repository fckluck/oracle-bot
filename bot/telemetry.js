'use strict';

const API_KEYS = {
  DexScreener: null,
  PumpFun: null,
  PumpPortal: 'PUMPPORTAL_API_KEY',
  Birdeye: 'BIRDEYE_API_KEY',
  SolanaTracker: 'SOLANATRACKER_API_KEY',
  SocialData: 'SOCIALDATA_API_KEY',
  Helius: 'HELIUS_API_KEY',
  Codex: 'CODEX_API_KEY',
  DeFade: 'DEFADE_API_KEY',
  Grok: 'XAI_API_KEY',
  GMGN: 'GMGN_API_KEY',
};

const apiStats = {};

function init(name) {
  if (!apiStats[name]) {
    apiStats[name] = {
      calls: 0,
      ok: 0,
      fail: 0,
      skipped: 0,
      lastAt: null,
      lastOk: null,
      lastMeta: null,
      lastError: null,
    };
  }
  return apiStats[name];
}

function hasKey(name) {
  const key = API_KEYS[name];
  if (!key) return true;
  return !!process.env[key];
}

function markApi(name, { ok = false, skipped = false, meta = null, error = null } = {}) {
  const s = init(name);
  s.lastAt = Date.now();
  if (skipped) {
    s.skipped++;
    s.lastOk = null;
    s.lastMeta = meta;
    s.lastError = error || null;
    return;
  }
  s.calls++;
  if (ok) {
    s.ok++;
    s.lastOk = true;
    s.lastMeta = meta;
    s.lastError = null;
  } else {
    s.fail++;
    s.lastOk = false;
    s.lastMeta = meta;
    s.lastError = error ? String(error).slice(0, 180) : 'unknown error';
  }
}

function esc(x) {
  return String(x ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ago(ts) {
  if (!ts) return 'never';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function apiStatusHtml() {
  const names = Object.keys(API_KEYS);
  const lines = names.map(name => {
    const keyName = API_KEYS[name];
    const configured = keyName ? !!process.env[keyName] : true;
    const s = init(name);
    let icon = '⚪';
    if (keyName && !configured) icon = '❌';
    else if (s.calls === 0 && s.skipped === 0) icon = '⚪';
    else if (s.lastOk === true) icon = '✅';
    else if (s.lastOk === false) icon = '🔴';
    else if (s.skipped > 0) icon = '🟡';
    const keyText = keyName ? (configured ? 'key yes' : 'key missing') : 'public';
    const gmgnNote = name === 'GMGN' ? ' | status: NOT WIRED' : '';
    const meta = s.lastMeta ? ` | ${esc(JSON.stringify(s.lastMeta)).slice(0, 120)}` : '';
    const err = s.lastError ? ` | err: ${esc(s.lastError)}` : '';
    return `${icon} <b>${name}</b> — ${keyText}${gmgnNote} | calls:${s.calls} ok:${s.ok} fail:${s.fail} skipped:${s.skipped} | last:${ago(s.lastAt)}${meta}${err}`;
  });
  return `<b>API Truth Panel</b>\n\n${lines.join('\n')}`;
}

function dataUsedHtml(used = {}) {
  const item = (label, value) => `${value ? '✅' : '❌'} ${label}`;
  return [
    item('Dex', used.dex),
    item('Pump', used.pump),
    item('Birdeye', used.birdeye),
    item('SolanaTracker', used.solanaTracker),
    item('SocialData', used.socialData),
    item('Helius', used.helius),
    item('Codex', used.codex),
    item('DeFade', used.deFade),
    item('Grok', used.grok),
  ].join(' | ');
}

function getApiStats() {
  return apiStats;
}

module.exports = { API_KEYS, hasKey, markApi, apiStatusHtml, dataUsedHtml, getApiStats };
