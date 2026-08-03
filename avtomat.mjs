#!/usr/bin/env node
/**
 * avtomat.mjs — кара истински Chrome, логнат в ChatGPT акаунта, и генерира кадрите сам.
 *
 * ПЪРВО (веднъж):   node avtomat.mjs --login      → отваря браузър, логваш се в ChatGPT на ръка, затваряш
 * После:            node avtomat.mjs              → минава през всички коли по ред
 * Една кола:        node avtomat.mjs --only peugeot-5008
 * Наново:           node avtomat.mjs --only peugeot-5008 --force
 * Проба без писане: node avtomat.mjs --dry-run
 *
 * Скриптът е resumable — готовите файлове се прескачат. Може да се спира и пуска пак.
 * Профилът на браузъра живее в .chrome-profil/ (gitignore-нат) и НЕ пипа личния профил на Chrome.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

// ---------- аргументи ----------
const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return (!v || v.startsWith('--')) ? true : v;
};

const LOGIN   = flag('login', false) === true;
const ONLY    = flag('only', null);
const FORCE   = flag('force', false) === true;
const DRY     = flag('dry-run', false) === true;
const PROFIL  = String(flag('profil', '.chrome-profil'));
const BAVNO   = Number(flag('bavno', 120)) || 120;   // ms между клавишите
const TIMEOUT_KADAR = Number(flag('timeout', 420)) * 1000; // колко чакаме един кадър

const KOLI = 'koli';
const LOG  = 'avtomat.log';
const DEBUG = '_debug';
const IMENA = { 1: '01-front', 2: '02-rear', 3: '03-interior', 4: '04-cabin' };

// ---------- селектори (ако UI-ят се смени, оправят се ТУК) ----------
const SEL = {
  komposer: '#prompt-textarea, div[contenteditable="true"][data-virtualkeyboard], div[contenteditable="true"]',
  asistent: '[data-message-author-role="assistant"]',
  spri_bnt: 'button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Спри"]',
  nov_chat: 'a[href="/"], button[data-testid="create-new-chat-button"]',
};

const log = (m) => {
  console.log(m);
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); } catch {}
};
const spri = (ms) => new Promise(r => setTimeout(r, ms));
const sluchajno = (a, b) => a + Math.random() * (b - a);

/** Разбива PROMPT.txt на отделните кадри. */
function razbiiPrompta(text) {
  const hits = [...text.matchAll(/^IMAGE (\d+) — (.+)$/gm)];
  if (!hits.length) throw new Error('в PROMPT.txt няма секции "IMAGE N — ..."');
  const banskaIdx = text.search(/^ABSOLUTE BANS in every image$/m);
  const bans = banskaIdx === -1 ? '' : text.slice(banskaIdx).trim();

  // Оригиналният промпт казва "generate THREE SEPARATE IMAGES". Тук кадрите идват
  // един по един, в отделни съобщения — иначе моделът връща колаж или спира по средата.
  const header = text.slice(0, hits[0].index).trim().replace(
    /^Professional automotive studio photography\..*$/m,
    `Professional automotive studio photography. I will send you the shots ONE AT A TIME, in separate messages. Produce exactly ONE image per message — never a collage, never a grid. Keep the same set, the same lighting and the same lens across all of them.`
  );

  return hits.map((h, i) => {
    const end = (i + 1 < hits.length) ? hits[i + 1].index : (banskaIdx === -1 ? text.length : banskaIdx);
    return { n: Number(h[1]), zaglavie: h[2].trim(), blok: text.slice(h.index, end).trim() };
  }).map((k, i, all) => ({
    ...k,
    // първото съобщение носи целия контекст; следващите само казват "давай следващия кадър"
    prvo: [header, k.blok, bans].filter(Boolean).join('\n\n'),
    prodalzhenie: `Сега кадър ${k.n} от ${all.length}, същият сет, същата светлина, същият обектив:\n\n${k.blok}`,
  }));
}

/** Пише текст в композера като човек и праща. */
async function pratiSaobshtenie(page, tekst) {
  const box = page.locator(SEL.komposer).first();
  await box.waitFor({ state: 'visible', timeout: 60000 });
  await box.click();
  // insertText е бърз и не се дави на дълъг текст; после малка пауза като човек
  await page.keyboard.insertText(tekst);
  await spri(sluchajno(600, 1400));
  await page.keyboard.press('Enter');
}

/** Чака нов генериран образ в последния отговор и връща байтовете му. */
async function izchakajObraz(page, predishniBroj) {
  const kraj = Date.now() + TIMEOUT_KADAR;

  while (Date.now() < kraj) {
    const broj = await page.evaluate((sel) => {
      const turns = document.querySelectorAll(sel);
      const posl = turns[turns.length - 1];
      if (!posl) return 0;
      return [...posl.querySelectorAll('img')].filter(i => i.naturalWidth > 400).length;
    }, SEL.asistent);

    if (broj > predishniBroj) {
      await spri(2500); // да се дорисува
      const b64 = await page.evaluate(async (sel) => {
        const turns = document.querySelectorAll(sel);
        const posl = turns[turns.length - 1];
        const imgs = [...posl.querySelectorAll('img')].filter(i => i.naturalWidth > 400);
        const img = imgs[imgs.length - 1];
        if (!img) return null;
        const r = await fetch(img.currentSrc || img.src);
        const buf = await r.arrayBuffer();
        let bin = '';
        const b = new Uint8Array(buf);
        for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
        return btoa(bin);
      }, SEL.asistent);
      if (b64) return Buffer.from(b64, 'base64');
    }

    // проверка за блокировка / искане за верификация
    const blokirano = await page.evaluate(() => {
      const t = document.body.innerText.slice(0, 4000).toLowerCase();
      return /verify you are human|unusual activity|rate limit|too many requests|you've reached|достигнахте/.test(t);
    });
    if (blokirano) throw new Error('BLOKIRANO: страницата иска верификация или е ударен лимит — спирам, човек да поеме');

    await spri(4000);
  }
  throw new Error(`образът не се появи за ${TIMEOUT_KADAR / 1000}s`);
}

async function brojObrazi(page) {
  return page.evaluate((sel) => {
    const turns = document.querySelectorAll(sel);
    const posl = turns[turns.length - 1];
    if (!posl) return 0;
    return [...posl.querySelectorAll('img')].filter(i => i.naturalWidth > 400).length;
  }, SEL.asistent);
}

/** Обработва една кола в собствен нов чат. */
async function kola(context, papka) {
  const dir = join(KOLI, papka);
  const promptFile = join(dir, 'PROMPT.txt');
  if (!existsSync(promptFile)) { log(`! ${papka}: няма PROMPT.txt`); return { ok: 0, skip: 0, err: 0 }; }

  const kadri = razbiiPrompta(readFileSync(promptFile, 'utf8'));
  const novi = join(dir, 'novi');
  let ok = 0, skip = 0, err = 0;

  const trqbva = kadri.filter(k => {
    const f = join(novi, `${IMENA[k.n] || k.n}.png`);
    return FORCE || !(existsSync(f) && statSync(f).size > 0);
  });
  if (!trqbva.length) { log(`= ${papka}: всички кадри са налице — прескачам`); return { ok: 0, skip: kadri.length, err: 0 }; }

  log(`\n=== ${papka} — ${trqbva.length} кадъра за правене ===`);
  if (DRY) { trqbva.forEach(k => log(`  ~ ${IMENA[k.n]} (${k.prvo.length} знака)`)); return { ok: 0, skip: 0, err: 0 }; }

  // НОВ ЧАТ за всяка кола — иначе моделът прелива цветовете между колите
  const page = await context.newPage();
  try {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await spri(sluchajno(2500, 4500));

    let parvo = true;
    for (const k of kadri) {
      const baza = IMENA[k.n] || `0${k.n}-kadar`;
      const izhod = join(novi, `${baza}.png`);
      if (!FORCE && existsSync(izhod) && statSync(izhod).size > 0) { log(`  = ${baza} вече съществува`); skip++; parvo = false; continue; }

      const predi = await brojObrazi(page);
      log(`  → искам ${baza} (${k.zaglavie})`);
      await pratiSaobshtenie(page, parvo ? k.prvo : k.prodalzhenie);
      parvo = false;

      try {
        const buf = await izchakajObraz(page, predi);
        mkdirSync(novi, { recursive: true });
        writeFileSync(izhod, buf);
        log(`  + ${baza}.png (${Math.round(buf.length / 1024)} KB)`);
        ok++;
      } catch (e) {
        err++;
        log(`  x ${baza}: ${e.message}`);
        mkdirSync(DEBUG, { recursive: true });
        await page.screenshot({ path: join(DEBUG, `${papka}-${baza}.png`), fullPage: false }).catch(() => {});
        if (/BLOKIRANO/.test(e.message)) throw e;
      }

      await spri(sluchajno(6000, 11000)); // пауза между кадрите
    }
  } finally {
    await page.close().catch(() => {});
  }
  return { ok, skip, err };
}

// ---------- главна ----------
if (!existsSync(KOLI) && !LOGIN) {
  console.error('Няма папка "koli/" — пусни скрипта от главната папка на пакета.');
  process.exit(1);
}

const context = await chromium.launchPersistentContext(PROFIL, {
  headless: false,          // ChatGPT реално не работи headless — не го включвай
  channel: 'chrome',        // истинският Chrome, не Chromium
  viewport: null,
  args: ['--start-maximized'],
});

if (LOGIN) {
  const p = await context.newPage();
  await p.goto('https://chatgpt.com/');
  console.log(`
================================================================
  Логни се в ChatGPT в отворения прозорец.
  Като видиш чата — просто ЗАТВОРИ браузъра.
  Профилът се запазва в ${PROFIL}/ и после скриптът го ползва сам.
================================================================
`);
  await context.waitForEvent('close', { timeout: 0 }).catch(() => {});
  process.exit(0);
}

let papki = readdirSync(KOLI).filter(d => statSync(join(KOLI, d)).isDirectory()).sort();
if (ONLY && ONLY !== true) papki = papki.filter(p => p.includes(String(ONLY)));
if (!papki.length) { console.error(`Няма коли по филтъра "${ONLY}"`); process.exit(1); }

log(`\nСтартирам · коли: ${papki.length}${FORCE ? ' · FORCE' : ''}${DRY ? ' · DRY-RUN' : ''}`);

const total = { ok: 0, skip: 0, err: 0 };
let sprqno = false;

for (const p of papki) {
  if (sprqno) break;
  try {
    const r = await kola(context, p);
    total.ok += r.ok; total.skip += r.skip; total.err += r.err;
  } catch (e) {
    log(`\nСПИРАМ: ${e.message}`);
    log('Отвори браузъра на ръка, оправи каквото иска (верификация/лимит), после пусни скрипта пак — продължава оттам, докъдето е стигнал.');
    sprqno = true;
    total.err++;
  }
  await spri(sluchajno(8000, 15000)); // пауза между колите
}

log(`\n----------------------------------------`);
log(`Готови: ${total.ok} · прескочени: ${total.skip} · провалени: ${total.err}`);
log(`Дневник: ${LOG}   Следва: node proveri.mjs`);

await context.close().catch(() => {});
process.exit(total.err ? 1 : 0);
