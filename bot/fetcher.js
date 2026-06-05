require('dotenv').config();
const fetch = require('node-fetch');
const { markApi } = require('./telemetry');
const config = require('./config');

const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/tokens/';
const CODEX_GQL       = 'https://graph.codex.io/graphql';
const PUMPFUN_URL     = 'https://frontend-api.pump.fun/coins/';
const PUMPFUN_USER    = 'https://frontend-api.pump.fun/coins/user-created-coins/';
const JUPITER_PRICE   = 'https://price.jup.ag/v4/price?ids=';
const SOLANA_RPC      = 'https://api.mainnet-beta.solana.com';
const BIRDEYE_BASE    = 'https://public-api.birdeye.so';
const SOCIALDATA_BASE = 'https://api.socialdata.tools';


const defadeCache = new Map();
let defadeDailyCounter = { day: new Date().toISOString().slice(0, 10), calls: 0 };
let defadeLastCallAt = 0;
let defadeAutoDisabledReason = null;

function resetDefadeDailyIfNeeded() {
  const day = new Date().toISOString().slice(0, 10);
  if (defadeDailyCounter.day !== day) {
    defadeDailyCounter = { day, calls: 0 };
  }
}

function getFetchContext(opts = {}) {
  if (opts.huntMode) return 'hunt';
  if (opts.deepMode) return 'auditdeep';
  if (opts.auditMode) return 'audit';
  if (opts.manualMode) return 'manual';
  return 'unknown';
}

function birdeyeAllowed(opts = {}) {
  if (opts.huntMode && !config.BIRDEYE_HUNT_ENABLED) return false;
  if (opts.skipBirdeye) return false;
  if (config.BIRDEYE_MODE === 'off') return false;
  if (config.BIRDEYE_MODE === 'all') return true;
  if (config.BIRDEYE_MODE === 'manual_and_audit') return !!(opts.manualMode || opts.auditMode || opts.deepMode);
  if (config.BIRDEYE_MODE === 'audit_only') return !!(opts.auditMode || opts.deepMode);
  return false;
}

function heliusRpc() {
  const key = process.env.HELIUS_API_KEY;
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : null;
}

// ── DexScreener ──────────────────────────────────────────────────────────────

async function fetchDexScreener(ca) {
  try {
    const res = await fetch(`${DEXSCREENER_URL}${ca}`, {
      headers: { 'Accept': 'application/json' }, timeout: 8000,
    });
    if (!res.ok) { markApi('DexScreener', { ok: false, error: `HTTP ${res.status}` }); console.log(`[fetchDexScreener] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const sol = (data.pairs || []).filter(p => p.chainId === 'solana');
    if (!sol.length) { markApi('DexScreener', { ok: false, error: 'no Solana pairs' }); console.log('[fetchDexScreener] no Solana pairs'); return null; }
    sol.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    // Prefer the highest-liquidity pair that actually has LP > 0 (avoids Phantom LP / stale pairs)
    const top = sol.find(p => (p.liquidity?.usd || 0) > 0) || sol[0];
    const lp    = top.liquidity?.usd || 0;
    const vol1h = top.volume?.h1     || 0;
    const mc    = top.marketCap || 0;
    const dexId = top.dexId || null;
    markApi('DexScreener', { ok: true, meta: { lp, vol1h, mc, dexId } });
    return {
      pairAddress:   top.pairAddress  || null,
      name:          top.baseToken?.name   || 'UNKNOWN',
      symbol:        top.baseToken?.symbol || '???',
      priceUsd:      parseFloat(top.priceUsd || '0'),
      marketCap:     mc,
      lp, volume1h: vol1h,
      // Bonding-curve tokens have LP=$0 (no Raydium pool yet).
      // Use market cap as the denominator so vol/liq is meaningful pre-graduation.
      volLiq:        lp > 0 ? vol1h / lp : (mc > 0 ? vol1h / mc : 0),
      buyCount:      top.txns?.h1?.buys  || 0,
      sellCount:     top.txns?.h1?.sells || 0,
      uniqueWallets: null,
      change1h:      top.priceChange?.h1 || 0,
      pairCreatedAt: top.pairCreatedAt || null,
      ageMinutes:    top.pairCreatedAt
                       ? Math.floor((Date.now() - top.pairCreatedAt) / 60000) : null,
      dexId,
      isMeteora:     dexId === 'meteora',
    };
  } catch (e) { markApi('DexScreener', { ok: false, error: e.message }); console.error('[fetchDexScreener] error:', e.message); return null; }
}

// ── SolanaTracker (Truth source for pump.fun creator + dev history) ─────────
// SolanaTracker indexes pump.fun create instructions, so it has the real
// fee-payer-as-creator mapping that Helius DAS lacks. Two endpoints:
//   /tokens/{ca}       → token.creation.{creator, created_tx, created_time}
//   /deployer/{wallet} → { total, graduated:{total, data:[...]}, data:[...] }
// Both return null gracefully when SOLANATRACKER_API_KEY is missing.

const ST_BASE = 'https://data.solanatracker.io';
const PUMPFUN_INITIAL_MC_USD = 5000;

async function fetchSolanaTrackerToken(ca) {
  const key = process.env.SOLANATRACKER_API_KEY;
  if (!key) { markApi('SolanaTracker', { skipped: true, meta: { endpoint: 'token', reason: 'missing_key' } }); return null; }
  try {
    const res = await fetch(`${ST_BASE}/tokens/${ca}`, {
      headers: { 'x-api-key': key, 'Accept': 'application/json' },
      timeout: 8000,
    });
    if (!res.ok) { markApi('SolanaTracker', { ok: false, meta: { endpoint: 'token' }, error: `HTTP ${res.status}` }); console.log(`[fetchSolanaTrackerToken] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const creation = data?.token?.creation || null;
    const creator    = creation?.creator    || null;
    const createdTx  = creation?.created_tx || null;
    const createdAt  = creation?.created_time ? creation.created_time * 1000 : null;
    // Holder count — ST indexes this for many tokens (may be absent for very fresh ones)
    const holderCount = typeof data?.token?.holders === 'number' ? data.token.holders : null;
    // Bonus signals
    const snipersPct  = data?.risk?.snipers?.totalPercentage  ?? null;
    const insidersPct = data?.risk?.insiders?.totalPercentage ?? null;
    const riskScore   = data?.risk?.score ?? null;
    console.log(`[fetchSolanaTrackerToken] creator=${creator || 'null'} holders=${holderCount ?? 'null'} snipers=${snipersPct} risk=${riskScore}`);
    markApi('SolanaTracker', { ok: true, meta: { endpoint: 'token', creator: !!creator, holders: holderCount, snipersPct, riskScore } });
    return { creator, createdTx, createdAt, holderCount, snipersPct, insidersPct, riskScore };
  } catch (e) { markApi('SolanaTracker', { ok: false, meta: { endpoint: 'token' }, error: e.message }); console.error('[fetchSolanaTrackerToken] error:', e.message); return null; }
}

// ── SolanaTracker holders (full count + concentration) ──────────────────────
// /tokens/{ca}/holders returns { total, accounts: [{ percentage }] }
// Gives both full holder count AND top10/top3 concentration — better than Helius alone.

async function fetchSolanaTrackerHolders(ca) {
  const key = process.env.SOLANATRACKER_API_KEY;
  if (!key) { markApi('SolanaTracker', { skipped: true, meta: { endpoint: 'holders', reason: 'missing_key' } }); return null; }
  try {
    const res = await fetch(`${ST_BASE}/tokens/${ca}/holders`, {
      headers: { 'x-api-key': key, 'Accept': 'application/json' },
      timeout: 8000,
    });
    if (!res.ok) { markApi('SolanaTracker', { ok: false, meta: { endpoint: 'holders' }, error: `HTTP ${res.status}` }); console.log(`[fetchSolanaTrackerHolders] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const total = typeof data?.total === 'number' ? data.total : null;
    if (!total) { markApi('SolanaTracker', { ok: false, meta: { endpoint: 'holders' }, error: 'no total holders' }); return null; }
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    const top20Pct = accounts.slice(0, 20).reduce((s, a) => s + (a.percentage || 0), 0) || null;
    const topWallets = accounts.slice(0, 50).map(a => ({
      address: a.address || a.wallet || a.owner || null,
      owner: a.owner || a.wallet || a.address || null,
      uiAmount: a.uiAmount ?? a.amount ?? a.balance ?? null,
      percentage: a.percentage ?? null,
    }));
    const top3Pct  = accounts.slice(0, 3).reduce((s, a)  => s + (a.percentage || 0), 0) || null;
    const top10Pct = accounts.slice(0, 10).reduce((s, a) => s + (a.percentage || 0), 0) || null;
    const top50Pct = accounts.slice(0, 50).reduce((s, a) => s + (a.percentage || 0), 0) || null;
    console.log(`[fetchSolanaTrackerHolders] total=${total} top10=${top10Pct?.toFixed(1)}% top50=${top50Pct?.toFixed(1)}%`);
    markApi('SolanaTracker', { ok: true, meta: { endpoint: 'holders', holders: total, top10Pct } });
    return { holderCount: total, top3Pct, top10Pct, top20Pct, top50Pct, topWallets, source: 'solanatracker-holders' };
  } catch (e) { markApi('SolanaTracker', { ok: false, meta: { endpoint: 'holders' }, error: e.message }); console.error('[fetchSolanaTrackerHolders] error:', e.message); return null; }
}

async function fetchSolanaTrackerDeployer(wallet) {
  if (!wallet) { markApi('SolanaTracker', { skipped: true, meta: { endpoint: 'deployer', reason: 'no_wallet' } }); return null; }
  const key = process.env.SOLANATRACKER_API_KEY;
  if (!key) { markApi('SolanaTracker', { skipped: true, meta: { endpoint: 'deployer', reason: 'missing_key' } }); return null; }
  try {
    const res = await fetch(`${ST_BASE}/deployer/${wallet}`, {
      headers: { 'x-api-key': key, 'Accept': 'application/json' },
      timeout: 10000,
    });
    if (!res.ok) { markApi('SolanaTracker', { ok: false, meta: { endpoint: 'deployer' }, error: `HTTP ${res.status}` }); console.log(`[fetchSolanaTrackerDeployer] HTTP ${res.status}`); return null; }
    const r = await res.json();
    // Preserve null for missing fields so scanner can fall back to legacy devStats.
    // Only coerce to numbers when SolanaTracker actually returned the field.
    const totalLaunches  = typeof r?.total === 'number' ? r.total : null;
    const migratedCount  = typeof r?.graduated?.total === 'number' ? r.graduated.total : null;
    const winRate        = (totalLaunches !== null && totalLaunches > 0 && migratedCount !== null)
      ? +(migratedCount / totalLaunches * 100).toFixed(2)
      : null;
    // Peak MC across BOTH arrays — graduated.data is the ATH proxy (these reached Raydium)
    const all = [...(r?.data || []), ...(r?.graduated?.data || [])];
    let peakMc = null;
    for (const t of all) {
      const mc = Number(t?.marketCapUsd);
      if (isFinite(mc) && mc > 0 && (peakMc === null || mc > peakMc)) peakMc = mc;
    }
    const topPerformerMultiplier = peakMc !== null
      ? +(peakMc / PUMPFUN_INITIAL_MC_USD).toFixed(2) : null;
    console.log(`[fetchSolanaTrackerDeployer] launches=${totalLaunches} migrated=${migratedCount} winRate=${winRate}% peakMc=${peakMc} mult=${topPerformerMultiplier}x`);
    markApi('SolanaTracker', { ok: true, meta: { endpoint: 'deployer', totalLaunches, migratedCount, topPerformerMultiplier } });
    return {
      totalLaunches, migratedCount, winRate,
      peakMc, topPerformerMultiplier,
      assetCount: all.length,
    };
  } catch (e) { markApi('SolanaTracker', { ok: false, meta: { endpoint: 'deployer' }, error: e.message }); console.error('[fetchSolanaTrackerDeployer] error:', e.message); return null; }
}

// ── Birdeye (Alpha Tier) ──────────────────────────────────────────────────────
// Fetches 5m OHLCV candles to derive: 5m price change, 1H high/low, range position.

// Birdeye Token Overview — used solely to fetch the *total* holder count
// (avoids the Helius top-20 floor problem). Returns { holderCount } or null.

async function fetchBirdeyeOverview(ca) {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) { markApi('Birdeye', { skipped: true, meta: { endpoint: 'overview', reason: 'missing_key' } }); return null; }
  const headers = { 'X-API-KEY': key, 'Accept': 'application/json', 'x-chain': 'solana' };
  try {
    const res = await fetch(`${BIRDEYE_BASE}/defi/token_overview?address=${ca}`, { headers, timeout: 8000 });
    if (!res.ok) { markApi('Birdeye', { ok: false, meta: { endpoint: 'overview' }, error: `HTTP ${res.status}` }); console.log(`[fetchBirdeyeOverview] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const dd = data?.data ?? {};
    // Birdeye returns holder counts under inconsistent field names — check them all.
    const holderCount = dd.holder ?? dd.holders ?? dd.holder_count ?? dd.holderCount ??
                        dd.numberHolders ?? dd.number_holders ?? dd.holderAmount ?? dd.holder_amount ??
                        dd.uniqueHolders ?? dd.unique_holders ?? null;
    if (holderCount == null || isNaN(Number(holderCount))) {
      console.log(`[fetchBirdeyeOverview] no holder field — available keys: ${Object.keys(dd).filter(k => k.toLowerCase().includes('holder')).join(', ') || '(none)'}`);
    }
    // Wash-volume signals across multiple time windows (fallback for fresh tokens)
    // Windows ordered longest→shortest; we pick the best populated one in fetchAll.
    const n = (v) => (v != null && Number(v) > 0 ? Number(v) : null);
    const windows = {
      w1h:  { trade: n(dd.trade1h),   unique: n(dd.uniqueWallet1h),  vUsd: n(dd.v1hUSD),   scale: 1   },
      w30m: { trade: n(dd.trade30m),  unique: n(dd.uniqueWallet30m), vUsd: n(dd.v30mUSD),  scale: 2   },
      w5m:  { trade: n(dd.trade5m),   unique: n(dd.uniqueWallet5m),  vUsd: n(dd.v5mUSD),   scale: 12  },
      w1m:  { trade: n(dd.trade1m),   unique: n(dd.uniqueWallet1m),  vUsd: n(dd.v1mUSD),   scale: 60  },
    };
    const bestWindow = Object.entries(windows).find(([, w]) => w.trade && w.unique) ?? null;
    const bw = bestWindow ? bestWindow[1] : null;
    const bwLabel = bestWindow ? bestWindow[0] : null;
    console.log(`[fetchBirdeyeOverview] holders=${holderCount ?? 'null'} bestWindow=${bwLabel ?? 'none'} trade=${bw?.trade ?? 0} unique=${bw?.unique ?? 0}`);
    if (holderCount == null && !bw) { markApi('Birdeye', { ok: false, meta: { endpoint: 'overview' }, error: 'no holder or wash fields' }); return null; }
    markApi('Birdeye', { ok: true, meta: { endpoint: 'overview', holderCount: holderCount != null ? Number(holderCount) : null, washWindow: bwLabel } });
    return {
      holderCount: holderCount != null ? Number(holderCount) : null,
      washWindow:  bwLabel,
      washTrade:   bw?.trade  ?? null,
      washUnique:  bw?.unique ?? null,
      washVUsd:    bw?.vUsd   ?? null,
      washScale:   bw?.scale  ?? null,
    };
  } catch (e) { markApi('Birdeye', { ok: false, meta: { endpoint: 'overview' }, error: e.message }); console.error('[fetchBirdeyeOverview] error:', e.message); return null; }
}

async function fetchBirdeye(ca) {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) { markApi('Birdeye', { skipped: true, meta: { endpoint: 'ohlcv', reason: 'missing_key' } }); console.log('[fetchBirdeye] BIRDEYE_API_KEY not set'); return null; }
  const headers = { 'X-API-KEY': key, 'Accept': 'application/json', 'x-chain': 'solana' };
  const nowTs       = Math.floor(Date.now() / 1000);
  const twoHoursAgo = nowTs - 7200;
  try {
    const res = await fetch(
      `${BIRDEYE_BASE}/defi/ohlcv?address=${ca}&type=5m&time_from=${twoHoursAgo}&time_to=${nowTs}`,
      { headers, timeout: 8000 }
    );
    if (!res.ok) { markApi('Birdeye', { ok: false, meta: { endpoint: 'ohlcv' }, error: `HTTP ${res.status}` }); console.log(`[fetchBirdeye] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const candles = data?.data?.items || [];
    if (!candles.length) { markApi('Birdeye', { ok: false, meta: { endpoint: 'ohlcv' }, error: 'no candles' }); console.log('[fetchBirdeye] no candles'); return null; }

    const last   = candles[candles.length - 1];
    const prev   = candles[candles.length - 2] || null;

    const priceChange5m = (prev && prev.c > 0) ? ((last.c - prev.c) / prev.c) * 100 : null;
    const high1h  = Math.max(...candles.map(c => c.h));
    const low1h   = Math.min(...candles.map(c => c.l));
    const rangePct = (high1h > low1h) ? (last.c - low1h) / (high1h - low1h) : null;

    // Velocity: most-recent 5m candle's volume as a share of the last 60 min total.
    // >25% means the last 5 minutes absorbed more than 2× the average 5m slice —
    // a genuine acceleration signal. Birdeye OHLCV returns `v` per candle (USD vol).
    const last12    = candles.slice(-12); // last 60 min = 12 × 5m candles
    const vol1hTot  = last12.reduce((s, c) => s + (c.v ?? 0), 0);
    const vol5mLast = last.v ?? 0;
    const volAccel  = vol1hTot > 0 ? (vol5mLast / vol1hTot) : null; // 0–1 fraction

    console.log(`[fetchBirdeye] candles=${candles.length} 5mChange=${priceChange5m?.toFixed(2)}% range=${(rangePct != null ? (rangePct*100).toFixed(0) : 'N/A')}% velocity=${volAccel != null ? (volAccel*100).toFixed(0)+'%' : 'N/A'}`);
    markApi('Birdeye', { ok: true, meta: { endpoint: 'ohlcv', priceChange5m, rangePct, volAccel } });
    return { priceChange5m, high1h, low1h, rangePct, currentClose: last.c, volAccel };
  } catch (e) { markApi('Birdeye', { ok: false, meta: { endpoint: 'ohlcv' }, error: e.message }); console.error('[fetchBirdeye] error:', e.message); return null; }
}

// ── Bundle Detection + Parent Funding Sybil Trace (v6.0) ────────────────────
// Step 1: slot-cluster check from last 20 txns on pair.
// Step 2: if clustering indicates a bundle (maxInSlot >= 3), sample buyer wallets
//         and trace each one's first-tx fee payer to identify the parent funder.
// Step 3: if N+ buyers share <= 50% as many funding sources, flag SYBIL.

async function rpcCall(endpoint, method, params, id = 1) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    timeout: 6000,
  });
  if (!res.ok) return null;
  return res.json();
}

async function fetchBundleAndFunding(pairAddress) {
  if (!pairAddress) return null;
  const endpoint = heliusRpc() || SOLANA_RPC;
  try {
    const data = await rpcCall(endpoint, 'getSignaturesForAddress', [pairAddress, { limit: 20 }]);
    const sigs = data?.result || [];
    if (!sigs.length) {
      return { bundleDetected: false, maxInSlot: 0, sybilDetected: false, uniqueSigners: 0, fundingSources: 0 };
    }

    const slotCounts = {};
    for (const sig of sigs) {
      if (sig.slot != null) slotCounts[sig.slot] = (slotCounts[sig.slot] || 0) + 1;
    }
    const maxInSlot = Math.max(...Object.values(slotCounts));
    const bundleDetected = maxInSlot >= 5;

    // Cheap path: no clustering present, skip expensive parent trace
    if (maxInSlot < 3) {
      console.log(`[fetchBundle] maxInSlot=${maxInSlot} (no clustering, skipping parent trace)`);
      return { bundleDetected: false, maxInSlot, sybilDetected: false, uniqueSigners: 0, fundingSources: 0 };
    }

    // Sample 6 most-recent txns, extract fee payer of each (the buyer)
    const sampleSigs = sigs.slice(0, 6);
    const txResults = await Promise.all(sampleSigs.map(s =>
      rpcCall(endpoint, 'getTransaction',
        [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]
      ).catch(() => null)
    ));
    const uniqueSigners = new Set();
    for (const tx of txResults) {
      const signer = tx?.result?.transaction?.message?.accountKeys?.[0];
      if (signer) uniqueSigners.add(signer);
    }

    if (uniqueSigners.size < 3) {
      console.log(`[fetchBundle] maxInSlot=${maxInSlot} only ${uniqueSigners.size} signers (skipping sybil)`);
      return { bundleDetected, maxInSlot, sybilDetected: false, uniqueSigners: uniqueSigners.size, fundingSources: 0 };
    }

    // For each buyer, trace their first tx and identify the FUNDER (the account
    // whose SOL balance decreased to credit this wallet). Fee payer = the wallet
    // itself, so we use pre/postBalance deltas instead.
    const fundingSources = new Set();
    let tracesResolved = 0;
    await Promise.all([...uniqueSigners].map(async (signer) => {
      try {
        const walletSigs = await rpcCall(endpoint, 'getSignaturesForAddress', [signer, { limit: 1000 }]);
        const list = walletSigs?.result || [];
        if (!list.length || list.length >= 1000) return; // skip old / very-active wallets
        const oldestSig = list[list.length - 1].signature;
        const firstTx = await rpcCall(endpoint, 'getTransaction',
          [oldestSig, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
        const tx = firstTx?.result;
        if (!tx) return;

        const keys = tx.transaction?.message?.accountKeys || [];
        const pre  = tx.meta?.preBalances  || [];
        const post = tx.meta?.postBalances || [];
        if (!keys.length || pre.length !== keys.length || post.length !== keys.length) return;

        const signerIdx = keys.indexOf(signer);
        // Find the non-self account whose balance decreased the most → the funder
        let funder = null, maxDecrease = 0;
        for (let i = 0; i < keys.length; i++) {
          if (i === signerIdx) continue;
          const decrease = pre[i] - post[i];
          if (decrease > maxDecrease) { maxDecrease = decrease; funder = keys[i]; }
        }
        if (funder) { fundingSources.add(funder); tracesResolved++; }
      } catch (_) { /* skip on error */ }
    }));

    // SYBIL: among wallets we COULD trace, funding is highly concentrated.
    // Require at least 3 successful traces before flagging — fewer is noisy.
    const sybilDetected =
      tracesResolved >= 3 && fundingSources.size <= Math.floor(tracesResolved * 0.5);
    console.log(`[fetchBundle] maxInSlot=${maxInSlot} signers=${uniqueSigners.size} traced=${tracesResolved} sources=${fundingSources.size} sybil=${sybilDetected}`);
    return {
      bundleDetected, maxInSlot, sybilDetected,
      uniqueSigners: uniqueSigners.size, fundingSources: fundingSources.size,
      tracesResolved,
    };
  } catch (e) { console.error('[fetchBundle] error:', e.message); return null; }
}

// ── pump.fun token stats (replaces dead PumpPortal REST endpoint) ─────────────
// GET https://frontend-api.pump.fun/coins/{ca}
// Returns: name, symbol, creator, complete, raydium_pool, virtual_sol_reserves,
//          virtual_token_reserves, usd_market_cap, twitter, telegram, website, etc.
// NOTE: does NOT return holder_count — that comes from Codex/Helius/SolanaTracker.

const PUMPFUN_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

async function fetchPumpPortal(ca) {
  try {
    const res = await fetch(`${PUMPFUN_URL}${ca}`, { headers: PUMPFUN_HEADERS, timeout: 6000 });
    if (!res.ok) { markApi('PumpFun', { ok: false, error: `HTTP ${res.status}` }); console.log(`[fetchPumpPortal] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const migrated = data.complete === true || !!data.raydium_pool;
    // Approximate bonding-curve progress from virtual reserves.
    // Pump.fun reserves: initial vToken ≈ 1,073,000,191 × 10^6 raw, graduated at 206,900,000 × 10^6.
    const curvePct = migrated ? 100 : (() => {
      const vt = data.virtual_token_reserves;
      if (!vt) return null;
      const progress = (1 - (vt - 206_900_000_000_000) / 793_100_000_000_000) * 100;
      return Math.max(0, Math.min(99, Math.round(progress * 10) / 10));
    })();
    console.log(`[fetchPumpPortal] migrated=${migrated} curvePct=${curvePct} mc=$${data.usd_market_cap || data.market_cap || 0}`);
    markApi('PumpFun', { ok: true, meta: { migrated, curvePct, mc: data.usd_market_cap || data.market_cap || 0 } });
    return {
      name:           data.name        || 'UNKNOWN',
      symbol:         data.symbol      || '???',
      holderCount:    null,            // not available in pump.fun coin API
      curvePct,
      migrated,
      devWallet:      data.creator     || null,
      marketCap:      data.usd_market_cap || data.market_cap || 0,
      vSolReserves:   data.virtual_sol_reserves   || 0,
      vTokenReserves: data.virtual_token_reserves || 0,
      description:    data.description || '',
      twitter:        data.twitter     || null,
      telegram:       data.telegram    || null,
      website:        data.website     || null,
    };
  } catch (e) { markApi('PumpFun', { ok: false, error: e.message }); console.error('[fetchPumpPortal] error:', e.message); return null; }
}

// ── pump.fun dev stats (replaces dead PumpPortal user-stats endpoint) ─────────
// GET https://frontend-api.pump.fun/coins/user-created-coins/{wallet}?offset=0&limit=200
// Returns array of coin objects; complete=true / raydium_pool!=null = graduated.

async function fetchDevStats(devWallet) {
  if (!devWallet) { markApi('PumpFun', { skipped: true, meta: { endpoint: 'devStats', reason: 'no_wallet' } }); return null; }
  try {
    const res = await fetch(
      `${PUMPFUN_USER}${devWallet}?offset=0&limit=200`,
      { headers: PUMPFUN_HEADERS, timeout: 8000 }
    );
    if (!res.ok) { markApi('PumpFun', { ok: false, meta: { endpoint: 'devStats' }, error: `HTTP ${res.status}` }); console.log(`[fetchDevStats] HTTP ${res.status}`); return null; }
    const data = await res.json();
    if (!Array.isArray(data)) { console.log('[fetchDevStats] unexpected shape'); return null; }
    const totalLaunches = data.length;
    const migratedCount = data.filter(c => c.complete === true || !!c.raydium_pool).length;
    const winRate       = totalLaunches > 0 ? +(migratedCount / totalLaunches * 100).toFixed(2) : null;
    console.log(`[fetchDevStats] launches=${totalLaunches} migrated=${migratedCount} winRate=${winRate}%`);
    markApi('PumpFun', { ok: true, meta: { endpoint: 'devStats', totalLaunches, migratedCount, winRate } });
    return { totalLaunches, migratedCount, winRate };
  } catch (e) { markApi('PumpFun', { ok: false, meta: { endpoint: 'devStats' }, error: e.message }); console.error('[fetchDevStats] error:', e.message); return null; }
}

// ── Helius — Token Creator fallback ──────────────────────────────────────────

async function fetchTokenCreator(ca) {
  const endpoint = heliusRpc();
  if (!endpoint) { markApi('Helius', { skipped: true, meta: { endpoint: 'tokenCreator', reason: 'missing_key' } }); return null; }
  try {
    // Step 1: DAS getAsset (works for NFTs; often empty for fungible SPL tokens)
    const assetRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: ca } }),
      timeout: 6000,
    });
    if (assetRes.ok) {
      const asset = await assetRes.json();
      const creators     = asset?.result?.creators    || [];
      const authorities  = asset?.result?.authorities || [];
      const primary = creators.find(c => c.verified) || creators[0];
      if (primary?.address) { console.log(`[fetchTokenCreator] from getAsset creators: ${primary.address}`); return primary.address; }
      const auth = authorities.find(a => a.scopes?.includes('full')) || authorities[0];
      if (auth?.address) { console.log(`[fetchTokenCreator] from getAsset authority: ${auth.address}`); return auth.address; }
    }
    // Step 2: oldest transaction on mint → fee payer is the creator
    const sigsRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2,
        method: 'getSignaturesForAddress',
        params: [ca, { limit: 1000 }],
      }),
      timeout: 8000,
    });
    if (!sigsRes.ok) { console.log(`[fetchTokenCreator] sigs HTTP ${sigsRes.status}`); return null; }
    const sigsData = await sigsRes.json();
    const sigs = sigsData?.result || [];
    if (!sigs.length) { markApi('Helius', { ok: false, meta: { endpoint: 'tokenCreator' }, error: 'no signatures' }); return null; }
    const oldestSig = sigs[sigs.length - 1].signature;
    const txRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3,
        method: 'getTransaction',
        params: [oldestSig, { encoding: 'json', maxSupportedTransactionVersion: 0 }],
      }),
      timeout: 8000,
    });
    if (!txRes.ok) { markApi('Helius', { ok: false, meta: { endpoint: 'tokenCreator' }, error: `HTTP ${txRes.status}` }); console.log(`[fetchTokenCreator] tx HTTP ${txRes.status}`); return null; }
    const txData = await txRes.json();
    const creator = txData?.result?.transaction?.message?.accountKeys?.[0] ?? null;
    console.log(`[fetchTokenCreator] from oldest tx: ${creator}`);
    markApi('Helius', { ok: true, meta: { endpoint: 'tokenCreator', creator: !!creator } });
    return creator;
  } catch (e) { markApi('Helius', { ok: false, meta: { endpoint: 'tokenCreator' }, error: e.message }); console.error('[fetchTokenCreator] error:', e.message); return null; }
}

// ── Helius — Dev Top Performer (v6.0) ────────────────────────────────────────
// Queries BOTH getAssetsByCreator and getAssetsByOwner in parallel, dedupes, and
// computes the dev's historical peak MC. Multiplier = peak / $5K (pump.fun start).

async function fetchDevPeak(devWallet) {
  if (!devWallet) { markApi('Helius', { skipped: true, meta: { endpoint: 'devPeak', reason: 'no_wallet' } }); return null; }
  const endpoint = heliusRpc();
  if (!endpoint) { markApi('Helius', { skipped: true, meta: { endpoint: 'devPeak', reason: 'missing_key' } }); console.log('[fetchDevPeak] HELIUS_API_KEY not set'); return null; }
  const PUMPFUN_INITIAL_MC = 5000;

  try {
    const [byCreator, byOwner] = await Promise.all([
      rpcCall(endpoint, 'getAssetsByCreator', {
        creatorAddress: devWallet, onlyVerified: false, page: 1, limit: 1000,
        displayOptions: { showFungible: true },
      }).catch(() => null),
      rpcCall(endpoint, 'getAssetsByOwner', {
        ownerAddress: devWallet, page: 1, limit: 1000,
        displayOptions: { showFungible: true, showUnverifiedCollections: true },
      }).catch(() => null),
    ]);

    const creatorItems = byCreator?.result?.items || [];
    const ownerItemsRaw = byOwner?.result?.items   || [];

    // Filter owner items to those where dev is in the creators array → actual creations
    const ownerItemsFiltered = ownerItemsRaw.filter(item => {
      const creators = item?.creators || [];
      return creators.some(c => c?.address === devWallet);
    });

    const all = new Map();
    for (const item of [...creatorItems, ...ownerItemsFiltered]) {
      if (item?.id && item.id !== devWallet) all.set(item.id, item);
    }

    let highestMc = null;
    for (const item of all.values()) {
      const mc = item?.token_info?.price_info?.total_price ?? null;
      if (mc !== null && mc > 0 && (highestMc === null || mc > highestMc)) highestMc = mc;
    }
    const topPerformerMultiplier = (highestMc !== null && highestMc > 0)
      ? highestMc / PUMPFUN_INITIAL_MC : null;

    console.log(`[fetchDevPeak] creator=${creatorItems.length} owner=${ownerItemsRaw.length}(${ownerItemsFiltered.length} as creator) unique=${all.size} peakMc=${highestMc} mult=${topPerformerMultiplier?.toFixed(2)}x`);
    markApi('Helius', { ok: true, meta: { endpoint: 'devPeak', assetCount: all.size, highestMc, topPerformerMultiplier } });
    return { assetCount: all.size, highestMc, topPerformerMultiplier };
  } catch (e) { markApi('Helius', { ok: false, meta: { endpoint: 'devPeak' }, error: e.message }); console.error('[fetchDevPeak] error:', e.message); return null; }
}

// ── Wallet Age + Last Activity ────────────────────────────────────────────────

async function fetchWalletAge(devWallet) {
  if (!devWallet) { markApi('Helius', { skipped: true, meta: { endpoint: 'walletAge', reason: 'no_wallet' } }); return null; }
  const endpoint = heliusRpc() || SOLANA_RPC;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [devWallet, { limit: 1000 }],
      }),
      timeout: 8000,
    });
    if (!res.ok) { markApi('Helius', { ok: false, meta: { endpoint: 'walletAge' }, error: `HTTP ${res.status}` }); console.log(`[fetchWalletAge] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const sigs = data?.result || [];
    if (!sigs.length) { markApi('Helius', { ok: false, meta: { endpoint: 'walletAge' }, error: 'no signatures' }); return null; }

    // Newest signature = most recent activity
    const newest    = sigs[0];
    const lastActivityBlockTime = newest?.blockTime || null;
    const minutesSinceLastTx = lastActivityBlockTime
      ? Math.floor((Date.now() / 1000 - lastActivityBlockTime) / 60) : null;

    // Oldest in batch = approximate wallet birth (may be partial for high-activity wallets)
    const oldest   = sigs[sigs.length - 1];
    const blockTime = oldest.blockTime || null;
    const partial   = sigs.length === 1000;
    let ageDays = null, ageDisplay = 'unknown';
    if (blockTime) {
      ageDays = Math.floor((Date.now() / 1000 - blockTime) / 86400);
      ageDisplay = partial ? `${ageDays}d+ (1000+ txns)` : `${ageDays} days`;
    }

    console.log(`[fetchWalletAge] txns=${sigs.length} ageDays=${ageDays} lastActivityMinsAgo=${minutesSinceLastTx}`);
    markApi('Helius', { ok: true, meta: { endpoint: 'walletAge', txCount: sigs.length, ageDays, minutesSinceLastTx } });
    return { ageDays, ageDisplay, partial, txCount: sigs.length, minutesSinceLastTx, lastActivityBlockTime };
  } catch (e) { markApi('Helius', { ok: false, meta: { endpoint: 'walletAge' }, error: e.message }); console.error('[fetchWalletAge] error:', e.message); return null; }
}

// ── Jupiter (post-migration fallback) ─────────────────────────────────────────

async function fetchJupiter(ca) {
  try {
    const res = await fetch(`${JUPITER_PRICE}${ca}`, {
      headers: { 'Accept': 'application/json' }, timeout: 5000,
    });
    if (!res.ok) { console.log(`[fetchJupiter] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const token = data?.data?.[ca];
    if (!token) { console.log('[fetchJupiter] token not found'); return null; }
    return {
      pairAddress: null, priceUsd: token.price || 0, marketCap: token.marketCap || 0,
      lp: 0, volume1h: 0, volLiq: 0, buyCount: null, sellCount: null,
      uniqueWallets: null, change1h: null, ageMinutes: null,
      name: token.mintSymbol || 'UNKNOWN', symbol: token.mintSymbol || '???',
    };
  } catch (e) { console.error('[fetchJupiter] error:', e.message); return null; }
}

// ── DeFade verification module (v8.2) ─────────────────────────────────────────
// VERIFICATION-ONLY: DeFade never generates a BUY. It only confirms risk,
// flags suspicious tokens, or hard-skips on confirmed high risk. Called
// POST-SCAN, only when Oracle's verdict is BUY — saves the 100 req/day quota
// for candidates that actually matter.
//
// Endpoint: GET {DEFADE_BASE_URL}/v1/analyze/:mint  (one call = full factors)
// Default DEFADE_BASE_URL = https://api.defade.org (NOT .io)
// Auth: x-api-key header
//
// Returns: { action, reason, score, risk, factors, verified }
//   action ∈ 'PASS' | 'FLAG' | 'HARD_SKIP' | 'UNAVAILABLE'
//   On any failure (missing key, 4xx/5xx, timeout, CF block, parse error) →
//   { action: 'UNAVAILABLE', verified: false, ... } and bot continues scan.

function deFadeModeAllows(opts = {}) {
  if (opts.skipDeFade) return false;
  if (config.DEFADE_MODE === 'off') return false;
  if (config.DEFADE_MODE === 'all') return true;
  if (config.DEFADE_MODE === 'audit_only') return !!(opts.auditMode || opts.deepMode);
  if (config.DEFADE_MODE === 'buy_only_timed') return !!opts.buyCandidate;
  return !!opts.buyCandidate;
}

function getDeFadeRuntime() {
  resetDefadeDailyIfNeeded();
  const ttlMs = Number.isFinite(config.DEFADE_CACHE_TTL_MS) ? config.DEFADE_CACHE_TTL_MS : 300000;
  const now = Date.now();
  const cooldownMs = Number.isFinite(config.DEFADE_MIN_INTERVAL_MS) ? config.DEFADE_MIN_INTERVAL_MS : 6000;
  const cooldownRemainingMs = Math.max(0, cooldownMs - (now - defadeLastCallAt));
  return {
    mode: config.DEFADE_MODE,
    cacheSize: defadeCache.size,
    cacheTtlMs: ttlMs,
    dailyCalls: defadeDailyCounter.calls,
    dailyMaxCalls: config.DEFADE_DAILY_MAX_CALLS,
    minIntervalMs: cooldownMs,
    cooldownRemainingMs,
    autoDisabled: !!defadeAutoDisabledReason,
    autoDisabledReason: defadeAutoDisabledReason,
  };
}

// ── DeFade verification module (v38.0) ────────────────────────────────────────
async function fetchDeFadeVerification(ca, oracleSignals = {}, opts = {}) {
  const unavailable = (action, reason, extra = {}) => ({
    action,
    reason,
    verified: false,
    score: null,
    risk: null,
    factors: null,
    cache: extra.cache || 'miss',
    endpoint: 'analyze',
    httpStatus: extra.httpStatus ?? null,
    rugBand: null,
  });
  if (!ca) return unavailable('UNAVAILABLE', 'Missing contract address.');
  if (!deFadeModeAllows(opts)) {
    markApi('DeFade', { skipped: true, meta: { reason: 'mode_disabled', mode: config.DEFADE_MODE, context: getFetchContext(opts) } });
    return unavailable('SKIPPED', `DeFade skipped by mode (${config.DEFADE_MODE}).`, { cache: 'miss' });
  }
  if (!process.env.DEFADE_API_KEY) {
    markApi('DeFade', { skipped: true, meta: { reason: 'missing_key' } });
    return unavailable('UNAVAILABLE', 'DEFADE_API_KEY not configured.');
  }
  if (config.DEFADE_DISABLE_ON_AUTH_FAIL && defadeAutoDisabledReason) {
    markApi('DeFade', { skipped: true, meta: { reason: 'auth_auto_disabled' } });
    return unavailable('AUTH_FAIL', `DeFade auto-disabled after auth failure: ${defadeAutoDisabledReason}`);
  }

  resetDefadeDailyIfNeeded();
  const ttlMs = Number.isFinite(config.DEFADE_CACHE_TTL_MS) ? config.DEFADE_CACHE_TTL_MS : 300000;
  const cached = defadeCache.get(ca);
  if (!opts.noCache && cached && Date.now() - cached.at < ttlMs) {
    markApi('DeFade', { skipped: true, meta: { reason: 'cache_hit', ageMs: Date.now() - cached.at } });
    return { ...cached.value, cache: 'hit' };
  }

  if (defadeDailyCounter.calls >= config.DEFADE_DAILY_MAX_CALLS) {
    markApi('DeFade', { skipped: true, meta: { reason: 'daily_budget_maxed', max: config.DEFADE_DAILY_MAX_CALLS } });
    return unavailable('SKIPPED', 'DeFade daily budget reached.', { cache: 'miss' });
  }
  const minIntervalMs = Number.isFinite(config.DEFADE_MIN_INTERVAL_MS) ? config.DEFADE_MIN_INTERVAL_MS : 6000;
  if (!opts.ignoreCooldown && defadeLastCallAt && Date.now() - defadeLastCallAt < minIntervalMs) {
    markApi('DeFade', { skipped: true, meta: { reason: 'cooldown', minIntervalMs } });
    return unavailable('SKIPPED', `DeFade cooldown active (${minIntervalMs}ms).`, { cache: 'miss' });
  }

  const base = process.env.DEFADE_BASE_URL || 'https://api.defade.org';
  const endpoint = `${base}/v1/analyze/${ca}`;
  let res;
  let data = null;
  defadeDailyCounter.calls += 1;
  defadeLastCallAt = Date.now();
  try {
    res = await fetch(endpoint, {
      headers: {
        'x-api-key': process.env.DEFADE_API_KEY,
        'Accept': 'application/json',
        'User-Agent': 'OracleBot/38.0',
      },
      timeout: 6000,
    });
    if (res.ok) data = await res.json();
  } catch (e) {
    markApi('DeFade', { ok: false, error: e.message });
    return unavailable('UNAVAILABLE', `DeFade error: ${e.message}`, { cache: 'miss' });
  }

  if (!res.ok) {
    if (res.status === 404) {
      markApi('DeFade', { ok: false, error: 'HTTP 404', meta: { status: 404 } });
      return unavailable('NOT_INDEXED', 'DeFade has not indexed this fresh CA yet', { httpStatus: 404 });
    }
    if (res.status === 401) {
      defadeAutoDisabledReason = 'HTTP 401';
      markApi('DeFade', { ok: false, error: 'HTTP 401', meta: { status: 401 } });
      return unavailable('AUTH_FAIL', 'DeFade auth failed. Check DEFADE_API_KEY and x-api-key header.', { httpStatus: 401 });
    }
    if (res.status === 403) {
      markApi('DeFade', { ok: false, error: 'HTTP 403', meta: { status: 403 } });
      return unavailable('PLAN_RESTRICTED', 'Endpoint not available on current DeFade plan.', { httpStatus: 403 });
    }
    markApi('DeFade', { ok: false, error: `HTTP ${res.status}`, meta: { status: res.status } });
    return unavailable('UNAVAILABLE', `DeFade HTTP ${res.status}`, { httpStatus: res.status });
  }

  const scoreRaw = data?.score ?? data?.rugScore ?? data?.data?.score ?? null;
  const score = scoreRaw != null && Number.isFinite(Number(scoreRaw)) ? Number(scoreRaw) : null;
  const risk = data?.risk ?? data?.riskLevel ?? data?.data?.risk ?? null;
  const factors = data?.factors ?? data?.data?.factors ?? data ?? {};
  const liquidity = Number(factors?.liquidityUsd ?? factors?.liquidity ?? NaN);

  let rugBand = null;
  if (score != null) {
    if (score <= 25) rugBand = 'SAFE';
    else if (score <= 50) rugBand = 'MODERATE';
    else if (score <= 75) rugBand = 'HIGH_RISK';
    else rugBand = 'HARD_SKIP';
  }

  let action = 'PASS';
  let reason = 'DeFade verification passed on free endpoint analyze.';
  if (score != null && score > 75) {
    action = 'HARD_SKIP';
    reason = `Rug score ${score}/100 indicates hard skip risk.`;
  } else if (score != null && score > 50) {
    action = 'FLAG';
    reason = `Elevated rug score ${score}/100 (${rugBand}).`;
  } else if (Number.isFinite(liquidity) && oracleSignals.lp > 0 && Math.abs(liquidity - oracleSignals.lp) / oracleSignals.lp > 0.5) {
    action = 'FLAG';
    reason = `Liquidity mismatch — DeFade $${liquidity.toFixed(0)} vs Oracle $${oracleSignals.lp.toFixed(0)}.`;
  }

  const payload = {
    action,
    reason,
    verified: true,
    score,
    risk,
    factors,
    endpoint: 'analyze',
    httpStatus: 200,
    cache: 'miss',
    rugBand,
  };
  defadeCache.set(ca, { at: Date.now(), value: payload });
  markApi('DeFade', { ok: true, meta: { action, score, rugBand } });
  return payload;
}

async function runDeFadeTest(ca) {
  const result = await fetchDeFadeVerification(ca, {}, {
    manualMode: true,
    buyCandidate: true,
    noCache: false,
  });
  return {
    endpoint: result.endpoint || 'analyze',
    httpStatus: result.httpStatus ?? null,
    cache: result.cache || 'miss',
    rugScore: result.score ?? null,
    action: result.action,
    reason: result.reason,
  };
}

// ── Helius holders (getTokenLargestAccounts) ──────────────────────────────────

const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000;

async function fetchHeliusHolders(ca) {
  if (!process.env.HELIUS_API_KEY) { markApi('Helius', { skipped: true, meta: { endpoint: 'holders', reason: 'missing_key' } }); return null; }
  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenLargestAccounts',
        params: [ca],
      }),
      timeout: 8000,
    });
    if (!res.ok) { markApi('Helius', { ok: false, meta: { endpoint: 'holders' }, error: `HTTP ${res.status}` }); console.log(`[fetchHeliusHolders] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const accounts = data?.result?.value || [];
    if (!accounts.length) { markApi('Helius', { ok: false, meta: { endpoint: 'holders' }, error: 'no accounts' }); return null; }
    const topWallets = accounts.map(a => ({
      address: a.address,
      owner: a.owner || null,
      uiAmount: parseFloat(a.uiAmount || 0),
      amount: a.amount || null,
      decimals: a.decimals ?? null,
    }));
    const top20Balance = accounts.slice(0, 20)
      .reduce((sum, a) => sum + parseFloat(a.uiAmount || 0), 0);

    const top10Balance = accounts.slice(0, 10)
      .reduce((sum, a) => sum + parseFloat(a.uiAmount || 0), 0);
    const top3Balance  = accounts.slice(0, 3)
      .reduce((sum, a) => sum + parseFloat(a.uiAmount || 0), 0);

    markApi('Helius', { ok: true, meta: { endpoint: 'holders', topAccountCount: accounts.length } });
    return {
      // Note: Helius returns up to 20 largest accounts, not the full holder count.
      // We surface it as a *lower bound* via the topAccountCount field; UI labels it accordingly.
      holderCount: null,
      topAccountCount: accounts.length,
      top10Pct: (top10Balance / PUMPFUN_TOTAL_SUPPLY) * 100,
      top20Pct: (top20Balance / PUMPFUN_TOTAL_SUPPLY) * 100,
      top3Pct:  (top3Balance  / PUMPFUN_TOTAL_SUPPLY) * 100,
      topWallets,
      source: 'helius',
    };
  } catch (e) { markApi('Helius', { ok: false, meta: { endpoint: 'holders' }, error: e.message }); console.error('[fetchHeliusHolders] error:', e.message); return null; }
}

// ── Codex holders ─────────────────────────────────────────────────────────────

async function fetchCodexHolders(ca) {
  if (!process.env.CODEX_API_KEY) { markApi('Codex', { skipped: true, meta: { endpoint: 'holders', reason: 'missing_key' } }); return null; }
  try {
    const tokenId = `${ca}:1399811149`;
    const query = `query { holders(input: { tokenId: "${tokenId}" }) { items { walletId balance shiftedBalance } } }`;
    const res = await fetch(CODEX_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.CODEX_API_KEY },
      body: JSON.stringify({ query }), timeout: 8000,
    });
    const data = await res.json();
    if (data.errors) { markApi('Codex', { ok: false, meta: { endpoint: 'holders' }, error: JSON.stringify(data.errors).slice(0, 120) }); console.log('[fetchCodexHolders] errors:', JSON.stringify(data.errors)); return null; }
    const items = data?.data?.holders?.items || [];
    if (!items.length) { markApi('Codex', { ok: false, meta: { endpoint: 'holders' }, error: 'no holders' }); return null; }
    const total = items.reduce((s, h) => s + (h.shiftedBalance || 0), 0);
    const top10 = items.slice(0, 10).reduce((s, h) => s + (h.shiftedBalance || 0), 0);
    const top3  = items.slice(0, 3).reduce((s, h)  => s + (h.shiftedBalance || 0), 0);
    markApi('Codex', { ok: true, meta: { endpoint: 'holders', holders: items.length } });
    return {
      holderCount: items.length,
      top10Pct: total > 0 ? (top10 / total) * 100 : null,
      top3Pct:  total > 0 ? (top3  / total) * 100 : null,
      source: 'codex',
    };
  } catch (e) { markApi('Codex', { ok: false, meta: { endpoint: 'holders' }, error: e.message }); console.error('[fetchCodexHolders] error:', e.message); return null; }
}

// ── fetchAll ──────────────────────────────────────────────────────────────────

// opts.quickFilter = true → skip Birdeye + SolanaTracker when raw vol/liq is
// already below the broadcast floor (5x). Adjusted vol/liq ≤ raw vol/liq
// always, so if raw < 5x the token will be skipped regardless — no point
// burning paid API credits on it. Used by Hunt mode; manual /scan omits opts.
async function fetchAll(ca, opts = {}) {
  console.log(`[fetchAll] starting fetch for CA: ${ca}`);
  const context = getFetchContext(opts);
  const allowBirdeye = birdeyeAllowed(opts);
  const allowCodex = !(opts.skipCodex || config.CODEX_MODE === 'off');
  if (opts.skipGMGN || config.GMGN_MODE === 'audit_only') {
    markApi('GMGN', { skipped: true, meta: { reason: opts.skipGMGN ? 'skip_flag' : 'audit_only_mode', context } });
  }
  if (opts.skipDeFade) {
    markApi('DeFade', { skipped: true, meta: { reason: 'skip_flag', context } });
  }

  // Phase 1a: cheap market data only (DexScreener + PumpPortal are free)
  const [pump, dex] = await Promise.all([
    fetchPumpPortal(ca),
    fetchDexScreener(ca),
  ]);

  console.log(`[fetchAll] PumpPortal: ${pump
    ? `OK — migrated=${pump.migrated} curve=${pump.curvePct}% holders=${pump.holderCount}`
    : 'null'}`);
  console.log(`[fetchAll] DexScreener: ${dex
    ? `OK — lp=$${dex.lp} vol1h=$${dex.volume1h} volLiq=${dex.volLiq.toFixed(2)}x`
    : 'null'}`);

  // Pre-filter: if raw vol/liq is already below broadcast floor, bail before
  // touching any paid APIs. Adjusted vol/liq can only be lower than raw.
  const QUICK_FILTER_THRESHOLD = 3; // v13.0: matches MIN_VOLLIQ_BROADCAST=3 in config
  if (opts.quickFilter) {
    const rawVolLiq = dex?.volLiq ?? 0;
    if (rawVolLiq < QUICK_FILTER_THRESHOLD) {
      console.log(`[fetchAll] quick-filter: raw volLiq ${rawVolLiq.toFixed(2)}x < ${QUICK_FILTER_THRESHOLD}x — skipping paid APIs`);
      const meta = { reason: 'quick_filter_raw_vol_liq', rawVolLiq };
      markApi('Birdeye', { skipped: true, meta });
      markApi('SolanaTracker', { skipped: true, meta });
      markApi('Helius', { skipped: true, meta });
      markApi('Codex', { skipped: true, meta });
      return null;
    }
  }

  // Phase 1b: paid enrichment — only reached when vol/liq clears the floor.
  // fetchBirdeyeOverview is always fetched here (not deferred into the holder
  // closure) so wash signals are available regardless of which holder source wins.
  const birdeyePromise = allowBirdeye
    ? fetchBirdeye(ca)
    : (markApi('Birdeye', {
        skipped: true,
        meta: {
          reason: opts.huntMode ? 'hunt_hard_block' : 'mode_disabled',
          mode: config.BIRDEYE_MODE,
          context,
        },
      }), Promise.resolve(null));
  const beOverviewPromise = allowBirdeye
    ? fetchBirdeyeOverview(ca)
    : (markApi('Birdeye', {
        skipped: true,
        meta: {
          endpoint: 'overview',
          reason: opts.huntMode ? 'hunt_hard_block' : 'mode_disabled',
          mode: config.BIRDEYE_MODE,
          context,
        },
      }), Promise.resolve(null));
  const [birdeye, stToken, beOverview] = await Promise.all([
    birdeyePromise,
    fetchSolanaTrackerToken(ca),
    beOverviewPromise,
  ]);
  const beOverviewResult = beOverview; // always available for wash computation

  // Build primary market data object
  const isMigrated = pump?.migrated === true;
  let codex = null;
  if (!isMigrated) {
    if (dex) {
      codex = dex;
      console.log('[fetchAll] path: pre-migration, DexScreener');
    } else if (pump) {
      const vSol   = (pump.vSolReserves   || 0) / 1e9;
      const vToken = (pump.vTokenReserves || 0) / 1e6;
      // Bug 5 fix: lp MUST be 0 (not vSol) for pre-migration bonding-curve tokens.
      // vSol is in SOL units (~30 SOL ≈ $4.5K); the scanner compares lp to
      // LP_MIN_USD ($10,000 USD) so 30 < 10000 falsely triggered Low Liquidity.
      // With lp=0 the scanner's MC-proxy path (liquidityProxy = mc when lp=0)
      // handles liquidity gating correctly via LP gate bypass for MC >= LP_MIN_USD.
      codex = {
        pairAddress: null, name: pump.name, symbol: pump.symbol,
        priceUsd: vToken > 0 ? vSol / vToken : 0, marketCap: pump.marketCap || 0,
        lp: 0, volume1h: 0, volLiq: 0, buyCount: null, sellCount: null,
        uniqueWallets: null, change1h: null, ageMinutes: null,
      };
      console.log('[fetchAll] path: pre-migration, PumpPortal reserves');
    }
  } else {
    if (dex) {
      codex = dex;
      console.log('[fetchAll] path: post-migration, DexScreener');
    } else {
      const jupiter = await fetchJupiter(ca);
      console.log(`[fetchAll] Jupiter: ${jupiter ? `OK` : 'null'}`);
      codex = jupiter;
    }
  }

  // Phase 2: resolve dev wallet, then run all enrichment in parallel
  // SolanaTracker is the truth source for pump.fun creator (Helius DAS returns
  // empty creators because the pump program is the on-chain creator).
  const devWallet = stToken?.creator || pump?.devWallet || await fetchTokenCreator(ca);
  const devWalletSource = stToken?.creator ? 'SolanaTracker' : pump?.devWallet ? 'PumpPortal' : 'Helius-tx';
  console.log(`[fetchAll] devWallet: ${devWallet || 'null'} (source: ${devWalletSource})`);
  const pairAddress = codex?.pairAddress || null;

  // NOTE: DeFade is no longer in this parallel block — it's called post-scan
  // as a verification step only on BUY candidates (see verifyWithDeFade).
  //
  // beOverviewResult is already assigned from Phase 1b above — always populated
  // regardless of which holder source wins (Bug 6 fix: Birdeye wash signals were
  // previously skipped whenever Codex or SolanaTracker holder data succeeded).
  const [holders, bundle, devStats, devPeak, walletAge, stDeployer] = await Promise.all([
    (async () => {
      // Holder source precedence (richest → cheapest):
      //   1. Codex               — full list, best concentration data
      //   2. SolanaTracker       — full count + top10/top3 from percentage field
      //   3. Helius              — accurate top10 concentration, only top-20 wallets
      //      → augmented with Birdeye/PumpPortal full count when possible
      //   4. Birdeye-only        — count only, no concentration
      //   5. PumpPortal-only     — count only, no concentration
      let h = null;
      if (allowCodex) {
        h = await fetchCodexHolders(ca);
      } else {
        markApi('Codex', { skipped: true, meta: { reason: 'mode_disabled', mode: config.CODEX_MODE, context } });
      }
      if (h) { console.log(`[fetchAll] holders: Codex — count=${h.holderCount} top10=${h.top10Pct?.toFixed(1)}%`); return h; }

      // SolanaTracker holders: full count + concentration in one call — use if available
      const stHolders = await fetchSolanaTrackerHolders(ca);
      if (stHolders) { console.log(`[fetchAll] holders: SolanaTracker — count=${stHolders.holderCount} top10=${stHolders.top10Pct?.toFixed(1)}%`); return stHolders; }

      // Helius (top10) — beOverview already fetched in Phase 1b (in scope via closure)
      const helius = await fetchHeliusHolders(ca);

      if (helius) {
        // Prefer Birdeye full count over PumpPortal; both override Helius's top-20 floor
        helius.holderCount = beOverview?.holderCount ?? pump?.holderCount ?? helius.holderCount;
        const src = beOverview?.holderCount ? 'Helius+Birdeye' : pump?.holderCount ? 'Helius+PumpPortal' : 'Helius (floor)';
        console.log(`[fetchAll] holders: ${src} — count=${helius.holderCount || `${helius.topAccountCount}+`} top10=${helius.top10Pct.toFixed(1)}%`);
        return helius;
      }

      if (beOverview?.holderCount) {
        console.log(`[fetchAll] holders: Birdeye count=${beOverview.holderCount} (no concentration)`);
        return { holderCount: beOverview.holderCount, top10Pct: null, top20Pct: null, top3Pct: null, topWallets: [], source: 'birdeye' };
      }
      if (pump?.holderCount) {
        console.log(`[fetchAll] holders: PumpPortal count=${pump.holderCount} (no concentration)`);
        return { holderCount: pump.holderCount, top10Pct: null, top20Pct: null, top3Pct: null, topWallets: [], source: 'pumpportal' };
      }

      console.log('[fetchAll] holders: null — UNVERIFIED');
      return null;
    })(),
    fetchBundleAndFunding(pairAddress),
    fetchDevStats(devWallet),
    fetchDevPeak(devWallet),
    fetchWalletAge(devWallet),
    fetchSolanaTrackerDeployer(devWallet),
  ]);

  // ── Wash signals ──────────────────────────────────────────────────────────
  // Primary: Birdeye multi-window (best populated window, scaled to 1h equivalent)
  // organicTrades = uniqueWallets * 3 (≈3 organic txns/wallet/hour)
  // washPct = max(0, 1 - organicTrades/totalTrades) * 100
  // Secondary fallback: SolanaTracker snipers + insiders % (already fetched)
  let washPct = null, washVolumeUsd = null, washSource = null;

  const bw = beOverviewResult;
  if (bw?.washTrade && bw?.washUnique) {
    const scale = bw.washScale ?? 1;
    const scaledTrades  = bw.washTrade  * scale;  // extrapolate to 1h
    const scaledUnique  = bw.washUnique * scale;
    const organicTrades = scaledUnique  * 3;
    washPct = Math.max(0, Math.min(95, (1 - organicTrades / scaledTrades) * 100));
    const ref = (bw.washVUsd != null ? bw.washVUsd * scale : null) ?? codex?.volume1h ?? 0;
    washVolumeUsd = ref * washPct / 100;
    washSource = `birdeye-${bw.washWindow}`;
    console.log(`[fetchAll] wash(${bw.washWindow}): trade=${bw.washTrade}(×${scale}) unique=${bw.washUnique} washPct=${washPct.toFixed(1)}% washVol=$${washVolumeUsd.toFixed(0)}`);
  } else {
    // Fallback: SolanaTracker sniper + insider % → conservative wash estimate
    const sniperPct  = stToken?.snipersPct  ?? null;
    const insiderPct = stToken?.insidersPct ?? null;
    if (sniperPct != null || insiderPct != null) {
      washPct       = Math.min(95, (sniperPct ?? 0) + (insiderPct ?? 0));
      washVolumeUsd = (codex?.volume1h ?? 0) * washPct / 100;
      washSource    = 'solanatracker-risk';
      console.log(`[fetchAll] wash(ST risk): sniper=${sniperPct}% insider=${insiderPct}% washPct=${washPct.toFixed(1)}%`);
    } else {
      console.log('[fetchAll] wash: no signal available');
    }
  }

  // Surface sniper/insider signals for display even when we have Birdeye wash
  const snipersPct  = stToken?.snipersPct  ?? null;
  const insidersPct = stToken?.insidersPct ?? null;
  const stRiskScore = stToken?.riskScore   ?? null;

  // deFadeScore stays null pre-scan; verifyWithDeFade is called post-scan
  // only on BUY candidates (respects 100 req/day free-plan quota).
  return { codex, pump, holders, bundle, devStats, devPeak, walletAge, devWallet, birdeye, deFadeScore: null, stToken, stDeployer, washPct, washVolumeUsd, washSource, snipersPct, insidersPct, stRiskScore };
}

// ── SocialData — X/Twitter CA mention velocity (15m window) ──────────────────
// Searches for the contract address as a literal string on X.
// Returns: { mentions15m, uniqueAccounts, isTrending, ctoSignal, available }
// ctoSignal = true if 3+ unique accounts used "CTO" or "takeover" keywords.
// isTrending = true if mentions >= 30 in 15m.
// Falls back gracefully when key is absent or API is down.

async function fetchSocialData(ca) {
  const key = process.env.SOCIALDATA_API_KEY;
  if (!key) { markApi('SocialData', { skipped: true, meta: { reason: 'missing_key' } }); return { available: false }; }
  try {
    // Search recent tweets containing the CA — returns up to 100 results per page
    const query    = encodeURIComponent(`"${ca}" -is:retweet`);
    const sinceMs  = Date.now() - 15 * 60 * 1000;
    const sinceISO = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const url      = `${SOCIALDATA_BASE}/twitter/search?query=${query}&type=Latest&since=${sinceISO}`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
      timeout: 8000,
    });
    if (!res.ok) {
      markApi('SocialData', { ok: false, error: `HTTP ${res.status}` });
      console.log(`[fetchSocialData] HTTP ${res.status}`);
      return { available: false };
    }
    const data = await res.json();
    const tweets = Array.isArray(data?.tweets) ? data.tweets : [];

    const uniqueAccounts = new Set(tweets.map(t => t.user?.id_str || t.user?.screen_name)).size;
    const mentions15m    = tweets.length;

    // CTO signal: 3+ unique accounts using CTO / takeover keywords
    const ctoKeywords = ['cto', 'takeover', 'take over', 'community takeover', 'no dev'];
    const ctoAccounts = new Set(
      tweets
        .filter(t => {
          const text = (t.full_text || t.text || '').toLowerCase();
          return ctoKeywords.some(kw => text.includes(kw));
        })
        .map(t => t.user?.id_str || t.user?.screen_name)
    );
    const ctoSignal = ctoAccounts.size >= 3;

    const allText = tweets
      .map(t => (t.full_text || t.text || '').toLowerCase())
      .join(' ');
    const narrativeBuckets = [
      { type: 'CELEBRITY', keywords: ['celebrity', 'kanye', 'drake', 'taylor', 'mrbeast'] },
      { type: 'ELON', keywords: ['elon', 'x ai', 'xai', 'tesla', 'spacex'] },
      { type: 'POLITICAL', keywords: ['trump', 'maga', 'biden', 'election', 'president', 'hillary'] },
      { type: 'NEWS', keywords: ['breaking', 'headline', 'war', 'fed', 'cpi', 'rate cut'] },
      { type: 'AI', keywords: ['ai', 'agent', 'gpt', 'llm', 'neural'] },
      { type: 'CRYPTO_META', keywords: ['solana', 'dex', 'pump', 'airdrop', 'cto'] },
      { type: 'VIRAL_X', keywords: ['viral', 'x trend', 'trending', 'tweet'] },
      { type: 'MEME', keywords: ['meme', 'pepe', 'cat', 'dog', 'frog'] },
    ];
    let narrativeType = 'NONE';
    let narrativeHits = 0;
    for (const bucket of narrativeBuckets) {
      const hits = bucket.keywords.filter(k => allText.includes(k)).length;
      if (hits > narrativeHits) {
        narrativeHits = hits;
        narrativeType = bucket.type;
      }
    }
    const isTrending = mentions15m >= 30;
    let narrativeStrength = narrativeType === 'NONE' ? 0 : Math.min(5, narrativeHits + (isTrending ? 2 : 1));
    if (mentions15m >= 40) narrativeStrength = Math.min(5, narrativeStrength + 1);
    const narrativeReason = narrativeType === 'NONE'
      ? 'No social narrative catalyst found.'
      : `${narrativeType} keyword signals in 15m mentions`;
    console.log(`[fetchSocialData] mentions15m=${mentions15m} unique=${uniqueAccounts} trending=${isTrending} cto=${ctoSignal} narrative=${narrativeType}:${narrativeStrength}`);
    markApi('SocialData', { ok: true, meta: { mentions15m, uniqueAccounts, ctoSignal, isTrending, narrativeType, narrativeStrength } });
    return { available: true, mentions15m, uniqueAccounts, isTrending, ctoSignal, narrativeType, narrativeStrength, narrativeReason };
  } catch (e) {
    console.error('[fetchSocialData] error:', e.message);
    markApi('SocialData', { ok: false, error: e.message });
    return { available: false };
  }
}

// ── Lightweight Forensic Fetch (Guardian tracking loop only) ────────────────
// Skips Codex, Helius, dev stats, bundle detection, DeFade, wash heuristics —
// pulls only the fields the Guardian's checkPosition / sendHeartbeat need.
// Cuts per-poll API load by ~70% vs fetchAll. Vol/Liq uses raw (uncorrected
// for wash) — acceptable trade-off since the decay threshold is 2x and raw
// > adjusted always, so alerts fire conservatively (slightly later, never
// earlier).
async function fetchForensic(ca) {
  const [dex, holders, birdeye] = await Promise.all([
    fetchDexScreener(ca),
    fetchSolanaTrackerHolders(ca),
    fetchBirdeye(ca).catch(() => null),
  ]);

  if (!dex) return null;

  const lp             = dex.lp || 0;
  const vol1h          = dex.volume1h || 0;
  // Bug 10 fix: use MC as proxy when LP=0 (bonding-curve tokens), consistent with
  // scanner.js. The old code returned 0 for LP=0 tokens, making Guardian unable to
  // monitor any pre-graduation token that was originally scanned as a Hunt candidate.
  const mcProxy        = lp > 0 ? lp : (dex.marketCap || 0);
  const adjustedVolLiq = mcProxy > 0 ? vol1h / mcProxy : 0;

  return {
    marketCap:      dex.marketCap || 0,
    lp,
    priceUsd:       dex.priceUsd || 0,
    change1h:       dex.change1h ?? null,
    adjustedVolLiq,
    holderCount:    holders?.holderCount ?? null,
    top10Pct:       holders?.top10Pct    ?? null,
    top20Pct:       holders?.top20Pct    ?? null,
    top50Pct:       holders?.top50Pct    ?? null,
    topWallets:     holders?.topWallets  ?? [],
    holderSource:   holders?.source      ?? null,
    ageMinutes:     dex.ageMinutes       ?? null,
    priceChange5m:  birdeye?.priceChange5m ?? null,
  };
}

// Lightweight MC-only fetch used by audit loops and audit commands.
// Priority: DexScreener -> Jupiter -> Birdeye (only when explicitly allowed).
async function fetchMcOnly(ca, opts = {}) {
  const dex = await fetchDexScreener(ca).catch(() => null);
  const dexMc = dex?.marketCap ?? null;
  if (dexMc != null && Number.isFinite(Number(dexMc)) && Number(dexMc) > 0) {
    return { mc: Number(dexMc), source: 'dexscreener' };
  }
  const jup = await fetchJupiter(ca).catch(() => null);
  const jupMc = jup?.marketCap ?? null;
  if (jupMc != null && Number.isFinite(Number(jupMc)) && Number(jupMc) > 0) {
    return { mc: Number(jupMc), source: 'jupiter' };
  }

  const allowBirdeyeFallback = !!opts.allowBirdeye && birdeyeAllowed({ auditMode: true, deepMode: !!opts.deepMode });
  if (!allowBirdeyeFallback) {
    markApi('Birdeye', { skipped: true, meta: { reason: 'audit_fallback_disabled', context: opts.deepMode ? 'auditdeep' : 'audit' } });
    return null;
  }
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return null;
  try {
    const headers = { 'X-API-KEY': key, 'x-chain': 'solana' };
    const res = await fetch(
      `${BIRDEYE_BASE}/defi/token_overview?address=${ca}`,
      { headers, timeout: 8000 },
    );
    if (!res.ok) return null;
    const j = await res.json();
    const mc = j?.data?.mc ?? j?.data?.marketCap ?? null;
    return mc != null ? { mc: Number(mc), source: 'birdeye' } : null;
  } catch {
    return null;
  }
}

module.exports = {
  birdeyeAllowed,
  fetchAll,
  fetchForensic,
  fetchDeFadeVerification,
  fetchSocialData,
  fetchMcOnly,
  getDeFadeRuntime,
  runDeFadeTest,
};
