require('dotenv').config();
const fetch = require('node-fetch');

const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/tokens/';
const CODEX_GQL       = 'https://graph.codex.io/graphql';
const PUMPFUN_URL     = 'https://frontend-api.pump.fun/coins/';
const PUMPFUN_USER    = 'https://frontend-api.pump.fun/coins/user-created-coins/';
const JUPITER_PRICE   = 'https://price.jup.ag/v4/price?ids=';
const SOLANA_RPC      = 'https://api.mainnet-beta.solana.com';
const BIRDEYE_BASE    = 'https://public-api.birdeye.so';
const SOCIALDATA_BASE = 'https://api.socialdata.tools';

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
    if (!res.ok) { console.log(`[fetchDexScreener] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const sol = (data.pairs || []).filter(p => p.chainId === 'solana');
    if (!sol.length) { console.log('[fetchDexScreener] no Solana pairs'); return null; }
    sol.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    // Prefer the highest-liquidity pair that actually has LP > 0 (avoids Phantom LP / stale pairs)
    const top = sol.find(p => (p.liquidity?.usd || 0) > 0) || sol[0];
    const lp    = top.liquidity?.usd || 0;
    const vol1h = top.volume?.h1     || 0;
    const mc    = top.marketCap || 0;
    const dexId = top.dexId || null;
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
  } catch (e) { console.error('[fetchDexScreener] error:', e.message); return null; }
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
  if (!key) return null;
  try {
    const res = await fetch(`${ST_BASE}/tokens/${ca}`, {
      headers: { 'x-api-key': key, 'Accept': 'application/json' },
      timeout: 8000,
    });
    if (!res.ok) { console.log(`[fetchSolanaTrackerToken] HTTP ${res.status}`); return null; }
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
    return { creator, createdTx, createdAt, holderCount, snipersPct, insidersPct, riskScore };
  } catch (e) { console.error('[fetchSolanaTrackerToken] error:', e.message); return null; }
}

// ── SolanaTracker holders (full count + concentration) ──────────────────────
// /tokens/{ca}/holders returns { total, accounts: [{ percentage }] }
// Gives both full holder count AND top10/top3 concentration — better than Helius alone.

async function fetchSolanaTrackerHolders(ca) {
  const key = process.env.SOLANATRACKER_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${ST_BASE}/tokens/${ca}/holders`, {
      headers: { 'x-api-key': key, 'Accept': 'application/json' },
      timeout: 8000,
    });
    if (!res.ok) { console.log(`[fetchSolanaTrackerHolders] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const total = typeof data?.total === 'number' ? data.total : null;
    if (!total) return null;
    const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    const top3Pct  = accounts.slice(0, 3).reduce((s, a)  => s + (a.percentage || 0), 0) || null;
    const top10Pct = accounts.slice(0, 10).reduce((s, a) => s + (a.percentage || 0), 0) || null;
    const top50Pct = accounts.slice(0, 50).reduce((s, a) => s + (a.percentage || 0), 0) || null;
    console.log(`[fetchSolanaTrackerHolders] total=${total} top10=${top10Pct?.toFixed(1)}% top50=${top50Pct?.toFixed(1)}%`);
    return { holderCount: total, top3Pct, top10Pct, top50Pct, source: 'solanatracker-holders' };
  } catch (e) { console.error('[fetchSolanaTrackerHolders] error:', e.message); return null; }
}

async function fetchSolanaTrackerDeployer(wallet) {
  if (!wallet) return null;
  const key = process.env.SOLANATRACKER_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${ST_BASE}/deployer/${wallet}`, {
      headers: { 'x-api-key': key, 'Accept': 'application/json' },
      timeout: 10000,
    });
    if (!res.ok) { console.log(`[fetchSolanaTrackerDeployer] HTTP ${res.status}`); return null; }
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
    return {
      totalLaunches, migratedCount, winRate,
      peakMc, topPerformerMultiplier,
      assetCount: all.length,
    };
  } catch (e) { console.error('[fetchSolanaTrackerDeployer] error:', e.message); return null; }
}

// ── Birdeye (Alpha Tier) ──────────────────────────────────────────────────────
// Fetches 5m OHLCV candles to derive: 5m price change, 1H high/low, range position.

// Birdeye Token Overview — used solely to fetch the *total* holder count
// (avoids the Helius top-20 floor problem). Returns { holderCount } or null.

async function fetchBirdeyeOverview(ca) {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return null;
  const headers = { 'X-API-KEY': key, 'Accept': 'application/json', 'x-chain': 'solana' };
  try {
    const res = await fetch(`${BIRDEYE_BASE}/defi/token_overview?address=${ca}`, { headers, timeout: 8000 });
    if (!res.ok) { console.log(`[fetchBirdeyeOverview] HTTP ${res.status}`); return null; }
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
    if (holderCount == null && !bw) return null;
    return {
      holderCount: holderCount != null ? Number(holderCount) : null,
      washWindow:  bwLabel,
      washTrade:   bw?.trade  ?? null,
      washUnique:  bw?.unique ?? null,
      washVUsd:    bw?.vUsd   ?? null,
      washScale:   bw?.scale  ?? null,
    };
  } catch (e) { console.error('[fetchBirdeyeOverview] error:', e.message); return null; }
}

async function fetchBirdeye(ca) {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) { console.log('[fetchBirdeye] BIRDEYE_API_KEY not set'); return null; }
  const headers = { 'X-API-KEY': key, 'Accept': 'application/json', 'x-chain': 'solana' };
  const nowTs       = Math.floor(Date.now() / 1000);
  const twoHoursAgo = nowTs - 7200;
  try {
    const res = await fetch(
      `${BIRDEYE_BASE}/defi/ohlcv?address=${ca}&type=5m&time_from=${twoHoursAgo}&time_to=${nowTs}`,
      { headers, timeout: 8000 }
    );
    if (!res.ok) { console.log(`[fetchBirdeye] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const candles = data?.data?.items || [];
    if (!candles.length) { console.log('[fetchBirdeye] no candles'); return null; }

    const last   = candles[candles.length - 1];
    const prev   = candles[candles.length - 2] || null;

    const priceChange5m = (prev && prev.c > 0) ? ((last.c - prev.c) / prev.c) * 100 : null;
    const high1h  = Math.max(...candles.map(c => c.h));
    const low1h   = Math.min(...candles.map(c => c.l));
    const rangePct = (high1h > low1h) ? (last.c - low1h) / (high1h - low1h) : null;

    console.log(`[fetchBirdeye] candles=${candles.length} 5mChange=${priceChange5m?.toFixed(2)}% range=${(rangePct != null ? (rangePct*100).toFixed(0) : 'N/A')}%`);
    return { priceChange5m, high1h, low1h, rangePct, currentClose: last.c };
  } catch (e) { console.error('[fetchBirdeye] error:', e.message); return null; }
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
    if (!res.ok) { console.log(`[fetchPumpPortal] HTTP ${res.status}`); return null; }
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
  } catch (e) { console.error('[fetchPumpPortal] error:', e.message); return null; }
}

// ── pump.fun dev stats (replaces dead PumpPortal user-stats endpoint) ─────────
// GET https://frontend-api.pump.fun/coins/user-created-coins/{wallet}?offset=0&limit=200
// Returns array of coin objects; complete=true / raydium_pool!=null = graduated.

async function fetchDevStats(devWallet) {
  if (!devWallet) return null;
  try {
    const res = await fetch(
      `${PUMPFUN_USER}${devWallet}?offset=0&limit=200`,
      { headers: PUMPFUN_HEADERS, timeout: 8000 }
    );
    if (!res.ok) { console.log(`[fetchDevStats] HTTP ${res.status}`); return null; }
    const data = await res.json();
    if (!Array.isArray(data)) { console.log('[fetchDevStats] unexpected shape'); return null; }
    const totalLaunches = data.length;
    const migratedCount = data.filter(c => c.complete === true || !!c.raydium_pool).length;
    const winRate       = totalLaunches > 0 ? +(migratedCount / totalLaunches * 100).toFixed(2) : null;
    console.log(`[fetchDevStats] launches=${totalLaunches} migrated=${migratedCount} winRate=${winRate}%`);
    return { totalLaunches, migratedCount, winRate };
  } catch (e) { console.error('[fetchDevStats] error:', e.message); return null; }
}

// ── Helius — Token Creator fallback ──────────────────────────────────────────

async function fetchTokenCreator(ca) {
  const endpoint = heliusRpc();
  if (!endpoint) return null;
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
    if (!sigs.length) return null;
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
    if (!txRes.ok) { console.log(`[fetchTokenCreator] tx HTTP ${txRes.status}`); return null; }
    const txData = await txRes.json();
    const creator = txData?.result?.transaction?.message?.accountKeys?.[0] ?? null;
    console.log(`[fetchTokenCreator] from oldest tx: ${creator}`);
    return creator;
  } catch (e) { console.error('[fetchTokenCreator] error:', e.message); return null; }
}

// ── Helius — Dev Top Performer (v6.0) ────────────────────────────────────────
// Queries BOTH getAssetsByCreator and getAssetsByOwner in parallel, dedupes, and
// computes the dev's historical peak MC. Multiplier = peak / $5K (pump.fun start).

async function fetchDevPeak(devWallet) {
  if (!devWallet) return null;
  const endpoint = heliusRpc();
  if (!endpoint) { console.log('[fetchDevPeak] HELIUS_API_KEY not set'); return null; }
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
    return { assetCount: all.size, highestMc, topPerformerMultiplier };
  } catch (e) { console.error('[fetchDevPeak] error:', e.message); return null; }
}

// ── Wallet Age + Last Activity ────────────────────────────────────────────────

async function fetchWalletAge(devWallet) {
  if (!devWallet) return null;
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
    if (!res.ok) { console.log(`[fetchWalletAge] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const sigs = data?.result || [];
    if (!sigs.length) return null;

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
    return { ageDays, ageDisplay, partial, txCount: sigs.length, minutesSinceLastTx, lastActivityBlockTime };
  } catch (e) { console.error('[fetchWalletAge] error:', e.message); return null; }
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

async function fetchDeFadeVerification(ca, oracleSignals = {}) {
  const unavailable = (reason) => ({
    action: 'UNAVAILABLE', reason, verified: false,
    score: null, risk: null, factors: null,
  });
  if (!process.env.DEFADE_API_KEY) return unavailable('DEFADE_API_KEY not configured');

  const base = process.env.DEFADE_BASE_URL || 'https://api.defade.org';
  let data;
  try {
    const res = await fetch(`${base}/v1/analyze/${ca}`, {
      headers: {
        'x-api-key': process.env.DEFADE_API_KEY,
        'Accept': 'application/json',
        'User-Agent': 'OracleBot/8.2',
      },
      timeout: 6000,
    });
    if (!res.ok) {
      console.log(`[DeFade] HTTP ${res.status} — verification UNAVAILABLE`);
      return unavailable(`DeFade HTTP ${res.status}`);
    }
    data = await res.json();
  } catch (e) {
    console.error('[DeFade] error:', e.message);
    return unavailable(`DeFade error: ${e.message}`);
  }

  // Defensive parsing — DeFade shape may vary across endpoints
  const score = data?.score ?? data?.rugScore ?? data?.data?.score ?? null;
  const risk  = data?.risk  ?? data?.riskLevel ?? data?.data?.risk ?? null;
  const factors = data?.factors ?? data?.data?.factors ?? data ?? {};

  const top10Pct       = Number(factors?.top10HolderPct ?? factors?.top10 ?? NaN);
  const bundlesCount   = Number(factors?.bundlesDetected ?? factors?.bundles ?? NaN);
  const dfLiquidityUsd = Number(factors?.liquidityUsd ?? factors?.liquidity ?? NaN);

  // Apply verification rules — HARD_SKIP overrides all others.
  let action = 'PASS', reason = 'All checks within tolerance';

  if (score != null && Number(score) >= 80) {
    action = 'HARD_SKIP'; reason = `Rug score ${score}/100 ≥ 80`;
  } else if (isFinite(bundlesCount) && bundlesCount >= 3) {
    action = 'HARD_SKIP'; reason = `Bundle manipulation confirmed (${bundlesCount} bundles)`;
  } else if (isFinite(top10Pct) && top10Pct >= 35) {
    // Threshold aligned with scanner's minimum cap (35% for sub-$100K, 25% for $100K+).
    // The old 15% threshold hard-killed every early-stage token the scanner had already
    // approved — early launches routinely show 20-30% top10 concentration.
    action = 'HARD_SKIP'; reason = `Holder concentration top10 ${top10Pct}% ≥ 35%`;
  } else if (
    isFinite(dfLiquidityUsd) && oracleSignals.lp > 0 &&
    Math.abs(dfLiquidityUsd - oracleSignals.lp) / oracleSignals.lp > 0.5
  ) {
    // DeFade liquidity disagrees with DexScreener/Birdeye by >50% → suspicious
    action = 'FLAG';
    reason = `Liquidity mismatch — DeFade $${dfLiquidityUsd.toFixed(0)} vs Oracle $${oracleSignals.lp.toFixed(0)}`;
  } else if (score != null && Number(score) >= 50) {
    action = 'FLAG'; reason = `Elevated rug score ${score}/100`;
  }

  console.log(`[DeFade] action=${action} score=${score} risk=${risk} reason="${reason}"`);
  return {
    action, reason, verified: true,
    score: score != null ? Number(score) : null,
    risk: risk ?? null,
    factors,
  };
}

// ── Helius holders (getTokenLargestAccounts) ──────────────────────────────────

const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000;

async function fetchHeliusHolders(ca) {
  if (!process.env.HELIUS_API_KEY) return null;
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
    if (!res.ok) { console.log(`[fetchHeliusHolders] HTTP ${res.status}`); return null; }
    const data = await res.json();
    const accounts = data?.result?.value || [];
    if (!accounts.length) return null;

    const top10Balance = accounts.slice(0, 10)
      .reduce((sum, a) => sum + parseFloat(a.uiAmount || 0), 0);
    const top3Balance  = accounts.slice(0, 3)
      .reduce((sum, a) => sum + parseFloat(a.uiAmount || 0), 0);

    return {
      // Note: Helius returns up to 20 largest accounts, not the full holder count.
      // We surface it as a *lower bound* via the topAccountCount field; UI labels it accordingly.
      holderCount: null,
      topAccountCount: accounts.length,
      top10Pct: (top10Balance / PUMPFUN_TOTAL_SUPPLY) * 100,
      top3Pct:  (top3Balance  / PUMPFUN_TOTAL_SUPPLY) * 100,
      source: 'helius',
    };
  } catch (e) { console.error('[fetchHeliusHolders] error:', e.message); return null; }
}

// ── Codex holders ─────────────────────────────────────────────────────────────

async function fetchCodexHolders(ca) {
  if (!process.env.CODEX_API_KEY) return null;
  try {
    const tokenId = `${ca}:1399811149`;
    const query = `query { holders(input: { tokenId: "${tokenId}" }) { items { walletId balance shiftedBalance } } }`;
    const res = await fetch(CODEX_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.CODEX_API_KEY },
      body: JSON.stringify({ query }), timeout: 8000,
    });
    const data = await res.json();
    if (data.errors) { console.log('[fetchCodexHolders] errors:', JSON.stringify(data.errors)); return null; }
    const items = data?.data?.holders?.items || [];
    if (!items.length) return null;
    const total = items.reduce((s, h) => s + (h.shiftedBalance || 0), 0);
    const top10 = items.slice(0, 10).reduce((s, h) => s + (h.shiftedBalance || 0), 0);
    const top3  = items.slice(0, 3).reduce((s, h)  => s + (h.shiftedBalance || 0), 0);
    return {
      holderCount: items.length,
      top10Pct: total > 0 ? (top10 / total) * 100 : null,
      top3Pct:  total > 0 ? (top3  / total) * 100 : null,
    };
  } catch (e) { console.error('[fetchCodexHolders] error:', e.message); return null; }
}

// ── fetchAll ──────────────────────────────────────────────────────────────────

// opts.quickFilter = true → skip Birdeye + SolanaTracker when raw vol/liq is
// already below the broadcast floor (5x). Adjusted vol/liq ≤ raw vol/liq
// always, so if raw < 5x the token will be skipped regardless — no point
// burning paid API credits on it. Used by Hunt mode; manual /scan omits opts.
async function fetchAll(ca, opts = {}) {
  console.log(`[fetchAll] starting fetch for CA: ${ca}`);

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
      return null;
    }
  }

  // Phase 1b: paid enrichment — only reached when vol/liq clears the floor.
  // fetchBirdeyeOverview is always fetched here (not deferred into the holder
  // closure) so wash signals are available regardless of which holder source wins.
  const [birdeye, stToken, beOverview] = await Promise.all([
    fetchBirdeye(ca),
    fetchSolanaTrackerToken(ca),
    fetchBirdeyeOverview(ca),
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
      let h = await fetchCodexHolders(ca);
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
        return { holderCount: beOverview.holderCount, top10Pct: null, top3Pct: null, source: 'birdeye' };
      }
      if (pump?.holderCount) {
        console.log(`[fetchAll] holders: PumpPortal count=${pump.holderCount} (no concentration)`);
        return { holderCount: pump.holderCount, top10Pct: null, top3Pct: null, source: 'pumpportal' };
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
  if (!key) return { available: false };
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

    const isTrending = mentions15m >= 30;
    console.log(`[fetchSocialData] mentions15m=${mentions15m} unique=${uniqueAccounts} trending=${isTrending} cto=${ctoSignal}`);
    return { available: true, mentions15m, uniqueAccounts, isTrending, ctoSignal };
  } catch (e) {
    console.error('[fetchSocialData] error:', e.message);
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
    top50Pct:       holders?.top50Pct    ?? null,
    priceChange5m:  birdeye?.priceChange5m ?? null,
  };
}

// Lightweight MC-only fetch used by the audit background loop.
// Uses Birdeye token_overview (already called in fetchBirdeye) — single request,
// no heavy multi-API fetchAll. Returns { mc } or null on error/missing key.
async function fetchMcOnly(ca) {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return null;
  try {
    const headers = { 'X-API-KEY': key, 'x-chain': 'solana' };
    const res = await fetch(
      `${BIRDEYE_BASE}/defi/token_overview?address=${ca}`,
      { headers, timeout: 8000 },
    );
    if (!res.ok) return null;
    const j  = await res.json();
    const mc = j?.data?.mc ?? j?.data?.marketCap ?? null;
    return mc != null ? { mc: Number(mc) } : null;
  } catch { return null; }
}

module.exports = { fetchAll, fetchForensic, fetchDeFadeVerification, fetchSocialData, fetchMcOnly };
