// Builds public/items.json from the extracted game tables in raw/.
//
// Mod text comes from d2itemtoolkit, a reimplementation of the game's own tooltip engine. Each item
// is rendered twice — every property at its minimum roll, then at its maximum — and the two
// tooltips are merged line by line: numbers that differ become a `{lo-hi}` range, the rest stay
// static. That keeps the wording exactly what the game prints.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TooltipEngine, GameVariant, D2DataFiles, createUnit, ItemTier } from 'd2itemtoolkit';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RAW = path.join(ROOT, 'raw');
const DIST = path.join(ROOT, 'node_modules/d2itemtoolkit/dist');
// Not part of the package's public surface, but exactly the roller the range reconstruction uses.
const { PropertyApplier, RollEnd } = await import(path.join(DIST, 'Stats/PropertyApplier.js'));
const { ItemIdentity } = await import(path.join(DIST, 'Stats/ItemRecord.js'));

const data = D2DataFiles.loadResurrected(
  GameVariant.ReignOfTheWarlock,
  path.join(RAW, 'excel'),
  path.join(RAW, 'strings'),
  path.join(RAW, 'strings-legacy'),
  path.join(RAW, 'global'),
);
const engine = TooltipEngine.fromData(data);
const lowApplier = new PropertyApplier(data, engine.items, engine.types, RollEnd.Low);
const highApplier = new PropertyApplier(data, engine.items, engine.types, RollEnd.High);

// ---------------------------------------------------------------------------------------------
// Tables

function readTxt(name) {
  const text = fs.readFileSync(path.join(RAW, 'excel', name + '.txt'), 'latin1').replace(/\r/g, '');
  const [head, ...lines] = text.split('\n');
  const cols = head.split('\t');
  // The game skips "Expansion" divider rows when numbering, and fileIndex follows the game.
  return lines.filter((l) => l.length && !l.startsWith('Expansion\t')).map((l, row) => {
    const cells = l.split('\t');
    const o = { _row: row };
    cols.forEach((c, i) => { if (!(c in o)) o[c] = cells[i] ?? ''; });
    return o;
  });
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const int = (v) => (v === '' || v === undefined ? 0 : parseInt(v, 10));

const weapons = readTxt('weapons');
const armor = readTxt('armor');
const misc = readTxt('misc');
const itemTypes = readTxt('itemtypes');
const uniqueItems = readTxt('uniqueitems');
const setItems = readTxt('setitems');
const sets = readTxt('sets');
const itemStatCost = readTxt('itemstatcost');
const skills = readTxt('skills');
const playerClass = readTxt('playerclass');

const str = (key) => (key ? data.strings.getByKey(key) ?? key : '');
const typeByCode = new Map(itemTypes.map((t) => [t.Code, t]));

const classIdByCode = new Map();
for (let i = 0; i < engine.items.rowCount; i++) classIdByCode.set(engine.items.rowAt(i).code, i);

const baseByCode = new Map();
for (const [kind, rows] of [['weapon', weapons], ['armor', armor], ['misc', misc]]) {
  for (const r of rows) if (r.code) baseByCode.set(r.code, { ...r, kind });
}

// HD art: item code -> asset, and unique/set key -> asset.
const flatten = (arr) => Object.assign({}, ...arr);
const hdItems = flatten(readJson(path.join(RAW, 'hd/items.json')));
const hdUniques = flatten(readJson(path.join(RAW, 'hd/uniques.json')));
const hdSets = flatten(readJson(path.join(RAW, 'hd/sets.json')));
const hdKey = (name) => name.toLowerCase().replace(/[ -]/g, '_').replace(/[^a-z0-9_]/g, '');
const imgExists = (asset) => asset && fs.existsSync(path.join(ROOT, 'public/img', asset + '.webp'));
function artFor(code, special) {
  const asset = special?.normal ?? special?.asset;
  if (imgExists(asset)) return asset;
  const base = hdItems[code]?.asset;
  if (imgExists(base)) return base;
  // Rings, amulets, charms and jewels pick a random variant per drop; show the first.
  if (imgExists(base + '1')) return base + '1';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rendering helpers

const NUM = /\d+(?:\.\d+)?/g;
const stripColor = (s) => (s ?? '').replace(/ÿc./g, '').replace(/\n+$/, '');

/** Merge the min-roll and max-roll text of one line into one with `{lo-hi}` ranges. */
function mergeLine(lo, hi) {
  if (lo === hi) return lo;
  const skelLo = lo.replace(NUM, '#');
  const skelHi = hi.replace(NUM, '#');
  if (skelLo !== skelHi) return hi;
  const a = lo.match(NUM);
  const b = hi.match(NUM);
  let i = 0;
  return skelHi.replace(/#/g, () => {
    const x = a[i];
    const y = b[i++];
    if (x === y) return y;
    const [mn, mx] = parseFloat(x) <= parseFloat(y) ? [x, y] : [y, x];
    return `{${mn}-${mx}}`;
  });
}

function mergeLines(loLines, hiLines) {
  if (loLines.length !== hiLines.length) {
    // A stat that rounds to nothing at its low end drops its line; pair by stat instead.
    const byKey = new Map(loLines.map((l) => [l.key, l.text]));
    return hiLines.map((l) => ({ ...l, text: mergeLine(byKey.get(l.key) ?? l.text, l.text) }));
  }
  return hiLines.map((l, i) => ({ ...l, text: mergeLine(loLines[i].text, l.text) }));
}

const opParam = new Map(itemStatCost.map((r) => [int(r['*ID']), int(r['op param']) + int(r.ValShift)]));
const statByName = new Map(itemStatCost.map((r) => [r.Stat, int(r['*ID'])]));

/** "+0 to Life (Based on Character Level)" -> "+1.5 to Life per Character Level". */
function perLevel(text, statId, raw) {
  const m = text.match(/^([+-]?)0(%?.*?)\s*\(Based on Character Level\)$/);
  if (!m) return text;
  const shift = opParam.get(statId) ?? 0;
  const v = Math.round((raw / 2 ** shift) * 1000) / 1000;
  return `${m[1]}${v}${m[2]} per Character Level`;
}

function linesOf(tip, sections) {
  return tip.lines
    .filter((l) => sections.has(l.section) && stripColor(l.text))
    .flatMap((l) =>
      stripColor(l.text).split('\n').map((t) => ({ text: t, key: `${l.section}:${l.statId}:${l.layer}`, statId: l.statId, layer: l.layer, section: l.section })),
    );
}

// Required Level is left out: it is shown on its own.
const BASE_SECTIONS = new Set(['ArmorClass', 'WeaponDamage', 'Durability', 'RequiredStrength', 'RequiredDexterity', 'ClassRestriction', 'AttackSpeed', 'SmiteOrKickDamage', 'CharmDescription']);

/** The block line needs a viewer to draw, so it is added from the table instead. */
function withBlock(code, implicit) {
  const block = int(baseByCode.get(code)?.block);
  if (!block) return implicit;
  const at = implicit.findIndex((l) => l.startsWith('Defense'));
  const out = [...implicit];
  out.splice(at + 1, 0, `Chance to Block: ${block}%`);
  return out;
}
const MOD_SECTIONS = new Set(['Modifiers']);

/** The base array a fresh copy of this item type carries, at the min or max Defense roll. */
function baseStats(code, end) {
  const b = baseByCode.get(code);
  const stats = [];
  if (!b) return stats;
  if (b.kind === 'armor') stats.push({ id: 31, value: int(end === 'low' ? b.minac : b.maxac) });
  if (b.kind === 'weapon') {
    if (b.mindam) stats.push({ id: 21, value: int(b.mindam) }, { id: 22, value: int(b.maxdam) });
    if (b['2handmindam']) stats.push({ id: 23, value: int(b['2handmindam']) }, { id: 24, value: int(b['2handmaxdam']) });
    if (b.minmisdam) stats.push({ id: 159, value: int(b.minmisdam) }, { id: 160, value: int(b.maxmisdam) });
  }
  if (b.durability && b.nodurability !== '1') {
    stats.push({ id: 72, value: int(b.durability) }, { id: 73, value: int(b.durability) });
  }
  return stats;
}

const statKey = (stat, layer) => ((layer & 0xffff) << 16) | (stat & 0xffff);
const mapToStats = (m) => [...m].map(([k, value]) => ({ id: k & 0xffff, layer: k >>> 16, value }));
const isPacked = (id) => id === 204 || (id >= 268 && id <= 303);

/** Render an item at both ends of its rolls. `own` is [{id, layer, low, high}]. */
function renderBoth({ code, quality, fileIndex, own, sections }) {
  const classId = classIdByCode.get(code);
  const tips = ['low', 'high'].map((end) => {
    const stats = own.map((s) => ({ id: s.id, layer: s.layer, value: isPacked(s.id) ? s.high : s[end] }));
    const unit = createUnit({
      unitType: 4, classId, quality, fileIndex, itemFlags: 16, itemLevel: 99, format: 100,
      statsLists: [
        { stateNo: 0, flags: 0x80000000, stats: baseStats(code, end) },
        { stateNo: 0, flags: 0x40, stats },
      ],
    });
    return engine.render(unit, null, null);
  });
  const lines = mergeLines(linesOf(tips[0], sections), linesOf(tips[1], sections));
  const highRaw = new Map(own.map((s) => [statKey(s.id, s.layer), s.high]));
  return lines.map((l) => ({ ...l, text: perLevel(l.text, l.statId, highRaw.get(statKey(l.statId, l.layer)) ?? 0) }));
}

/** Roll a property list (set bonuses) at both ends into [{id, layer, low, high}]. */
function rollProps(code, props) {
  const identity = Object.assign(new ItemIdentity(), { classId: classIdByCode.get(code), code, quality: 5, itemLevel: 99, format: 100 });
  const lo = new Map();
  const hi = new Map();
  for (const p of props) {
    const propertyId = lowApplier.properties.rowForCode(p.code);
    if (propertyId < 0) continue;
    const prop = { propertyId, param: parseParam(p.param), min: p.min, max: p.max };
    lowApplier.apply(PropertyApplier.PropModeGem, identity, prop, lo);
    highApplier.apply(PropertyApplier.PropModeGem, identity, prop, hi);
  }
  const keys = new Set([...lo.keys(), ...hi.keys()]);
  return [...keys].map((k) => ({ id: k & 0xffff, layer: k >>> 16, low: lo.get(k) ?? 0, high: hi.get(k) ?? 0 }));
}

const skillIdByName = new Map(skills.map((s) => [s.skill.toLowerCase(), int(s['*Id'])]));
function parseParam(p) {
  if (!p) return 0;
  if (/^-?\d+$/.test(p)) return int(p);
  return skillIdByName.get(p.toLowerCase()) ?? 0;
}

/** Mod lines for bare stats on a throwaway copy of `code`, minus what the base itself prints
 *  (a blunt weapon's +50% Damage to Undead). */
const baselineCache = new Map();
function modLines(code, own) {
  if (!own.length) return [];
  if (!baselineCache.has(code)) {
    baselineCache.set(code, new Set(renderBoth({ code, quality: 4, fileIndex: 0, own: [], sections: MOD_SECTIONS }).map((l) => l.text)));
  }
  const baseline = baselineCache.get(code);
  return renderBoth({ code, quality: 4, fileIndex: 0, own, sections: MOD_SECTIONS }).map((l) => l.text).filter((t) => !baseline.has(t));
}

const propLines = (code, props) => modLines(code, rollProps(code, props));

// Class names for the "random skill" lines the tooltip cannot draw without the roll.
const classNames = playerClass.filter((c) => c.Code).map((c) => c['Player Class']);
const skillClass = new Map(skills.map((s) => [int(s['*Id']), s.charclass]));
const classByCode = new Map(playerClass.filter((c) => c.Code).map((c) => [c.Code, c['Player Class']]));

function layerVariesLine(lv) {
  const value = lv.value;
  if (lv.statId === 107 || lv.statId === 97) {
    const cls = classByCode.get(skillClass.get(lv.layerLow));
    return `+${value} to a Random ${cls ?? ''} Skill`.replace('  ', ' ');
  }
  if (lv.statId === 83) return `+${value} to a Random Class's Skill Levels`;
  if (lv.statId === 188) return `+${value} to a Random Skill Tab`;
  return `+${value} to a Random Skill`;
}

function choiceLines(code, choice) {
  const opts = [];
  for (const o of choice.options) {
    for (const v of o.variants) {
      const lines = modLines(code, v.stats.map((s) => ({ id: s.statId, layer: s.layer, low: s.low, high: s.high })));
      if (lines.length) opts.push(lines.join(', '));
    }
  }
  const unique = [...new Set(opts)];
  if (!unique.length) return [];
  const n = choice.countLow === choice.countHigh ? choice.countHigh : `${choice.countLow}-${choice.countHigh}`;
  const head = n === 1 || choice.pickMode === 25 ? 'One of' : `${n} of`;
  return [`${head}: ${unique.join(' · ')}`];
}

// ---------------------------------------------------------------------------------------------
// Items

const tierName = (code) => {
  const b = baseByCode.get(code);
  if (!b || b.kind === 'misc') return '';
  const t = engine.items.rowAt(classIdByCode.get(code))?.tier;
  return t === ItemTier.Elite ? 'e' : t === ItemTier.Exceptional ? 'x' : 'n';
};
const baseName = (code) => str(baseByCode.get(code)?.namestr) || code;
const typeName = (code) => {
  return typeByCode.get(baseByCode.get(code)?.type)?.ItemType ?? '';
};
const ladderOf = (r) => {
  const a = r.firstLadderSeason;
  const b = r.lastLadderSeason;
  if (!a) return undefined;
  return b && b !== a ? `${a}-${b}` : a;
};

function ownMods(code, quality, fileIndex) {
  const identity = Object.assign(new ItemIdentity(), {
    classId: classIdByCode.get(code), code, quality, fileIndex, flags: 16, itemLevel: 99, format: 100,
  });
  // The item's own sources only; the base Defense roll goes on the base array in renderBoth.
  const rg = engine.rangesReconstructor.reconstruct(identity, null, null, null, true, false);
  const own = rg.stats
    .map((s) => ({ id: s.statId, layer: s.layer, low: s.low, high: s.high }))
    .filter((s) => s.low || s.high);
  const lines = renderBoth({ code, quality, fileIndex, own, sections: new Set([...BASE_SECTIONS, ...MOD_SECTIONS]) });
  const implicit = withBlock(code, lines.filter((l) => BASE_SECTIONS.has(l.section)).map((l) => l.text));
  const mods = lines.filter((l) => MOD_SECTIONS.has(l.section)).map((l) => l.text);
  for (const lv of rg.layerVaries) mods.push(layerVariesLine(lv));
  for (const c of rg.choices) mods.push(...choiceLines(code, c));
  return { implicit, mods, problems: [...rg.outOfRange, ...rg.unattributed].length };
}

function reqLevel(code, quality, fileIndex) {
  const unit = createUnit({ unitType: 4, classId: classIdByCode.get(code), quality, fileIndex, itemFlags: 16, itemLevel: 99, format: 100 });
  return engine.requirements(unit, null).level;
}

const items = [];
const seenUniqueNames = new Map();

for (const r of uniqueItems) {
  const code = r.code;
  if (!code || !classIdByCode.has(code) || r.disabled === '1' || r.spawnable !== '1') continue;
  if (int(baseByCode.get(code)?.quest)) continue; // Khalim's Flail, Horadric Staff and friends
  const { implicit, mods } = ownMods(code, 7, r._row);
  let name = str(r.index);
  if (r.index.startsWith('Crafted ')) name += ' (Crafted)';
  seenUniqueNames.set(name, (seenUniqueNames.get(name) ?? 0) + 1);
  items.push({
    q: 'u', name, base: baseName(code), type: typeName(code), tier: tierName(code),
    lvl: reqLevel(code, 7, r._row), img: artFor(code, hdUniques[hdKey(r.index)]),
    ladder: ladderOf(r), implicit, mods,
  });
}

const setBonus = {};
for (const s of sets) {
  if (!s.index || s.index === 'Expansion') continue;
  const pieces = setItems.filter((p) => p.set === s.index);
  if (!pieces.length) continue;
  const code = pieces[0].item;
  const partial = [];
  for (let n = 2; n <= 5; n++) {
    const props = ['a', 'b']
      .map((h) => ({ code: s[`PCode${n}${h}`], param: s[`PParam${n}${h}`], min: int(s[`PMin${n}${h}`]), max: int(s[`PMax${n}${h}`]) }))
      .filter((p) => p.code);
    const lines = propLines(code, props);
    if (lines.length) partial.push({ n, mods: lines });
  }
  const full = propLines(code, [1, 2, 3, 4, 5, 6, 7, 8]
    .map((i) => ({ code: s[`FCode${i}`], param: s[`FParam${i}`], min: int(s[`FMin${i}`]), max: int(s[`FMax${i}`]) }))
    .filter((p) => p.code));
  setBonus[str(s.name)] = { pieces: pieces.map((p) => str(p.index)), partial, full };
}

for (const r of setItems) {
  const code = r.item;
  if (!code || !classIdByCode.has(code) || !r.set) continue;
  const { implicit, mods } = ownMods(code, 5, r._row);
  // aprop<n>a/b: the piece's own bonuses as more of the set is worn. add func 2 counts any pieces;
  // add func 1 keys each tier to specific sibling pieces, which the game also labels by count.
  const own = [];
  if (int(r['add func'])) {
    for (let n = 1; n <= 5; n++) {
      const props = ['a', 'b']
        .map((h) => ({ code: r[`aprop${n}${h}`], param: r[`apar${n}${h}`], min: int(r[`amin${n}${h}`]), max: int(r[`amax${n}${h}`]) }))
        .filter((p) => p.code);
      const lines = propLines(code, props);
      if (lines.length) own.push({ n: n + 1, mods: lines });
    }
  }
  const setName = str(sets.find((s) => s.index === r.set)?.name ?? r.set);
  items.push({
    q: 's', name: str(r.index), set: setName, base: baseName(code), type: typeName(code), tier: tierName(code),
    lvl: reqLevel(code, 5, r._row), img: artFor(code, hdSets[hdKey(r.index)]),
    ladder: ladderOf(r), implicit, mods, setOwn: own.length ? own : undefined,
  });
}

// Bases: every droppable weapon and armor, rendered as a plain white item.
for (const [kind, rows] of [['weapon', weapons], ['armor', armor]]) {
  for (const b of rows) {
    if (!b.code || b.spawnable !== '1' || int(b.quest) || !classIdByCode.has(b.code)) continue;
    const lines = renderBoth({ code: b.code, quality: 2, fileIndex: 0, own: [], sections: BASE_SECTIONS });
    const implicit = withBlock(b.code, lines.map((l) => l.text));
    const sockets = int(b.gemsockets);
    if (sockets) implicit.push(`Max Sockets: ${sockets}`);
    if (b.speed && kind === 'weapon') implicit.push(`Base Speed: ${int(b.speed)}`);
    items.push({
      q: 'b', name: baseName(b.code), type: typeName(b.code), tier: tierName(b.code),
      lvl: int(b.levelreq), img: artFor(b.code), implicit, mods: [],
    });
  }
}

const tierOrder = { n: 0, x: 1, e: 2, '': 3 };
const qOrder = { u: 0, s: 1, b: 2 };
items.sort((a, b) => qOrder[a.q] - qOrder[b.q] || tierOrder[a.tier] - tierOrder[b.tier] || a.lvl - b.lvl || a.name.localeCompare(b.name));
items.forEach((it, i) => { it.id = slug(it); });
function slug(it) {
  return (it.q + '-' + it.name + (it.q === 'b' ? '' : '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
const dupes = new Map();
for (const it of items) {
  const n = dupes.get(it.id) ?? 0;
  dupes.set(it.id, n + 1);
  if (n) it.id += '-' + (n + 1);
}

fs.writeFileSync(path.join(ROOT, 'public/items.json'), JSON.stringify({ items, sets: setBonus }));
const missingArt = items.filter((i) => !i.img).map((i) => i.name);
console.log(`${items.length} items (${items.filter((i) => i.q === 'u').length} unique, ${items.filter((i) => i.q === 's').length} set, ${items.filter((i) => i.q === 'b').length} base), ${Object.keys(setBonus).length} sets`);
if (missingArt.length) console.log('no art:', missingArt.join(', '));
