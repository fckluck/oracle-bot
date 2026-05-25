require('dotenv').config();

const config = {
  TELEGRAM_BOT_TOKEN:  process.env.TELEGRAM_BOT_TOKEN  || '',
  GMGN_API_KEY:        process.env.GMGN_API_KEY        || '',
  OWNER_TELEGRAM_ID:   process.env.OWNER_TELEGRAM_ID   || '',
  PUMPPORTAL_API_KEY:  process.env.PUMPPORTAL_API_KEY  || '',
  SESSION_SIZE_SOL: parseFloat(process.env.SESSION_SIZE_SOL || '0.15'),

  LP_MIN_USD:          parseFloat(process.env.LP_MIN_USD          || '10000'),
  AGE_MAX_MIN:         parseFloat(process.env.AGE_MAX_MIN         || '60'),
  VOL_LIQ_RATIO_MIN:  parseFloat(process.env.VOL_LIQ_RATIO_MIN   || '5.0'),
  TOP10_MAX_PCT:       parseFloat(process.env.TOP10_MAX_PCT        || '15'),  // ideal/clean threshold (UI warning)
  TOP10_HARD_MAX_PCT:  parseFloat(process.env.TOP10_HARD_MAX_PCT   || '15'), // v10.2.7: tightened 35→15 — Top10 >15% is NO-GO
  CURVE_MAX_PCT:       parseFloat(process.env.CURVE_MAX_PCT        || '60'),
  CURVE_HARD_SKIP_PCT: parseFloat(process.env.CURVE_HARD_SKIP_PCT || '90'),
  DEV_SCORE_MIN:       parseFloat(process.env.DEV_SCORE_MIN        || '30'),

  // Hunt Mode resilience. PumpPortal remains primary; DexScreener latest-profile
  // polling is a low-volume fallback so Hunt Mode does not go blind when WS events
  // are stale, blocked, or payload-shape changed.
  HUNT_WS_STALE_MS:           parseInt(process.env.HUNT_WS_STALE_MS || String(2 * 60 * 1000), 10),
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
