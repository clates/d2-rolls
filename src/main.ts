import uFuzzy from '@leeoniya/ufuzzy';
import './style.css';

interface Tier { n: number; mods: string[] }
interface Item {
  id: string;
  q: 'u' | 's' | 'b';
  name: string;
  set?: string;
  base?: string;
  type: string;
  tier: '' | 'n' | 'x' | 'e';
  lvl: number;
  img: string | null;
  ladder?: string;
  implicit: string[];
  mods: string[];
  setOwn?: Tier[];
}
interface SetInfo { pieces: string[]; partial: Tier[]; full: string[] }

interface Line { text: string; nums: [number, number][] }
interface Entry { item: Item; head: string; lines: Line[]; order: number }

const QUALITY = { u: 'unique', s: 'set', b: 'base' } as const;
const TIER = { n: 'Normal', x: 'Exceptional', e: 'Elite', '': '' } as const;

// Shorthand players type, keyed by the phrase the game prints.
const ALIASES: [RegExp, string][] = [
  [/faster cast rate/, 'fcr'],
  [/faster hit recovery/, 'fhr'],
  [/faster run\/walk/, 'frw'],
  [/increased attack speed/, 'ias'],
  [/faster block rate/, 'fbr'],
  [/enhanced damage/, 'ed'],
  [/enhanced defense/, 'ed'],
  [/better chance of getting magic items/, 'mf magic find'],
  [/extra gold/, 'gf gold find'],
  [/life stolen/, 'll leech lifesteal'],
  [/mana stolen/, 'ml leech manasteal'],
  [/crushing blow/, 'cb'],
  [/deadly strike/, 'ds'],
  [/open wounds/, 'ow'],
  [/attack rating/, 'ar'],
  [/all resistances/, 'allres'],
  [/^damage reduced|physical damage received reduced/, 'dr pdr'],
  [/magic damage reduced/, 'mdr'],
  [/to all skills/, 'allskills'],
  [/increased chance of blocking/, 'block'],
  [/cannot be frozen/, 'cbf'],
  [/indestructible/, 'indy'],
  [/experience gained/, 'exp xp'],
  [/requirements/, 'req'],
  [/replenish life/, 'regen'],
  [/maximum life/, 'life'],
  [/maximum mana/, 'mana'],
];

const RANGE = /\{([^}]+)\}/g;
const NUMS = /\{(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\}|(\d+(?:\.\d+)?)/g;

function prepLine(raw: string): Line {
  const plain = raw.replace(RANGE, '$1').toLowerCase();
  const aliases = ALIASES.filter(([re]) => re.test(plain)).map(([, a]) => a);
  const nums: [number, number][] = [];
  for (const m of raw.matchAll(NUMS)) {
    if (m[3] !== undefined) nums.push([+m[3], +m[3]]);
    else nums.push([+m[1], +m[2]]);
  }
  return { text: aliases.length ? `${plain} ${aliases.join(' ')}` : plain, nums };
}

function allLines(item: Item, sets: Record<string, SetInfo>): string[] {
  const out = [...item.implicit, ...item.mods];
  for (const t of item.setOwn ?? []) out.push(...t.mods);
  const s = item.set ? sets[item.set] : undefined;
  if (s) {
    for (const t of s.partial) out.push(...t.mods);
    out.push(...s.full);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Search

interface Query { words: string[]; nums: number[]; raw: string }

function parseQuery(raw: string): Query {
  const words: string[] = [];
  const nums: number[] = [];
  for (const m of raw.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    if (m[1]) { words.push(m[1].trim()); continue; }
    const t = m[2];
    const n = t.match(/^[+-]?(\d+(?:\.\d+)?)%?$/);
    if (n) nums.push(+n[1]);
    else {
      const w = t.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
      if (w) words.push(w);
    }
  }
  return { words, nums, raw: raw.trim().toLowerCase() };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = new Map<string, RegExp>();
function prefixRe(w: string): RegExp {
  let re = wordRe.get(w);
  if (!re) wordRe.set(w, (re = new RegExp(`(^|[^a-z0-9])${esc(w)}`)));
  return re;
}

interface Hit { entry: Entry; score: number; lines: Set<number> }

function matchEntry(e: Entry, q: Query): Hit | null {
  const inHead: boolean[] = q.words.map((w) => prefixRe(w).test(e.head));
  const lineWords = q.words.filter((_, i) => !inHead[i]);
  const hits = new Set<number>();

  if (q.nums.length) {
    // "37 fire res": a line that rolls 37 AND says whatever the item's names don't.
    e.lines.forEach((l, i) => {
      if (!lineWords.every((w) => prefixRe(w).test(l.text))) return;
      if (q.nums.every((n) => l.nums.some(([lo, hi]) => n >= lo && n <= hi))) hits.add(i);
    });
    if (!hits.size) return null;
  } else {
    for (const w of lineWords) {
      const re = prefixRe(w);
      let found = false;
      e.lines.forEach((l, i) => { if (re.test(l.text)) { hits.add(i); found = true; } });
      if (!found) return null;
    }
  }

  const name = e.item.name.toLowerCase();
  let score = 3;
  if (q.words.length && name.startsWith(q.words.join(' '))) score = 0;
  else if (q.words.length && q.words.every((w) => prefixRe(w).test(name))) score = 1;
  else if (q.words.length && inHead.every(Boolean)) score = 2;
  return { entry: e, score, lines: hits };
}

function search(entries: Entry[], raw: string): Hit[] {
  const q = parseQuery(raw);
  if (!q.words.length && !q.nums.length) return entries.map((entry) => ({ entry, score: 0, lines: new Set() }));
  let hits = entries.map((e) => matchEntry(e, q)).filter((h): h is Hit => h !== null);
  if (!hits.length && q.words.length && !q.nums.length) {
    // Nothing matched exactly: allow typos in names.
    const uf = new uFuzzy({ intraMode: 1 });
    const hay = entries.map((e) => e.head);
    const idxs = uf.filter(hay, q.words.join(' ')) ?? [];
    hits = idxs.map((i) => ({ entry: entries[i], score: 3, lines: new Set<number>() }));
  }
  return hits.sort((a, b) => a.score - b.score || a.entry.order - b.entry.order);
}

// ---------------------------------------------------------------------------------------------
// Rendering

const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rolled = (s: string) => html(s).replace(RANGE, '<b>$1</b>');

function lineLi(text: string, idx: number, hits: Set<number>, cls = '', label = ''): string {
  const classes = [cls, text.includes('{') ? 'roll' : 'fixed', hits.has(idx) ? 'hit' : ''].filter(Boolean).join(' ');
  return `<li class="${classes}">${label ? `<i>${label}</i> ` : ''}${rolled(text)}</li>`;
}

function card(hit: Hit, sets: Record<string, SetInfo>): string {
  const it = hit.entry.item;
  let i = 0;
  const li = (t: string, cls = '', label = '') => lineLi(t, i++, hit.lines, cls, label);

  const sub = [
    it.q === 'b' ? html(it.type) : html(it.base ?? ''),
    it.tier ? `<span class="tier ${it.tier}">${TIER[it.tier]}</span>` : '',
    it.lvl ? `lvl ${it.lvl}` : '',
    it.ladder ? `<span class="ladder" title="Ladder-only, season ${it.ladder}">ladder</span>` : '',
  ].filter(Boolean).join(' · ');

  let body = '';
  if (it.implicit.length) body += `<ul class="imp">${it.implicit.map((t) => li(t)).join('')}</ul>`;
  if (it.mods.length) body += `<ul class="mods">${it.mods.map((t) => li(t)).join('')}</ul>`;
  if (it.setOwn?.length) {
    body += `<ul class="setb">${it.setOwn.flatMap((t) => t.mods.map((m) => li(m, '', `(${t.n} items)`))).join('')}</ul>`;
  }
  const s = it.set ? sets[it.set] : undefined;
  if (s) {
    body += `<div class="set"><h3>${html(it.set!)} <span>${s.pieces.length} pieces</span></h3><ul class="setb">`;
    body += s.partial.flatMap((t) => t.mods.map((m) => li(m, '', `(${t.n})`))).join('');
    body += s.full.map((m) => li(m, 'full', 'full')).join('');
    body += '</ul></div>';
  }

  const img = it.img
    ? `<img loading="lazy" decoding="async" src="img/${it.img}.webp" alt="">`
    : '';
  return `<article class="card ${it.q}" data-id="${it.id}">
    <div class="art">${img}</div>
    <h2><a href="?q=${encodeURIComponent(`"${it.name}"`)}">${html(it.name)}</a></h2>
    ${it.set ? `<div class="setname">${html(it.set)}</div>` : ''}
    <div class="sub">${sub}</div>
    ${body}
  </article>`;
}

/** Rough rendered height, so cards can go to the shortest column without measuring. */
function estimate(it: Item, sets: Record<string, SetInfo>): number {
  const s = it.set ? sets[it.set] : undefined;
  const lines = it.implicit.length + it.mods.length
    + (it.setOwn?.reduce((a, t) => a + t.mods.length, 0) ?? 0)
    + (s ? 2 + s.partial.reduce((a, t) => a + t.mods.length, 0) + s.full.length : 0);
  return 150 + lines * 19;
}

// ---------------------------------------------------------------------------------------------
// App

const input = document.getElementById('q') as HTMLInputElement;
const grid = document.getElementById('grid')!;
const count = document.getElementById('count')!;
const sentinel = document.getElementById('sentinel')!;

const BATCH = 48;
const MIN_COL = 260;

async function main() {
  const res = await fetch('items.json');
  const data: { items: Item[]; sets: Record<string, SetInfo> } = await res.json();
  const { sets } = data;
  const entries: Entry[] = data.items.map((item, order) => ({
    item,
    order,
    head: [item.name, item.set, item.base, item.type, QUALITY[item.q], TIER[item.tier]].filter(Boolean).join(' | ').toLowerCase(),
    lines: allLines(item, sets).map(prepLine),
  }));

  let hits: Hit[] = [];
  let shown = 0;
  let cols: HTMLElement[] = [];
  let heights: number[] = [];

  function layout() {
    const n = Math.max(1, Math.floor((grid.clientWidth + 12) / (MIN_COL + 12)));
    grid.innerHTML = '';
    cols = Array.from({ length: n }, () => grid.appendChild(document.createElement('div')));
    cols.forEach((c) => (c.className = 'col'));
    heights = new Array(n).fill(0);
    const target = Math.max(shown, BATCH);
    shown = 0;
    more(target);
  }

  function more(n = BATCH) {
    const end = Math.min(hits.length, shown + n);
    const frags = cols.map(() => [] as string[]);
    for (; shown < end; shown++) {
      const h = hits[shown];
      const c = heights.indexOf(Math.min(...heights));
      heights[c] += estimate(h.entry.item, sets);
      frags[c].push(card(h, sets));
    }
    frags.forEach((f, c) => f.length && cols[c].insertAdjacentHTML('beforeend', f.join('')));
  }

  function run(push = false) {
    const q = input.value;
    hits = search(entries, q);
    count.textContent = `${hits.length}`;
    shown = 0;
    layout();
    window.scrollTo({ top: 0 });
    const url = new URL(location.href);
    if (q.trim()) url.searchParams.set('q', q.trim());
    else url.searchParams.delete('q');
    if (url.href !== location.href) history[push ? 'pushState' : 'replaceState'](null, '', url);
  }

  let t = 0;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = window.setTimeout(() => run(), 90);
  });

  new IntersectionObserver((es) => {
    if (es.some((e) => e.isIntersecting) && shown < hits.length) more();
  }, { rootMargin: '1200px' }).observe(sentinel);

  let lastCols = 0;
  new ResizeObserver(() => {
    const n = Math.max(1, Math.floor((grid.clientWidth + 12) / (MIN_COL + 12)));
    if (n !== lastCols) { lastCols = n; layout(); }
  }).observe(grid);

  // Clicking a name narrows to that item, as a shareable URL.
  grid.addEventListener('click', (ev) => {
    const a = (ev.target as HTMLElement).closest('h2 a') as HTMLAnchorElement | null;
    if (!a || ev.metaKey || ev.ctrlKey) return;
    ev.preventDefault();
    input.value = new URL(a.href).searchParams.get('q') ?? '';
    run(true);
  });

  window.addEventListener('popstate', () => {
    input.value = new URLSearchParams(location.search).get('q') ?? '';
    run();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      input.value = '';
      run();
      input.focus();
      return;
    }
    if (document.activeElement === input || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === '/') { ev.preventDefault(); input.focus(); input.select(); return; }
    if (ev.key.length === 1) input.focus();
  });

  input.value = new URLSearchParams(location.search).get('q') ?? '';
  run();
}

main();
