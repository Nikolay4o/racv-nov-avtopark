#!/usr/bin/env node
// Проверява кои кадри липсват. Пусни от главната папка: node proveri.mjs
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const KOLI = 'koli';
const NUZHNI = ['01-front', '02-rear', '03-interior'];
const EXTRA = { '03-peugeot-expert': ['04-cabin'] };
const OK_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

if (!existsSync(KOLI)) {
  console.error('Няма папка "koli/" — пусни скрипта от главната папка на пакета.');
  process.exit(1);
}

const papki = readdirSync(KOLI).filter(d => statSync(join(KOLI, d)).isDirectory()).sort();
let gotovi = 0, lipsvat = 0;
const redove = [];

for (const p of papki) {
  const novi = join(KOLI, p, 'novi');
  const faylove = existsSync(novi)
    ? readdirSync(novi).filter(f => OK_EXT.some(e => f.toLowerCase().endsWith(e)))
    : [];

  const iska = [...NUZHNI, ...(EXTRA[p] || [])];
  const namereni = [], lipsa = [];
  for (const baza of iska) {
    const hit = faylove.find(f => f.toLowerCase().startsWith(baza));
    if (hit) namereni.push(hit); else lipsa.push(baza);
  }

  const izlishni = faylove.filter(f => !iska.some(b => f.toLowerCase().startsWith(b)));
  const status = lipsa.length === 0 ? 'ГОТОВА' : `липсват ${lipsa.length}`;
  if (lipsa.length === 0) gotovi++; else lipsvat += lipsa.length;

  redove.push({ p, status, namereni: namereni.length, iska: iska.length, lipsa, izlishni });
}

console.log('\n  КОЛА                          СТАТУС        КАДРИ');
console.log('  ' + '-'.repeat(58));
for (const r of redove) {
  const znak = r.lipsa.length === 0 ? '+' : ' ';
  console.log(`${znak} ${r.p.padEnd(28)}  ${r.status.padEnd(12)}  ${r.namereni}/${r.iska}`);
  if (r.lipsa.length) console.log(`    липсва: ${r.lipsa.join(', ')}`);
  if (r.izlishni.length) console.log(`    непознато име (преименувай): ${r.izlishni.join(', ')}`);
}

console.log('\n  ' + '-'.repeat(58));
console.log(`  Готови коли: ${gotovi}/${papki.length}   ·   липсващи кадри: ${lipsvat}`);
if (lipsvat === 0) console.log('  Всичко е налице. Прати папката обратно.\n');
else console.log('  Имената трябва да са точно: 01-front / 02-rear / 03-interior (+ 04-cabin при вана)\n');

process.exit(lipsvat === 0 ? 0 : 1);
