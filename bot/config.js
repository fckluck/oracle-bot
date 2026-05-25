require('dotenv').config();

const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  GMGN_API_KEY: process.env.GMGN_API_KEY || '',
  OWNER_TELEGRAM_ID: process.env.OWNER_TELEGRAM_ID || '',
  SESSION_SIZE_SOL: parseFloat(process.env.SESSION_SIZE_SOL || '0.15'),

  LP_MIN_USD:          parseFloat(process.env.LP_MIN_USD          || '10000'),
  AGE_MAX_MIN:         parseFloat(process.env.AGE_MAX_MIN         || '60'),
  VOL_LIQ_RATIO_MIN:  parseFloat(process.env.VOL_LIQ_RATIO_MIN   || '5.0'),
  TOP10_MAX_PCT:       parseFloat(process.env.TOP10_MAX_PCT        || '15'),  // ideal/clean threshold (UI warning)
  TOP10_HARD_MAX_PCT:  parseFloat(process.env.TOP10_HARD_MAX_PCT   || '35'), // hard NO-GO threshold (scanner gate 8)
  CURVE_MAX_PCT:       parseFloat(process.env.CURVE_MAX_PCT        || '60'),
  CURVE_HARD_SKIP_PCT: parseFloat(process.env.CURVE_HARD_SKIP_PCT || '90'),
  DEV_SCORE_MIN:       parseFloat(process.env.DEV_SCORE_MIN        || '30'),

  // TP levels (Discovery Window / normal hours)
  TP1_MC: parseFloat(process.env.TP1_MC || '100000'),
  TP2_MC: parseFloat(process.env.TP2_MC || '250000'),
  TP3_MC: parseFloat(process.env.TP3_MC || '500000'),

  // Dead Zone TP overrides
  DEAD_ZONE_TP1_MC: parseFloat(process.env.DEAD_ZONE_TP1_MC || '50000'),
};

module.exports = config;
