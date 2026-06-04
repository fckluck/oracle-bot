require('dotenv').config();

const config = {
  // Accept both names: Railway/live may use TELEGRAM_BOT_TOKEN,
  // older docs/dev env may use BOT_TOKEN.
  TELEGRAM_BOT_TOKEN:  process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '',
  ORACLE_VERSION:      process.env.ORACLE_VERSION || 'Oracle v38.6 — Controlled-Dirty Runner Patch',
  GMGN_API_KEY:        process.env.GMGN_API_KEY        || '',
  OWNER_TELEGRAM_ID:   process.env.OWNER_TELEGRAM_ID   || '',
  PUMPPORTAL_API_KEY:  process.env.PUMPPORTAL_API_KEY  || '',
  SESSION_SIZE_SOL: parseFloat(process.env.SESSION_SIZE_SOL || '0.15'),

  HUNT_DATA_MODE: process.env.HUNT_DATA_MODE || 'free',

  BIRDEYE_MODE: process.env.BIRDEYE_MODE || 'audit_only',
  BIRDEYE_HUNT_ENABLED: process.env.BIRDEYE_HUNT_ENABLED === 'true',

  DEFADE_MODE: process.env.DEFADE_MODE || 'buy_only_timed',
  DEFADE_MIN_INTERVAL_MS: parseInt(process.env.DEFADE_MIN_INTERVAL_MS || '6000', 10),
  DEFADE_DAILY_MAX_CALLS: parseInt(process.env.DEFADE_DAILY_MAX_CALLS || '100', 10),
  DEFADE_CACHE_TTL_MS: parseInt(process.env.DEFADE_CACHE_TTL_MS || '300000', 10),
  DEFADE_DISABLE_ON_AUTH_FAIL: process.env.DEFADE_DISABLE_ON_AUTH_FAIL !== 'false',

  GROK_MODE: process.env.GROK_MODE || 'audit_learning',
  GROK_HUNT_ONLY_SENT: process.env.GROK_HUNT_ONLY_SENT !== 'false',
  XAI_MODEL: process.env.XAI_MODEL || 'grok-4.3',

  GMGN_MODE: process.env.GMGN_MODE || 'audit_only',
  CODEX_MODE: process.env.CODEX_MODE || 'off',
  RUGCHECK_MODE: process.env.RUGCHECK_MODE || 'pre_alert_optional',

  AUDIT_BIRDEYE_MAX_PER_RUN: parseInt(process.env.AUDIT_BIRDEYE_MAX_PER_RUN || '10', 10),
  AUDIT_GROK_MAX_PER_RUN: parseInt(process.env.AUDIT_GROK_MAX_PER_RUN || '5', 10),
  AUDITDEEP_BIRDEYE_MAX_PER_RUN: parseInt(process.env.AUDITDEEP_BIRDEYE_MAX_PER_RUN || '25', 10),
  AUDITDEEP_GROK_MAX_PER_RUN: parseInt(process.env.AUDITDEEP_GROK_MAX_PER_RUN || '10', 10),

  DIRTY_RUNNER_WATCH_ENABLED: process.env.DIRTY_RUNNER_WATCH_ENABLED !== 'false',
  DIRTY_RUNNER_MIN_CONFIDENCE: parseFloat(process.env.DIRTY_RUNNER_MIN_CONFIDENCE || '0.70'),
  BLUEPRINT_HUNT_MIN_CONFIDENCE: parseFloat(process.env.BLUEPRINT_HUNT_MIN_CONFIDENCE || '0.68'),
  BLUEPRINT_SCOUT_SIZE_SOL: parseFloat(process.env.BLUEPRINT_SCOUT_SIZE_SOL || '0.05'),
  BLUEPRINT_SCOUT_STRONG_SIZE_SOL: parseFloat(process.env.BLUEPRINT_SCOUT_STRONG_SIZE_SOL || '0.10'),
  BLUEPRINT_HOT_WATCH_SIZE_SOL: parseFloat(process.env.BLUEPRINT_HOT_WATCH_SIZE_SOL || '0.03'),

  GROK_REQUIRED_FOR_BUY: process.env.GROK_REQUIRED_FOR_BUY === 'true',
  DEFADE_REQUIRED_FOR_BUY: process.env.DEFADE_REQUIRED_FOR_BUY === 'true',
  BIRDEYE_REQUIRED_FOR_HUNT: false,
  PUMPFUN_REQUIRED_FOR_HUNT: false,
  CODEX_REQUIRED_FOR_HUNT: false,
  GMGN_REQUIRED_FOR_HUNT: false,

  LP_MIN_USD:          parseFloat(process.env.LP_MIN_USD          || '15000'),
  AGE_MAX_MIN:         parseFloat(process.env.AGE_MAX_MIN         || '60'),
  VOL_LIQ_RATIO_MIN:  parseFloat(process.env.VOL_LIQ_RATIO_MIN   || '5.0'),
  TOP10_MAX_PCT:       parseFloat(process.env.TOP10_MAX_PCT        || '25'),  // v10.2.8: Goldilocks zone — 25% catches early accumulators, still blocks 30-40% dev rugs
  TOP10_HARD_MAX_PCT:  parseFloat(process.env.TOP10_HARD_MAX_PCT   || '25'), // v10.2.8: hard NO-GO threshold raised 15→25%
  CURVE_MAX_PCT:       parseFloat(process.env.CURVE_MAX_PCT        || '60'),
  CURVE_HARD_SKIP_PCT: parseFloat(process.env.CURVE_HARD_SKIP_PCT || '90'),
  DEV_SCORE_MIN:       parseFloat(process.env.DEV_SCORE_MIN        || '30'),

  // Broadcast floor (v13.0: lowered 5→3 to catch PRO_PILOT 3x BUYs and early signals)
  MIN_VOLLIQ_BROADCAST: parseFloat(process.env.MIN_VOLLIQ_BROADCAST || '3.0'),

  // Hunt alert mode:
  // strict = only final BUY verdicts are broadcast
  // watch = BUY + RISKY_RUNNER + WATCH_VOL/WATCH_WASH
  // all = legacy debug behavior; broadcasts anything over Vol/Liq floor
  HUNT_ALERT_MODE: process.env.HUNT_ALERT_MODE || 'strict',
  // Optional comma-separated override, e.g. "BUY,RISKY_RUNNER".
  HUNT_ALERT_VERDICTS: process.env.HUNT_ALERT_VERDICTS || '',

  // Card verbosity: short trader card by default; full forensic via DETAILS button.
  SCAN_CARD_MODE: process.env.SCAN_CARD_MODE || 'short',
  HUNT_CARD_MODE: process.env.HUNT_CARD_MODE || 'short',

  // Winner-family promotion sizing (tradeable scout, never full-size override).
  MISSED_WINNER_MATCH_SIZE_SOL: parseFloat(process.env.MISSED_WINNER_MATCH_SIZE_SOL || '0.10'),
  MISSED_WINNER_MATCH_STRONG_SIZE_SOL: parseFloat(process.env.MISSED_WINNER_MATCH_STRONG_SIZE_SOL || '0.15'),
  DIRTY_RUNNER_MIN_SIZE_SOL: parseFloat(process.env.DIRTY_RUNNER_MIN_SIZE_SOL || '0.05'),
  DIRTY_RUNNER_MAX_SIZE_SOL: parseFloat(process.env.DIRTY_RUNNER_MAX_SIZE_SOL || '0.10'),

  // Hunt Mode resilience. PumpPortal remains primary; DexScreener latest-profile
  // polling is a low-volume fallback so Hunt Mode does not go blind when WS events
  // are stale, blocked, or payload-shape changed.
  // v13.0: stale threshold lowered 120s→60s (pump.fun launches are frequent;
  //   60s without a frame is a real stale condition, not normal quiet).
  HUNT_WS_STALE_MS:           parseInt(process.env.HUNT_WS_STALE_MS || String(60 * 1000), 10),
  HUNT_FALLBACK_ENABLED:      process.env.HUNT_FALLBACK_ENABLED !== 'false',
  HUNT_FALLBACK_POLL_MS:      parseInt(process.env.HUNT_FALLBACK_POLL_MS || String(90 * 1000), 10),
  HUNT_FALLBACK_MAX_PER_POLL: parseInt(process.env.HUNT_FALLBACK_MAX_PER_POLL || '10', 10),
  HUNT_RECONNECT_HAMMER_MS:   parseInt(process.env.HUNT_RECONNECT_HAMMER_MS   || String(15 * 1000), 10),
  HUNT_WS_HANDSHAKE_TIMEOUT_MS: parseInt(process.env.HUNT_WS_HANDSHAKE_TIMEOUT_MS || String(15 * 1000), 10),

  // Some WebSocket gateways/datacenter firewalls behave better with a normal UA.
  HUNT_WS_USER_AGENT: process.env.HUNT_WS_USER_AGENT || 'OracleBot/10.2.4 Railway NodeWS',

  // TP levels (Discovery Window / normal hours)
  TP1_MC: parseFloat(process.env.TP1_MC || '100000'),
  TP2_MC: parseFloat(process.env.TP2_MC || '250000'),
  TP3_MC: parseFloat(process.env.TP3_MC || '500000'),

  // Dead Zone TP overrides
  DEAD_ZONE_TP1_MC: parseFloat(process.env.DEAD_ZONE_TP1_MC || '50000'),
};

module.exports = config;
