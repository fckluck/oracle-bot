'use strict';

const config = require('./config');

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
  RugCheck: null,
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
      lastSkipReason: null,
      lastResult: 'never',
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
    s.lastSkipReason = meta?.reason || null;
    s.lastResult = 'skipped';
    return;
  }
  s.calls++;
  if (ok) {
    s.ok++;
    s.lastOk = true;
    s.lastMeta = meta;
    s.lastError = null;
    s.lastSkipReason = null;
    s.lastResult = 'ok';
  } else {
    s.fail++;
    s.lastOk = false;
    s.lastMeta = meta;
    s.lastError = error ? String(error).slice(0, 180) : 'unknown error';
    s.lastSkipReason = null;
    s.lastResult = 'failed';
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

function statusIcon(name, keyName, configured, s) {
  if (keyName && !configured) return '❌';
  if (s.lastResult === 'ok') return '✅';
  if (s.lastResult === 'failed') return '🔴';
  if (s.lastResult === 'skipped') return '⚪';
  if (s.calls === 0 && s.skipped === 0) return '⚪';
  return '❌';
}

function inferModeFor(name) {
  if (name === 'Birdeye') return config.BIRDEYE_MODE;
  if (name === 'DeFade') return config.DEFADE_MODE;
  if (name === 'Grok') return config.GROK_MODE;
  if (name === 'GMGN') return config.GMGN_MODE;
  if (name === 'Codex') return config.CODEX_MODE;
  if (name === 'RugCheck') return config.RUGCHECK_MODE;
  return 'always';
}

function inferRequiredFor(name) {
  if (name === 'Grok') return !!config.GROK_REQUIRED_FOR_BUY;
  if (name === 'DeFade') return !!config.DEFADE_REQUIRED_FOR_BUY;
  if (name === 'Birdeye') return !!config.BIRDEYE_REQUIRED_FOR_HUNT;
  if (name === 'PumpFun') return !!config.PUMPFUN_REQUIRED_FOR_HUNT;
  if (name === 'Codex') return !!config.CODEX_REQUIRED_FOR_HUNT;
  if (name === 'GMGN') return !!config.GMGN_REQUIRED_FOR_HUNT;
  if (name === 'DexScreener' || name === 'SolanaTracker' || name === 'SocialData') return true;
  return false;
}

function getDeFadeRuntimeBlock() {
  try {
    // Lazy require avoids a module cycle at startup.
    const { getDeFadeRuntime } = require('./fetcher');
    if (typeof getDeFadeRuntime !== 'function') return null;
    const rt = getDeFadeRuntime();
    return `DeFade Runtime:\n` +
      `daily=${rt.dailyCalls}/${rt.dailyMaxCalls} | minInterval=${rt.minIntervalMs}ms | cooldown=${rt.cooldownRemainingMs}ms | cache=${rt.cacheSize} | ttl=${rt.cacheTtlMs}ms` +
      `${rt.autoDisabled ? ` | autoDisabled=${esc(rt.autoDisabledReason || 'yes')}` : ''}`;
  } catch (_) {
    return null;
  }
}

function apiStatusHtml() {
  const names = Object.keys(API_KEYS);
  const modeLines = [
    'Modes:',
    `HUNT_DATA_MODE=${config.HUNT_DATA_MODE}`,
    `BIRDEYE_MODE=${config.BIRDEYE_MODE}`,
    `BIRDEYE_HUNT_ENABLED=${config.BIRDEYE_HUNT_ENABLED}`,
    `BIRDEYE HUNT: ${config.BIRDEYE_HUNT_ENABLED ? 'SOFT ENABLED' : 'HARD BLOCKED'}`,
    `DEFADE_MODE=${config.DEFADE_MODE}`,
    `GROK_MODE=${config.GROK_MODE}`,
    `GROK_HUNT_ONLY_SENT=${config.GROK_HUNT_ONLY_SENT}`,
    `XAI_MODEL=${config.XAI_MODEL}`,
    `GMGN_MODE=${config.GMGN_MODE}`,
    `CODEX_MODE=${config.CODEX_MODE}`,
    `RUGCHECK_MODE=${config.RUGCHECK_MODE}`,
    `Audit Caps: birdeye ${config.AUDIT_BIRDEYE_MAX_PER_RUN}/${config.AUDITDEEP_BIRDEYE_MAX_PER_RUN} | grok ${config.AUDIT_GROK_MAX_PER_RUN}/${config.AUDITDEEP_GROK_MAX_PER_RUN}`,
  ];
  const lines = names.map(name => {
    const keyName = API_KEYS[name];
    const configured = keyName ? !!process.env[keyName] : true;
    const s = init(name);
    const icon = statusIcon(name, keyName, configured, s);
    const keyText = keyName ? (configured ? 'key yes' : 'key missing') : 'public';
    const gmgnNote = name === 'GMGN' ? ' | status: NOT WIRED (unless explicitly wired)' : '';
    const mode = inferModeFor(name);
    const required = inferRequiredFor(name) ? 'required' : 'optional';
    const meta = s.lastMeta ? ` | ${esc(JSON.stringify(s.lastMeta)).slice(0, 120)}` : '';
    const err = s.lastError ? ` | err: ${esc(s.lastError)}` : '';
    const skip = s.lastSkipReason ? ` | skip:${esc(s.lastSkipReason)}` : '';
    return `${icon} <b>${name}</b> — ${keyText}${gmgnNote} | mode:${mode} | ${required} | calls:${s.calls} ok:${s.ok} fail:${s.fail} skipped:${s.skipped} | last:${ago(s.lastAt)}${meta}${skip}${err}`;
  });
  const runtime = getDeFadeRuntimeBlock();
  const head = `<b>API Truth Panel</b>\n\n${modeLines.map(esc).join('\n')}\n`;
  return `${head}${runtime ? `\n${esc(runtime)}\n` : '\n'}\n${lines.join('\n')}`;
}

function dataUsedHtml(used = {}) {
  const format = (label, raw) => {
    if (raw && typeof raw === 'object') {
      const status = String(raw.status || '').toLowerCase();
      if (status === 'ok') return `✅ ${label}`;
      if (status === 'skipped') return `⚪ ${label}${raw.reason ? ` skipped: ${esc(raw.reason)}` : ''}`;
      if (status === 'failed') return `🔴 ${label}${raw.reason ? ` failed: ${esc(raw.reason)}` : ''}`;
      return `❌ ${label}`;
    }
    if (raw === true) return `✅ ${label}`;
    if (raw === false) return `❌ ${label}`;
    if (typeof raw === 'string') {
      const v = raw.toLowerCase();
      if (v.startsWith('ok')) return `✅ ${label}`;
      if (v.startsWith('skip') || v === 'optional_offline' || v === 'off' || v === 'not_required') return `⚪ ${label}`;
      if (v.startsWith('fail') || v === 'error') return `🔴 ${label}`;
      if (v === 'missing' || v === 'unavailable' || v === 'not_wired') return `❌ ${label}`;
    }
    return `❌ ${label}`;
  };
  return [
    format('Dex', used.dex),
    format('Pump', used.pump),
    format('Birdeye', used.birdeye),
    format('SolanaTracker', used.solanaTracker),
    format('SocialData', used.socialData),
    format('Helius', used.helius),
    format('Codex', used.codex),
    format('DeFade', used.deFade),
    format('Grok', used.grok),
    format('GMGN', used.gmgn),
    format('RugCheck', used.rugcheck),
  ].join(' | ');
}

function getApiStats() {
  return apiStats;
}

module.exports = { API_KEYS, hasKey, markApi, apiStatusHtml, dataUsedHtml, getApiStats };
