#!/usr/bin/env node
/**
 * generirai.mjs — генерира всичките кадри на автопарка през OpenAI Images API.
 *
 * Пусни:   node generirai.mjs
 * Тест:    node generirai.mjs --only peugeot-5008 --quality medium
 * Наново:  node generirai.mjs --only peugeot-5008 --force
 *
 * Трябва: OPENAI_API_KEY в средата. Node 18+ (fetch е вграден).
 * Скриптът е resumable — готовите файлове се прескачат, така че може да се спира и пуска пак.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------- аргументи ----------
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return (!v || v.startsWith('--')) ? true : v;
};

const MODEL      = flag('model', process.env.IMAGE_MODEL || 'gpt-image-2');
const SIZE       = flag('size', process.env.IMAGE_SIZE || '1536x960'); // 16:10, ръбовете кратни на 16
const QUALITY    = flag('quality', process.env.IMAGE_QUALITY || 'high'); // low | medium | high | auto
const ONLY       = flag('only', null);
const FORCE      = flag('force', false) === true;
const DRY        = flag('dry-run', false) === true;
const CONCURRENCY = Number(flag('concurrency', 2)) || 2;

const KOLI = 'koli';
const LOG  = 'generacia.log';
const IMENA = { 1: '01-front', 2: '02-rear', 3: '03-interior', 4: '04-cabin' };

const API_KEY = process.env.OPENAI_API_KEY;

// ---------- помощни ----------
const log = (msg) => {
  const red = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  try { appendFileSync(LOG, red + '\n'); } catch {}
};

const spri = (ms) => new Promise(r => setTimeout(r, ms));

/** Разбива PROMPT.txt на отделни промптове — по един на кадър. */
function razbiiPrompta(text) {
  const marker = /^IMAGE (\d+) — (.+)$/gm;
  const hits = [...text.matchAll(marker)];
  if (!hits.length) throw new Error('в PROMPT.txt няма секции "IMAGE N — ..."');

  let header = text.slice(0, hits[0].index).trim();
  // махаме инструкцията за 3/4 кадъра — през API-то всяко извикване е един кадър
  header = header.replace(/^Professional automotive studio photography\..*?$/m,
    'Professional automotive studio photography. Produce exactly ONE image, described below.');

  const banskaIdx = text.search(/^ABSOLUTE BANS in every image$/m);
  const bans = banskaIdx === -1 ? '' : text.slice(banskaIdx).trim();

  const kadri = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index;
    const end = (i + 1 < hits.length) ? hits[i + 1].index : (banskaIdx === -1 ? text.length : banskaIdx);
    let block = text.slice(start, end).trim();
    block = block.replace(/^IMAGE \d+ — /, 'THIS IMAGE — ');
    kadri.push({
      n: Number(hits[i][1]),
      zaglavie: hits[i][2].trim(),
      prompt: [header, block, bans].filter(Boolean).join('\n\n'),
    });
  }
  return kadri;
}

/** Едно извикване към API-то, с повторения при 429/5xx. */
async function generiraj(prompt, etiket) {
  const telo = { model: MODEL, prompt, n: 1, size: SIZE, quality: QUALITY };

  for (let opit = 1; opit <= 4; opit++) {
    let r;
    try {
      r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(telo),
      });
    } catch (e) {
      log(`   мрежова грешка (${etiket}, опит ${opit}): ${e.message}`);
      await spri(2000 * opit);
      continue;
    }

    if (r.ok) {
      const data = await r.json();
      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) throw new Error(`отговорът няма b64_json: ${JSON.stringify(data).slice(0, 300)}`);
      return Buffer.from(b64, 'base64');
    }

    const tekst = await r.text();

    if (r.status === 400 && /model/i.test(tekst)) {
      throw new Error(
        `моделът "${MODEL}" не се приема. Пробвай друг: --model gpt-image-1.5  или  --model gpt-image-1\n${tekst.slice(0, 400)}`
      );
    }
    if (r.status === 401) throw new Error('401 — невалиден или липсващ OPENAI_API_KEY');
    if (r.status === 429 || r.status >= 500) {
      const izchakaj = 3000 * opit;
      log(`   ${r.status} (${etiket}, опит ${opit}) — чакам ${izchakaj / 1000}s`);
      await spri(izchakaj);
      continue;
    }
    throw new Error(`${r.status}: ${tekst.slice(0, 400)}`);
  }
  throw new Error(`${etiket}: не мина след 4 опита`);
}

/** Обработва една кола. */
async function kola(papka) {
  const dir = join(KOLI, papka);
  const promptFile = join(dir, 'PROMPT.txt');
  if (!existsSync(promptFile)) { log(`! ${papka}: няма PROMPT.txt — пропускам`); return { napraveni: 0, preskocheni: 0, greshki: 0 }; }

  const kadri = razbiiPrompta(readFileSync(promptFile, 'utf8'));
  const novi = join(dir, 'novi');
  let napraveni = 0, preskocheni = 0, greshki = 0;

  log(`\n=== ${papka} — ${kadri.length} кадъра ===`);

  for (const k of kadri) {
    const baza = IMENA[k.n] || `0${k.n}-kadar`;
    const izhod = join(novi, `${baza}.png`);

    const veche = existsSync(izhod) && statSync(izhod).size > 0;
    if (veche && !FORCE) { log(`  = ${baza} вече съществува — прескачам`); preskocheni++; continue; }

    if (DRY) { log(`  ~ ${baza} (dry-run, ${k.prompt.length} знака) — ${k.zaglavie}`); continue; }

    const start = Date.now();
    try {
      const buf = await generiraj(k.prompt, `${papka}/${baza}`);
      writeFileSync(izhod, buf);
      log(`  + ${baza}.png  (${Math.round(buf.length / 1024)} KB, ${Math.round((Date.now() - start) / 1000)}s) — ${k.zaglavie}`);
      napraveni++;
    } catch (e) {
      log(`  x ${baza} ПРОВАЛ: ${e.message}`);
      greshki++;
      if (/OPENAI_API_KEY|401|не се приема/.test(e.message)) throw e; // безсмислено е да продължаваме
    }
  }
  return { napraveni, preskocheni, greshki };
}

// ---------- главна ----------
if (!existsSync(KOLI)) {
  console.error('Няма папка "koli/" — пусни скрипта от главната папка на пакета.');
  process.exit(1);
}
if (!API_KEY && !DRY) {
  console.error(`
Липсва OPENAI_API_KEY.

  Windows (cmd):        set OPENAI_API_KEY=sk-...
  Windows (PowerShell): $env:OPENAI_API_KEY="sk-..."
  macOS / Linux:        export OPENAI_API_KEY=sk-...

Виж SETUP.md.
`);
  process.exit(1);
}

let papki = readdirSync(KOLI).filter(d => statSync(join(KOLI, d)).isDirectory()).sort();
if (ONLY && ONLY !== true) papki = papki.filter(p => p.includes(String(ONLY)));
if (!papki.length) { console.error(`Няма коли по филтъра "${ONLY}"`); process.exit(1); }

log(`\nМодел: ${MODEL} · размер: ${SIZE} · качество: ${QUALITY} · коли: ${papki.length}${FORCE ? ' · FORCE' : ''}${DRY ? ' · DRY-RUN' : ''}`);

const obshto = { napraveni: 0, preskocheni: 0, greshki: 0 };

// прости "нишки" — CONCURRENCY коли едновременно
const opashka = [...papki];
const rabotnik = async () => {
  while (opashka.length) {
    const p = opashka.shift();
    try {
      const r = await kola(p);
      obshto.napraveni += r.napraveni; obshto.preskocheni += r.preskocheni; obshto.greshki += r.greshki;
    } catch (e) {
      log(`\nСПИРАМ: ${e.message}`);
      opashka.length = 0;
      obshto.greshki++;
    }
  }
};
await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, rabotnik));

log(`\n----------------------------------------`);
log(`Готови: ${obshto.napraveni} · прескочени: ${obshto.preskocheni} · провалени: ${obshto.greshki}`);
log(`Дневник: ${LOG}`);
log(`Следва: node proveri.mjs`);

process.exit(obshto.greshki ? 1 : 0);
