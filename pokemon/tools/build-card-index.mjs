// Builds the offline card database for the app (runs in GitHub Actions, see .github/workflows/card-index.yml):
//   pokemon/data/cards.json   – every English Pokémon TCG card: id, name, number, set, rarity, type, image, price snapshot
//   pokemon/data/features.bin – a 168-byte image fingerprint per card (same order), used to recognise a photo
// Fingerprints of cards that were already in the previous index are reused, so weekly runs only download new cards.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(HERE, '..', 'data');
await import(path.join(HERE, '..', 'card-features.js'));
const CF = globalThis.CardFeatures;

const API = process.env.API_BASE || 'https://api.pokemontcg.io/v2';
const headers = process.env.POKEMONTCG_API_KEY ? { 'X-Api-Key': process.env.POKEMONTCG_API_KEY } : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      console.log(`  retry ${i} ${url} (${e.message})`);
      await sleep(2000 * i);
    }
  }
}
async function getBuffer(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(1000 * i);
    }
  }
}
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}
const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0);

/* ---------- 1. all cards + sets from the Pokémon TCG API ---------- */
console.log('Fetching sets...');
const setsRes = await getJSON(`${API}/sets?pageSize=250&orderBy=releaseDate`);
const sets = setsRes.data.map((s) => ({ id: s.id, name: s.name, series: s.series, printed: s.printedTotal, total: s.total, date: s.releaseDate, logo: s.images && s.images.logo }));
const setIndex = new Map(sets.map((s, i) => [s.id, i]));
console.log(`  ${sets.length} sets`);

console.log('Fetching cards...');
const cards = [];
for (let page = 1; ; page++) {
  const d = await getJSON(`${API}/cards?page=${page}&pageSize=250&orderBy=set.releaseDate,number&select=id,name,number,rarity,types,supertype,set,images,tcgplayer,cardmarket`);
  for (const c of d.data) {
    if (!c.images || !c.images.small || !setIndex.has(c.set.id)) continue;
    // price snapshot: best TCGplayer market price (USD) and Cardmarket trend (EUR)
    let usd = 0;
    for (const p of Object.values((c.tcgplayer && c.tcgplayer.prices) || {})) usd = Math.max(usd, num(p && (p.market || p.mid)));
    const eur = num(c.cardmarket && c.cardmarket.prices && (c.cardmarket.prices.trendPrice || c.cardmarket.prices.avg30));
    cards.push({ id: c.id, name: c.name, number: c.number, set: setIndex.get(c.set.id), rarity: c.rarity || '',
      type: (c.types && c.types[0]) || (c.supertype === 'Trainer' ? 'Trainer' : c.supertype === 'Energy' ? 'Energy' : ''), img: c.images.small, usd, eur });
  }
  process.stdout.write(`\r  page ${page}: ${cards.length} cards`);
  if (d.data.length < 250) break;
  await sleep(150);
}
console.log('');

/* ---------- 2. fingerprints (reuse the previous index where possible) ---------- */
const prev = new Map();
try {
  const old = JSON.parse(await fs.readFile(path.join(DATA, 'cards.json'), 'utf8'));
  const bin = await fs.readFile(path.join(DATA, 'features.bin'));
  if (old.dim === CF.DIM) old.cards.forEach((row, i) => prev.set(row[0], bin.subarray(i * CF.DIM, (i + 1) * CF.DIM)));
  console.log(`Previous index: ${prev.size} fingerprints`);
} catch (e) { console.log('No previous index'); }

async function cardPixels(buf) {
  // flatten transparent rounded corners onto white, like a card photographed on a light background
  return sharp(buf).flatten({ background: '#ffffff' }).resize(CF.W, CF.H, { fit: 'fill', kernel: 'cubic' }).ensureAlpha().raw().toBuffer();
}

const features = new Uint8Array(cards.length * CF.DIM);
const keep = [];
const todo = [];
cards.forEach((c, i) => { if (prev.has(c.id)) features.set(prev.get(c.id), i * CF.DIM); else todo.push(i); });
console.log(`Downloading ${todo.length} new card images...`);
const samples = []; // for the self-test below
let done = 0, failed = 0;
await pool(todo, 24, async (i) => {
  const c = cards[i];
  try {
    const buf = await getBuffer(c.img);
    const px = await cardPixels(buf);
    features.set(new Uint8Array(CF.features(px).buffer), i * CF.DIM);
    keep.push(i);
    if (samples.length < 400 && Math.random() < 0.05) samples.push({ i, buf });
  } catch (e) {
    failed++;
    c.failed = true;
  }
  if (++done % 500 === 0) console.log(`  ${done}/${todo.length}`);
});
console.log(`  done, ${failed} failed`);

// cards whose image could not be read are left out
const okIdx = cards.map((c, i) => i).filter((i) => !cards[i].failed);
const outFeat = new Uint8Array(okIdx.length * CF.DIM);
okIdx.forEach((i, k) => outFeat.set(features.subarray(i * CF.DIM, (i + 1) * CF.DIM), k * CF.DIM));
const outCards = okIdx.map((i) => { const c = cards[i]; return [c.id, c.name, c.number, c.set, c.rarity, c.type, c.img, c.usd, c.eur]; });

await fs.mkdir(DATA, { recursive: true });
await fs.writeFile(path.join(DATA, 'features.bin'), outFeat);
await fs.writeFile(path.join(DATA, 'cards.json'), JSON.stringify({
  updated: new Date().toISOString().slice(0, 10), dim: CF.DIM,
  fields: ['id', 'name', 'number', 'set', 'rarity', 'type', 'img', 'usd', 'eur'],
  sets: sets.map((s) => [s.id, s.name, s.series, s.printed, s.total, s.date, s.logo]),
  cards: outCards,
}));
console.log(`Wrote ${outCards.length} cards, features ${outFeat.length} bytes`);

/* ---------- 3. self-test: distorted "photos" of sample cards, how often is the right card found? ---------- */
if (samples.length) {
  const feat = new Int8Array(outFeat.buffer);
  const pos = new Map(okIdx.map((i, k) => [i, k]));
  let top1 = 0, top5 = 0, n = 0;
  const marginsOk = [], marginsBad = [], simsOk = [];
  for (const s of samples) {
    if (!pos.has(s.i)) continue;
    const meta = await sharp(s.buf).metadata();
    const w = meta.width, h = meta.height;
    const cx = Math.round(w * (0.01 + Math.random() * 0.03)), cy = Math.round(h * (0.01 + Math.random() * 0.03));
    const gw = w - 2 * cx, gh = h - 2 * cy; // glare must match the cropped size
    const glare = Buffer.from(`<svg width="${gw}" height="${gh}"><ellipse cx="${gw * Math.random()}" cy="${gh * Math.random()}" rx="${gw * 0.25}" ry="${gh * 0.12}" fill="white" fill-opacity="0.35"/></svg>`);
    const distorted = await sharp(s.buf).flatten({ background: '#ffffff' })
      .extract({ left: cx, top: cy, width: gw, height: gh })
      .modulate({ brightness: 0.75 + Math.random() * 0.4, saturation: 0.8 + Math.random() * 0.4 })
      .blur(0.8 + Math.random())
      .composite([{ input: glare }]).png().toBuffer();
    const f = CF.features(await cardPixels(distorted));
    const scores = [];
    for (let k = 0; k < outCards.length; k++) scores.push([CF.similarity(f, feat, k * CF.DIM), k]);
    scores.sort((a, b) => b[0] - a[0]);
    const want = pos.get(s.i);
    const rank = scores.findIndex((x) => x[1] === want);
    // the "same artwork" group: reprints share the image, so compare with the best card of another name
    const other = scores.find((x) => outCards[x[1]][1] !== outCards[want][1]);
    n++;
    if (rank === 0) top1++;
    if (rank < 5) top5++;
    if (rank === 0) { simsOk.push(scores[0][0]); marginsOk.push(scores[0][0] - (other ? other[0] : 0)); }
    else marginsBad.push(scores[0][0] - (other ? other[0] : 0));
  }
  const q = (a, p) => { if (!a.length) return '-'; const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))].toFixed(3); };
  console.log(`SELF-TEST ${n} distorted samples: top1 ${(100 * top1 / n).toFixed(1)}%  top5 ${(100 * top5 / n).toFixed(1)}%`);
  console.log(`  sim of correct top1: p10 ${q(simsOk, 0.1)} p50 ${q(simsOk, 0.5)} | margin to best other-name card when correct: p10 ${q(marginsOk, 0.1)} p50 ${q(marginsOk, 0.5)} | when wrong: p50 ${q(marginsBad, 0.5)} p90 ${q(marginsBad, 0.9)}`);
}
