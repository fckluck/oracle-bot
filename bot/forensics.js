'use strict';

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const DATA_DIR = process.env.DATA_DIR || '/data';
const WALLET_MEMORY_FILE = path.join(DATA_DIR, 'wallet-memory.json');
const SOLANA_RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function shortCa(ca = '') {
  return ca ? `${String(ca).slice(0, 6)}...${String(ca).slice(-4)}` : 'unknown';
}

function pctSpread(values = []) {
  const nums = values.map(v => num(v, null)).filter(v => v != null && v > 0);
  if (nums.length < 3) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (avg <= 0) return null;
  return (max - min) / avg;
}

function bucketSimilarity(values = [], tolerancePct = 0.08) {
  const nums = values.map(v => num(v, null)).filter(v => v != null && v > 0);
  if (nums.length < 5) return 0;

  let maxBucket = 0;
  for (const base of nums) {
    const count = nums.filter(v => Math.abs(v - base) / Math.max(base, 1) <= tolerancePct).length;
    if (count > maxBucket) maxBucket = count;
  }
  return maxBucket / nums.length;
}

function mostCommonRatio(values = []) {
  const clean = values.filter(Boolean);
  if (!clean.length) return { value: null, count: 0, ratio: 0 };
  const counts = new Map();
  for (const v of clean) counts.set(v, (counts.get(v) || 0) + 1);
  let best = { value: null, count: 0, ratio: 0 };
  for (const [value, count] of counts.entries()) {
    if (count > best.count) best = { value, count, ratio: count / clean.length };
  }
  return best;
}

async function rpc(method, params = []) {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    timeout: 10000,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

async function rpcBatch(calls = []) {
  if (!calls.length) return [];
  const payload = calls.map((c, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: c.method,
    params: c.params || [],
  }));
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    timeout: 15000,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`RPC batch HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json)) return [];
  return json.sort((a, b) => a.id - b.id).map(r => r.error ? null : r.result);
}

function loadWalletMemory() {
  try {
    if (!fs.existsSync(WALLET_MEMORY_FILE)) {
      return { winners: {}, rugs: {}, funders: {}, updatedAt: null };
    }
    const raw = JSON.parse(fs.readFileSync(WALLET_MEMORY_FILE, 'utf8'));
    return {
      winners: raw.winners || {},
      rugs: raw.rugs || {},
      funders: raw.funders || {},
      updatedAt: raw.updatedAt || null,
    };
  } catch (_) {
    return { winners: {}, rugs: {}, funders: {}, updatedAt: null };
  }
}

function saveWalletMemory(memory) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WALLET_MEMORY_FILE, JSON.stringify({
      ...memory,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (_) {}
}

function classifyWalletMemory(topWallets = [], memory = loadWalletMemory()) {
  const owners = topWallets.map(w => w.owner || w.address || w.wallet).filter(Boolean);
  let winnerHits = 0;
  let rugHits = 0;

  for (const w of owners) {
    if (memory.winners?.[w]) winnerHits += Number(memory.winners[w].count || 1);
    if (memory.rugs?.[w]) rugHits += Number(memory.rugs[w].count || 1);
  }

  return { winnerHits, rugHits };
}

async function resolveTopTokenAccounts(ca, limit = 20) {
  const largest = await rpc('getTokenLargestAccounts', [ca]);
  const accounts = (largest?.value || []).slice(0, limit).map(a => ({
    tokenAccount: a.address,
    address: a.address,
    uiAmount: num(a.uiAmount, 0),
    amount: a.amount || null,
    decimals: a.decimals ?? null,
  }));

  if (!accounts.length) return [];

  const parsed = await rpcBatch(accounts.map(a => ({
    method: 'getParsedAccountInfo',
    params: [a.tokenAccount, { commitment: 'confirmed' }],
  })));

  for (let i = 0; i < accounts.length; i++) {
    const info = parsed[i]?.value?.data?.parsed?.info;
    if (info?.owner) accounts[i].owner = info.owner;
    if (info?.tokenAmount?.uiAmount != null) accounts[i].uiAmount = num(info.tokenAmount.uiAmount, accounts[i].uiAmount);
  }

  return accounts;
}

async function attachSolBalances(wallets = []) {
  const owners = wallets.map(w => w.owner).filter(Boolean);
  if (!owners.length) return wallets;

  const balances = await rpcBatch(owners.map(owner => ({
    method: 'getBalance',
    params: [owner, { commitment: 'confirmed' }],
  }))).catch(() => []);

  let idx = 0;
  for (const w of wallets) {
    if (!w.owner) continue;
    const lamports = balances[idx]?.value;
    idx++;
    if (lamports != null) w.solBalance = Number(lamports) / 1e9;
  }
  return wallets;
}

async function traceRecentFunder(owner) {
  if (!owner) return null;

  const sigs = await rpc('getSignaturesForAddress', [owner, { limit: 12 }]).catch(() => null);
  if (!Array.isArray(sigs) || !sigs.length) return { owner, txCountSample: 0, freshSample: true, funder: null };

  const txCountSample = sigs.length;
  const oldest = sigs[sigs.length - 1];
  const oldestAgeMs = oldest?.blockTime ? Date.now() - oldest.blockTime * 1000 : null;
  const freshSample = txCountSample < 12 && oldestAgeMs != null && oldestAgeMs < 24 * 60 * 60 * 1000;

  const txFetch = sigs.slice(-8).map(s => ({
    method: 'getTransaction',
    params: [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
  }));
  const txs = await rpcBatch(txFetch).catch(() => []);

  let funder = null;
  for (const tx of txs) {
    const instructions = tx?.transaction?.message?.instructions || [];
    for (const ix of instructions) {
      const parsed = ix?.parsed;
      if (!parsed || parsed.type !== 'transfer') continue;
      const info = parsed.info || {};
      if (info.destination === owner && info.source && info.source !== owner && Number(info.lamports || 0) > 0) {
        funder = info.source;
        break;
      }
    }
    if (funder) break;
  }

  return { owner, txCountSample, freshSample, funder };
}

async function enrichWalletsDeep(topWallets = [], opts = {}) {
  const wallets = topWallets.slice(0, opts.limit || 20);
  await attachSolBalances(wallets);

  const traceLimit = opts.traceLimit || 10;
  const traces = await Promise.all(
    wallets.slice(0, traceLimit).map(w => traceRecentFunder(w.owner).catch(() => null))
  );

  const traceByOwner = new Map();
  for (const t of traces) {
    if (t?.owner) traceByOwner.set(t.owner, t);
  }

  for (const w of wallets) {
    const t = traceByOwner.get(w.owner);
    if (!t) continue;
    w.recentFunder = t.funder || null;
    w.txCountSample = t.txCountSample;
    w.freshSample = !!t.freshSample;
  }

  return wallets;
}

function evaluateHolderCohort({
  ca,
  marketCap,
  ageMinutes,
  holders,
  topWallets = [],
  bundle = null,
  deep = false,
} = {}) {
  const wallets = Array.isArray(topWallets) ? topWallets.slice(0, 20) : [];
  const memory = loadWalletMemory();

  if (!wallets.length) {
    return {
      status: 'UNKNOWN',
      icon: '🟡',
      oneLine: '🔎 Forensics: 🟡 Unknown — no top-holder data returned; no confirmed farm.',
      blockPromotion: false,
      suppressPromotion: false,
      reason: 'no top-holder data returned',
      features: {},
    };
  }

  const tokenAmounts = wallets.map(w => num(w.uiAmount ?? w.amount ?? w.tokenAmount, 0)).filter(v => v > 0);
  const solBalances = wallets.map(w => num(w.solBalance, 0)).filter(v => v > 0);
  const holderCount = holders?.holderCount ?? null;
  const top10Pct = holders?.top10Pct ?? null;
  const top20Pct = holders?.top20Pct ?? null;

  const tokenSimilarity = bucketSimilarity(tokenAmounts, 0.08);
  const solSimilarity = solBalances.length >= 5 ? bucketSimilarity(solBalances, 0.10) : 0;
  const tokenSpread = pctSpread(tokenAmounts);
  const solSpread = solBalances.length >= 5 ? pctSpread(solBalances) : null;
  const memoryHits = classifyWalletMemory(wallets, memory);

  const ownersResolved = wallets.filter(w => w.owner).length;
  const ownerResolvedPct = wallets.length ? ownersResolved / wallets.length : 0;
  const freshSamples = wallets.filter(w => w.freshSample === true).length;
  const tracedWallets = wallets.filter(w => w.txCountSample != null).length;
  const freshWalletPct = tracedWallets ? freshSamples / tracedWallets : 0;
  const funderCommon = mostCommonRatio(wallets.map(w => w.recentFunder).filter(Boolean));
  const sameFunderPct = funderCommon.ratio || 0;

  const veryYoung = ageMinutes != null && Number(ageMinutes) <= 45;
  const lowMc = marketCap != null && Number(marketCap) <= 50_000;
  const smallHolderBase = holderCount != null && holderCount <= 100;
  const slotCluster = bundle?.maxInSlot != null ? Number(bundle.maxInSlot) : Number(bundle?.bundleCount || 0);
  const sybil = !!bundle?.sybilDetected;

  let farmScore = 0;
  const reasons = [];

  if (sybil) {
    farmScore += 5;
    reasons.push('confirmed sybil funding');
  }

  if (memoryHits.rugHits >= 3) {
    farmScore += 5;
    reasons.push(`${memoryHits.rugHits} prior rug-wallet hits`);
  } else if (memoryHits.rugHits >= 1) {
    farmScore += 2;
    reasons.push(`${memoryHits.rugHits} prior rug-wallet hit`);
  }

  if (sameFunderPct >= 0.40 && funderCommon.count >= 3) {
    farmScore += 4;
    reasons.push(`${funderCommon.count} wallets share recent funder`);
  } else if (sameFunderPct >= 0.25 && funderCommon.count >= 2) {
    farmScore += 2;
    reasons.push(`${funderCommon.count} wallets share recent funder`);
  }

  if (tokenSimilarity >= 0.45) {
    farmScore += 3;
    reasons.push('similar token sizing cluster');
  } else if (tokenSimilarity >= 0.30) {
    farmScore += 1.5;
    reasons.push('mild similar token sizing');
  }

  if (solSimilarity >= 0.45) {
    farmScore += 3;
    reasons.push('similar SOL balance cluster');
  } else if (solSimilarity >= 0.30) {
    farmScore += 1.5;
    reasons.push('mild SOL balance similarity');
  }

  if (freshWalletPct >= 0.50 && tracedWallets >= 5) {
    farmScore += 2.5;
    reasons.push('fresh-wallet cluster');
  }

  if (slotCluster >= 8) {
    farmScore += 2;
    reasons.push(`${slotCluster}/slot cluster`);
  } else if (slotCluster >= 5) {
    farmScore += 1;
    reasons.push(`${slotCluster}/slot controlled cluster`);
  }

  if (veryYoung && lowMc && smallHolderBase && tokenSimilarity >= 0.30) {
    farmScore += 1.5;
    reasons.push('young low-MC uniform holder base');
  }

  let healthyScore = 0;
  const healthyReasons = [];

  if (memoryHits.winnerHits >= 2) {
    healthyScore += 3;
    healthyReasons.push(`${memoryHits.winnerHits} prior runner-wallet hits`);
  } else if (memoryHits.winnerHits === 1) {
    healthyScore += 1;
    healthyReasons.push('1 prior runner-wallet hit');
  }

  if (tokenSimilarity < 0.25 && tokenSpread != null && tokenSpread > 0.50) {
    healthyScore += 1.5;
    healthyReasons.push('mixed token sizing');
  }

  if (solBalances.length >= 5 && solSimilarity < 0.25) {
    healthyScore += 1;
    healthyReasons.push('mixed SOL balances');
  }

  if (sameFunderPct === 0 && tracedWallets >= 5) {
    healthyScore += 1;
    healthyReasons.push('no shared recent funder in sample');
  }

  if (top10Pct != null && top10Pct <= 45 && !sybil) {
    healthyScore += 1;
    healthyReasons.push('top10 not death-zone');
  }

  let status = 'UNKNOWN';
  let icon = '🟡';
  let labelReason = deep
    ? 'no confirmed farm; wallet cohort not decisive'
    : 'wallet edge not proven yet';
  let blockPromotion = false;
  let suppressPromotion = false;

  if (memoryHits.rugHits >= 3 || (sameFunderPct >= 0.40 && tokenSimilarity >= 0.30) || sybil) {
    status = memoryHits.rugHits >= 3 ? 'SCAMMERS' : 'BOTTED';
    icon = '🔴';
    blockPromotion = status === 'SCAMMERS';
    suppressPromotion = true;
    labelReason = reasons.slice(0, 3).join(' / ') || 'wallet farm imprint';
  } else if (farmScore >= 4.5) {
    status = 'BOTTED';
    icon = '🔴';
    suppressPromotion = true;
    labelReason = reasons.slice(0, 3).join(' / ') || 'wallet farm imprint';
  } else if (healthyScore >= 2.5 && farmScore < 3) {
    status = 'HEALTHY';
    icon = '🟢';
    labelReason = healthyReasons.slice(0, 3).join(' / ') || 'mixed top wallets';
  }

  const pretty = status === 'HEALTHY'
    ? 'Healthy'
    : status === 'BOTTED'
      ? 'Botted'
      : status === 'SCAMMERS'
        ? 'Scammers'
        : 'Unknown';

  const coverage = deep
    ? `top${wallets.length} resolved ${ownersResolved}/${wallets.length}${tracedWallets ? `, traced ${tracedWallets}` : ''}`
    : `top${wallets.length} shallow`;

  return {
    status,
    icon,
    oneLine: `🔎 Forensics: ${icon} ${pretty} — ${labelReason}. (${coverage})`,
    blockPromotion,
    suppressPromotion,
    reason: labelReason,
    features: {
      ca,
      topWalletCount: wallets.length,
      holderCount,
      top10Pct,
      top20Pct,
      tokenSimilarity,
      solSimilarity,
      tokenSpread,
      solSpread,
      farmScore,
      healthyScore,
      winnerHits: memoryHits.winnerHits,
      rugHits: memoryHits.rugHits,
      ownerResolvedPct,
      freshWalletPct,
      tracedWallets,
      sameFunderPct,
      sameFunderCount: funderCommon.count,
      sameFunder: funderCommon.value,
      slotCluster,
      sybil,
      deep,
    },
  };
}

async function runDeepForensics(ca, context = {}) {
  let topWallets = [];

  try {
    topWallets = await resolveTopTokenAccounts(ca, 20);
  } catch (e) {
    topWallets = Array.isArray(context.topWallets) ? context.topWallets.slice(0, 20) : [];
  }

  try {
    topWallets = await enrichWalletsDeep(topWallets, {
      limit: 20,
      traceLimit: Number(process.env.FORENSICS_TRACE_LIMIT || 10),
    });
  } catch (_) {}

  return evaluateHolderCohort({
    ca,
    marketCap: context.marketCap,
    ageMinutes: context.ageMinutes,
    holders: context.holders,
    topWallets,
    bundle: context.bundle,
    deep: true,
  });
}

function rememberWalletsFromOutcome({ outcome, topWallets = [], funders = [] } = {}) {
  const memory = loadWalletMemory();
  const bucket = outcome === 'WINNER' || outcome === 'RUNNER'
    ? 'winners'
    : outcome === 'FLAT_OR_RUG' || outcome === 'FAILED_PEARL'
      ? 'rugs'
      : null;

  if (!bucket) return;

  const now = Date.now();
  for (const w of topWallets || []) {
    const addr = w.owner || w.address || w.wallet;
    if (!addr) continue;
    const prev = memory[bucket][addr] || { count: 0, firstSeen: now };
    memory[bucket][addr] = { ...prev, count: (prev.count || 0) + 1, lastSeen: now };
  }

  for (const f of funders || []) {
    if (!f) continue;
    const prev = memory.funders[f] || { count: 0, firstSeen: now };
    memory.funders[f] = { ...prev, count: (prev.count || 0) + 1, lastSeen: now, outcome };
  }

  saveWalletMemory(memory);
}

module.exports = {
  evaluateHolderCohort,
  runDeepForensics,
  rememberWalletsFromOutcome,
  loadWalletMemory,
  saveWalletMemory,
};
