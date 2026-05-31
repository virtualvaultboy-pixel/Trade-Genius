#!/usr/bin/env node
/**
 * Trade Genius — Tests basiques TG Winner.
 *
 * Smoke tests sans framework :
 *   1. Le JSON existe et a un schema valide
 *   2. La somme des weightPct = 100% (tolerance 0.1)
 *   3. Chaque ligne a priceUsd > 0 OU priceSource === 'unavailable'
 *   4. exampleAllocations.lines.amountEur somme = capitalEur (tolerance 1 EUR)
 *   5. exampleAllocations.lines.unitsApprox > 0 quand priceUsd dispo
 *   6. nextRebalance est dans le futur (> generatedAt) ET <= 32 jours
 *   7. fx.eurToUsd dans [0.5, 2]
 *
 * Usage : node scripts/test-tg-winner.mjs
 * Exit code 0 = OK, 1 = au moins un test fail.
 */
import fs from 'node:fs/promises';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let passed = 0, failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  ${GREEN}OK${RESET} ${label}`);
    passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET} ${label}`);
    failed++;
  }
}

async function main() {
  console.log('Loading data/tg-winner.json...');
  const raw = await fs.readFile('data/tg-winner.json', 'utf8');
  const w = JSON.parse(raw);

  console.log('\n[1] Schema');
  assert(w.schemaVersion === 1, 'schemaVersion === 1');
  assert(Array.isArray(w.basket), 'basket est un array');
  assert(w.basket.length >= 4, 'basket >= 4 lignes (' + w.basket.length + ')');
  assert(typeof w.strategy === 'object' && w.strategy?.name, 'strategy.name presente');

  console.log('\n[2] Sum weightPct == 100');
  const sumW = w.basket.reduce((s, b) => s + b.weightPct, 0);
  assert(Math.abs(sumW - 100) < 0.1, `sum = ${sumW.toFixed(2)}%`);

  console.log('\n[3] Prices coherents');
  for (const line of w.basket) {
    const ok = (line.priceUsd && line.priceUsd > 0) || line.priceSource === 'unavailable';
    assert(ok, `${line.ticker} : price ${line.priceUsd ?? 'null'} (${line.priceSource})`);
  }

  console.log('\n[4-5] exampleAllocations');
  assert(Array.isArray(w.exampleAllocations) && w.exampleAllocations.length > 0, 'allocations presentes');
  for (const alloc of w.exampleAllocations) {
    const sumEur = alloc.lines.reduce((s, l) => s + (l.amountEur || 0), 0);
    assert(Math.abs(sumEur - alloc.capitalEur) <= 1, `cap=${alloc.capitalEur} EUR : sum=${sumEur.toFixed(2)}`);
    for (const line of alloc.lines) {
      const refLine = w.basket.find(b => b.ticker === line.ticker);
      if (refLine?.priceUsd && refLine.priceUsd > 0) {
        assert(line.unitsApprox != null && line.unitsApprox > 0,
          `${line.ticker} units > 0 (got ${line.unitsApprox})`);
      }
    }
  }

  console.log('\n[6] nextRebalance dans le futur (1-32 jours)');
  const nextTs = Date.parse((w.strategy.nextRebalance || '') + 'T06:00:00Z');
  const genTs = Date.parse(w.generatedAt);
  const days = (nextTs - genTs) / 86400000;
  assert(Number.isFinite(days) && days > 0 && days <= 32, `next-gen = ${days?.toFixed(1)} jours`);

  console.log('\n[7] FX EUR/USD');
  const rate = w.fx?.eurToUsd;
  assert(typeof rate === 'number' && rate > 0.5 && rate < 2, `rate = ${rate}`);

  console.log(`\n${passed + failed} tests : ${GREEN}${passed} OK${RESET}, ${failed > 0 ? RED : GREEN}${failed} FAIL${RESET}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Test runner crashed:', e);
  process.exit(2);
});
