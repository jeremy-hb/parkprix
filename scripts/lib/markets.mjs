// Marchés découverts (Paris Data) : jours et horaires de tenue, rattachés aux emplacements « Marché »
// (« Mixte Marché », « Rotatif Marché », « Gratuit Marché », « Marché ») par jointure spatiale.
// Ces emplacements sont interdits pendant le marché (fourrière possible) : un marché mal rattaché
// serait dangereux, d'où un rayon court et, sans correspondance, aucun marché (mention générique).

import { M_PER_DEG_LAT, M_PER_DEG_LON, bboxOf, distanceToGeometryM } from './geo.mjs';
import { titleCase } from './text.mjs';

export const MARKETS_DATASET = 'marches-decouverts';
/** Au-delà, l'emplacement « Marché » est laissé sans marché (≈ 83 % rattachés à 30 m en 2026). */
export const MARKET_MAX_M = 30;
/** Marchés au même endroit, à des jours différents (Edgar Quinet et marché de la Création) : on les fusionne. */
const SAME_PLACE_M = 10;

/** Colonnes jour des marchés découverts, dans l'ordre des bits (bit 0 = dimanche … bit 6 = samedi). */
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const SUNDAY = 1 << 0;
const SATURDAY = 1 << 6;
const WEEKDAYS = 0b0111110;

/** Régime particulier d'un emplacement neutralisé les jours de marché. */
export const isMarketRegime = (regpar) => /march[eé]/i.test(regpar ?? '');

const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** « 07:00 » → « 7h », « 13:30 » → « 13h30 » ; "" si illisible. */
export function hourLabel(hhmm) {
  const m = /^(\d{1,2})[:h](\d{2})/.exec(String(hhmm ?? '').trim());
  if (!m) return '';
  return `${Number(m[1])}h${m[2] === '00' ? '' : m[2]}`;
}

/** « 7h-13h30 », ou "" si une borne manque. */
export function hoursRange(start, end) {
  const a = hourLabel(start);
  const b = hourLabel(end);
  return a && b ? `${a}-${b}` : '';
}

/**
 * Jours de tenue en masque de bits (bit 0 = dimanche). Les indicateurs `lundi` … `dimanche` contredisent
 * parfois `jours_tenue` (Télégraphe : « mercredi, samedi », indicateur jeudi) : on garde l'union, un jour
 * de trop valant mieux qu'un jour de fourrière oublié. « tous les jours sauf … » n'est lu que par les indicateurs.
 */
export function marketDays(p) {
  let days = 0;
  DAYS.forEach((d, i) => {
    if (Number(p[d]) === 1) days |= 1 << i;
  });
  const text = plain(p.jours_tenue);
  if (!/tous|sauf/.test(text)) {
    DAYS.forEach((d, i) => {
      if (text.includes(d)) days |= 1 << i;
    });
  }
  return days;
}

/**
 * Accents perdus par `nom_long` (majuscules sans accents : « MARCHÉ TELEGRAPHE ») sur les 80 marchés
 * de 2024 ; un mot absent de la table reste tel quel.
 */
const ACCENTED = new Map(
  ['Télégraphe', 'Honoré', 'Président', 'Fêtes', 'Dorée', 'Réunion', 'Ménilmontant', 'Crimée', 'Éloi', 'Salpêtrière', 'Alésia', 'Pyrénées', 'Jaurès', 'Barbès'].map(
    (w) => [w.normalize('NFD').replace(/[̀-ͯ]/g, ''), w],
  ),
);
/** Noms propres dont titleCase baisse l'article (« les », « la ») à tort. */
const PROPER_NAMES = [
  [/\bles Halles\b/, 'Les Halles'],
  [/\bGros la Fontaine\b/, 'Gros La Fontaine'],
];

/** « MARCHÉ AUX FLEURS REINE ÉLIZABETH II » → « Marché aux Fleurs Reine Élizabeth II », « MARCHÉ TELEGRAPHE » → « Marché Télégraphe ». */
export function marketName(s) {
  let name = titleCase(s)
    .replace(/\p{L}+/gu, (w) => ACCENTED.get(w) ?? w)
    .replace(/\b(Ii{1,2}|Iv|Vi{1,3})$/, (r) => r.toUpperCase());
  for (const [re, fixed] of PROPER_NAMES) name = name.replace(re, fixed);
  return name;
}

/**
 * Fiche du dictionnaire `markets` ({ name, days, weekday, saturday, sunday }, lue par Parq), ou null
 * sans nom ni jour de tenue. Horaires au format « 7h-13h30 », "" les jours où le marché ne se tient pas.
 */
export function parseMarket(p) {
  const days = marketDays(p);
  const name = marketName(p.nom_long || p.nom_court || '');
  if (!days || !name) return null;
  return {
    name,
    days,
    weekday: days & WEEKDAYS ? hoursRange(p.h_deb_sem_1, p.h_fin_sem_1) : '',
    saturday: days & SATURDAY ? hoursRange(p.h_deb_sam, p.h_fin_sam) : '',
    sunday: days & SUNDAY ? hoursRange(p.h_deb_dim, p.h_fin_dim) : '',
  };
}

/** Plusieurs marchés au même endroit : un seul, avec l'union des jours et les horaires de chacun. */
function mergeMarkets(list) {
  if (list.length === 1) return list[0];
  const join = (key) => [...new Set(list.map((m) => m[key]).filter(Boolean))].join(' / ');
  return {
    name: join('name'),
    days: list.reduce((days, m) => days | m.days, 0),
    weekday: join('weekday'),
    saturday: join('saturday'),
    sunday: join('sunday'),
  };
}

/**
 * Jointure des emplacements « Marché » avec les marchés découverts (GeoJSON Paris Data). `match(pt)`
 * donne l'index du marché dans `values` (le dictionnaire `markets` de voirie.json et reserves.json),
 * 0 si aucun marché n'est à moins de `maxM` mètres ; `values[0]` est null.
 */
export class MarketJoin {
  constructor(features = [], maxM = MARKET_MAX_M) {
    this.maxM = maxM;
    this.markets = [];
    for (const f of features) {
      const market = parseMarket(f.properties ?? {});
      if (!market || !f.geometry) continue;
      const [w, s, e, n] = bboxOf(f.geometry);
      const dx = maxM / M_PER_DEG_LON;
      const dy = maxM / M_PER_DEG_LAT;
      this.markets.push({ market, geometry: f.geometry, bbox: [w - dx, s - dy, e + dx, n + dy] });
    }
    this.values = [null];
    this.ids = new Map();
    this.stats = { rows: 0, matched: 0 };
  }

  match(pt) {
    this.stats.rows++;
    const near = this.markets
      .filter(({ bbox: [w, s, e, n] }) => pt[0] >= w && pt[0] <= e && pt[1] >= s && pt[1] <= n)
      .map((m) => ({ m, d: distanceToGeometryM(pt, m.geometry) }))
      .filter(({ d }) => d <= this.maxM)
      .sort((a, b) => a.d - b.d);
    if (!near.length) return 0;
    const same = near
      .filter(({ d }) => d <= near[0].d + SAME_PLACE_M)
      .map(({ m }) => m.market)
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    const merged = mergeMarkets(same);
    const key = JSON.stringify(merged);
    if (!this.ids.has(key)) {
      this.ids.set(key, this.values.length);
      this.values.push(merged);
    }
    this.stats.matched++;
    return this.ids.get(key);
  }
}
