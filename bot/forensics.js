'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const WALLET_MEMORY_FILE = path.join(DATA_DIR, 'wallet-memory.json');

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
    if (memory.winners?.[w]) winnerHits++;
    if (memory.rugs?.[w]) rugHits++;
  }

  return { winnerHits, rugHits };
}

function evaluateHolderCohort({
  ca,
  marketCap,
  ageMinutes,
  holders,
  topWallets = [],
  bundle = null,
} = {}) {
  const wallets = Array.isArray(topWallets) ? topWallets.slice(0, 20) : [];
  const memory = loadWalletMemory();

  if (!wallets.length) {
    return {
      status: 'UNKNOWN',
      icon: '🟡',
      oneLine: '🔎 Forensics: 🟡 Unknown — no confirmed farm; wallet edge not proven yet.',
      blockPromotion: false,
      suppressPromotion: false,
      reason: 'wallet edge not proven yet',
      features: {},
    };
  }

  const tokenAmounts = wallets.map(w => num(w.uiAmount ?? w.amount ?? w.tokenAmount, 0)).filter(v => v > 0);
  const holderCount = holders?.holderCount ?? null;
  const top10Pct = holders?.top10Pct ?? null;
  const top20Pct = holders?.top20Pct ?? null;

  const tokenSimilarity = bucketSimilarity(tokenAmounts, 0.08);
  const tokenSpread = pctSpread(tokenAmounts);
  const memoryHits = classifyWalletMemory(wallets, memory);

  const veryYoung = ageMinutes != null && Number(ageMinutes) <= 45;
  const lowMc = marketCap != null && Number(marketCap) <= 50_000;
  const smallHolderBase = holderCount != null && holderCount <= 100;
  const slotCluster = bundle?.maxInSlot != null ? Number(bundle.maxInSlot) : 0;
  const sybil = !!bundle?.sybilDetected;

  let farmScore = 0;
  const reasons = [];

  if (sybil) {
    farmScore += 5;
    reasons.push('confirmed sybil funding');
  }

  if (tokenSimilarity >= 0.45) {
    farmScore += 3;
    reasons.push('similar token sizing cluster');
  } else if (tokenSimilarity >= 0.30) {
    farmScore += 1.5;
    reasons.push('mild similar sizing');
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

  if (memoryHits.rugHits >= 3) {
    farmScore += 4;
    reasons.push(`${memoryHits.rugHits} prior rug-wallet hits`);
  } else if (memoryHits.rugHits >= 1) {
    farmScore += 1.5;
    reasons.push(`${memoryHits.rugHits} prior rug-wallet hit`);
  }

  let healthyScore = 0;
  const healthyReasons = [];

  if (memoryHits.winnerHits >= 2) {
    healthyScore += 3;
    healthyReasons.push(`${memoryHits.winnerHits} prior runner wallets`);
  } else if (memoryHits.winnerHits === 1) {
    healthyScore += 1;
    healthyReasons.push('1 prior runner wallet');
  }

  if (tokenSimilarity < 0.25 && tokenSpread != null && tokenSpread > 0.50) {
    healthyScore += 1.5;
    healthyReasons.push('mixed token sizing');
  }

  if (top10Pct != null && top10Pct <= 45 && !sybil) {
    healthyScore += 1;
    healthyReasons.push('top10 not death-zone');
  }

  let status = 'UNKNOWN';
  let icon = '🟡';
  let labelReason = 'no confirmed farm; wallet edge not proven yet';
  let blockPromotion = false;
  let suppressPromotion = false;

  if (sybil || farmScore >= 6 || memoryHits.rugHits >= 3) {
    status = memoryHits.rugHits >= 3 ? 'SCAMMERS' : 'BOTTED';
    icon = '🔴';
    blockPromotion = status === 'SCAMMERS';
    suppressPromotion = true;
    labelReason = reasons.slice(0, 2).join(' / ') || 'wallet farm imprint';
  } else if (farmScore >= 3.5) {
    status = 'BOTTED';
    icon = '🔴';
    suppressPromotion = true;
    labelReason = reasons.slice(0, 2).join(' / ') || 'similar sizing concentration';
  } else if (healthyScore >= 2 && farmScore < 3) {
    status = 'HEALTHY';
    icon = '🟢';
    labelReason = healthyReasons.slice(0, 2).join(' / ') || 'mixed top wallets';
  }

  const pretty = status === 'HEALTHY'
    ? 'Healthy'
    : status === 'BOTTED'
      ? 'Botted'
      : status === 'SCAMMERS'
        ? 'Scammers'
        : 'Unknown';

  return {
    status,
    icon,
    oneLine: `🔎 Forensics: ${icon} ${pretty} — ${labelReason}.`,
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
      tokenSpread,
      farmScore,
      healthyScore,
      winnerHits: memoryHits.winnerHits,
      rugHits: memoryHits.rugHits,
      slotCluster,
      sybil,
    },
  };
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
  rememberWalletsFromOutcome,
  loadWalletMemory,
  saveWalletMemory,
};
