#!/usr/bin/env node
// Pipeline de données ParkPrix : télécharge les sources ouvertes, les normalise
// et écrit des fichiers compacts dans public/data/ (servis tels quels par le site).
//
//   npm run data              # utilise le cache disque (.cache/sources, 12 h)
//   npm run data -- --refresh # force le re-téléchargement
//   npm run data -- --only=voirie,reserves,markets
//                             # mode partiel : seulement les fichiers tirés des emprises (Paris Data),
//                             # en reprenant zones.geojson et meta.json existants (voir PARTIAL_STEPS)
//   npm run data -- --no-markets
//                             # sans les jours de marché (si « marchés découverts » est indisponible) :
//                             # sinon, l'échec de cette source arrête la génération
//
// Aucune clé d'API n'est nécessaire : toutes les sources sont ouvertes (ODbL / Licence Ouverte).

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchJson, fetchText } from './lib/fetch.mjs';

// Derrière un proxy HTTPS, le fetch natif de Node (≥ 22.21) ne l'utilise que si NODE_USE_ENV_PROXY=1.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } });
  process.exit(child.status ?? 1);
}
import {
  GridIndex,
  M_PER_DEG_LAT,
  M_PER_DEG_LON,
  bboxOf,
  distanceM,
  pointInGeometry,
  ringCenter,
  simplifyLine,
  simplifyPolygonGeometry,
} from './lib/geo.mjs';
import { Dict, streetName, streetNumber, titleCase } from './lib/text.mjs';
import { parseBnlsCsv } from './lib/bnls.mjs';
import { VOIRIE_CATEGORIES, sortEmprises, voirieCategory } from './lib/categories.mjs';
import { MARKETS_DATASET, MARKET_MAX_M, MarketJoin, isMarketRegime } from './lib/markets.mjs';
import { ReservesBuilder, isReserve } from './lib/reserves.mjs';

// API de données statique v1, servie par le site et consommable par une app Expo (voir docs/DATA_API.md).
const SCHEMA_VERSION = 1;
const OUT_DIR = path.resolve('apps/web/public/data/v1');
const ODP = 'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets';
const odpExport = (id, format = 'geojson') => `${ODP}/${id}/exports/${format}`;
const odpPage = (id) => `https://opendata.paris.fr/explore/dataset/${id}/`;

// Mode partiel (--only=…) : fichiers tirés des seules emprises Paris Data, quand une autre source
// (Overpass, Saemes, BNLS…) échoue. zones.geojson et meta.json existants sont repris (tarifs, sources) ;
// parkings, belib, arrondissements et couverture restent inchangés. Les marchés suivent toujours voirie
// et reserves (`markets` est implicite) : seul --no-markets les écarte, explicitement.
const PARTIAL_STEPS = ['voirie', 'reserves', 'markets'];
function parseOnly(argv) {
  const arg = argv.find((a) => a.startsWith('--only='));
  if (!arg) return null;
  const steps = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
  if (!steps.length || steps.some((s) => !PARTIAL_STEPS.includes(s))) {
    throw new Error(`${arg} : étapes possibles ${PARTIAL_STEPS.join(', ')}`);
  }
  return new Set(steps);
}
const NO_MARKETS = process.argv.includes('--no-markets');

// Sur un clone neuf, public/data (hors git) n'existe pas : le mode partiel part alors de la copie commitée
// par Parq (dépôt hôte, assets/parkprix) et la recopie ici, pour que `npm run parkprix:sync` trouve tout.
const SEED_DIR = path.resolve('../assets/parkprix');
const SEED_FILES = { 'meta.json': 'meta.json', 'zones.geojson': 'zones.pkjson', 'parkings.geojson': 'parkings.pkjson', 'belib.geojson': 'belib.pkjson' };

// Emprise de Paris intra-muros (bois inclus) pour les requêtes OSM.
const PARIS_BBOX = [2.224, 48.8155, 2.4698, 48.9022];
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
// Base nationale des lieux de stationnement : CSV consolidé (plus maintenu depuis janvier 2024, sert de complément).
const BNLS_CSV = 'https://www.data.gouv.fr/api/1/datasets/r/e32f7675-913b-4e01-b8c8-0a29733e4407';
const BNLS_PAGE = 'https://transport.data.gouv.fr/datasets/base-nationale-des-lieux-de-stationnement';
const BNLS_DATE = '2024-01-09';
// Open data Saemes (opérateur de ~60 parkings parisiens, tarifs 2026).
const SAEMES_API = 'https://opendata.saemes.fr/api/explore/v2.1/catalog/datasets/referentiel-parkings-saemes/exports/json';
const SAEMES_PAGE = 'https://opendata.saemes.fr/explore/dataset/referentiel-parkings-saemes/';
// Open data Indigo (format APDS, localisation + capacité, sans tarifs).
const INDIGO_DATASET_API = 'https://transport.data.gouv.fr/api/datasets/6720c0bdb7466b5a047e380a';
const INDIGO_PAGE = 'https://transport.data.gouv.fr/datasets/indigo-open-data-parkings';

// Grille tarifaire de repli (Paris, depuis le 1er octobre 2024) si le jeu « zones tarifaires » change de schéma.
const FALLBACK_TARIFFS = {
  1: { vl: [6, 6, 12, 15, 18, 18], suv: [18, 18, 36, 45, 54, 54], moto: [3, 3, 6, 7.5, 9, 9] },
  2: { vl: [4, 4, 8, 10, 12, 12], suv: [12, 12, 24, 30, 36, 36], moto: [2, 2, 4, 5, 6, 6] },
};

const round = (v, d = 2) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

async function writeJson(name, data) {
  const file = path.join(OUT_DIR, name);
  const text = JSON.stringify(data);
  await writeFile(file, text);
  console.log(`  → ${name} (${(text.length / 1024).toFixed(0)} Ko)`);
}

// ---------------------------------------------------------------------------
// 1. Zones tarifaires (polygones + grille progressive officielle)
// ---------------------------------------------------------------------------
async function buildZones() {
  const id = 'stationnement-sur-voie-publique-zones-tarifaires';
  const raw = await fetchJson(odpExport(id), { label: 'Zones tarifaires (Paris Data)' });
  const tariffs = {};
  const features = [];
  for (const f of raw.features) {
    const p = f.properties;
    const zone = Number(p.zone);
    const slots = (prefix, suffix = '') => [1, 2, 3, 4, 5, 6].map((h) => num(p[`${prefix}_h${h}${suffix}`]));
    const grid = {
      vl: slots('vis_vl', '_lv'),
      vlSamedi: slots('vis_vl', '_s'),
      suv: slots('vis_suv'),
      moto: slots('vis_2rm', '_lv'),
      motoSamedi: slots('vis_2rm', '_s'),
    };
    for (const [k, arr] of Object.entries(grid)) {
      if (arr.some((v) => v == null)) {
        const fb = FALLBACK_TARIFFS[zone]?.[k.replace('Samedi', '')];
        console.warn(`  ! grille ${k} zone ${zone} incomplète, repli sur la grille connue`);
        grid[k] = fb;
      }
    }
    tariffs[zone] = grid;
    features.push({
      type: 'Feature',
      properties: { zone },
      geometry: simplifyPolygonGeometry(f.geometry, 3, 5),
    });
  }
  return { geojson: { type: 'FeatureCollection', features }, tariffs, raw, sourceId: id };
}

// ---------------------------------------------------------------------------
// 2. Arrondissements (contour de Paris + calcul de couverture)
// ---------------------------------------------------------------------------
async function buildArrondissements() {
  const id = 'arrondissements';
  const raw = await fetchJson(odpExport(id), { label: 'Arrondissements (Paris Data)' });
  const features = raw.features
    .map((f) => ({
      type: 'Feature',
      properties: { ar: Number(f.properties.c_ar), nom: f.properties.l_aroff, label: f.properties.l_ar },
      geometry: simplifyPolygonGeometry(f.geometry, 4, 5),
    }))
    .sort((a, b) => a.properties.ar - b.properties.ar);
  return { features, sourceId: id };
}

// ---------------------------------------------------------------------------
// 3. Stationnement sur voirie (emprises)
// ---------------------------------------------------------------------------
// Catégorie d'un emplacement : voirieCategory (lib/categories.mjs). Les emplacements réservés
// (lib/reserves.mjs) vont dans reserves.json ; les emplacements « Marché » sont rattachés à un marché
// découvert (lib/markets.mjs). Colonnes 12 `num` et 13 `market` ajoutées après `ring`.
const TYPSTA = { Longitudinal: 1, Epi: 2, Bataille: 3 };
const ORIGIN = [2.2, 48.8];
const SCALE = 1e6;

function encodeRing(ring) {
  let pts = ring;
  if (pts.length > 1 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts = pts.slice(0, -1);
  // Simplification très légère (15 cm) : les emprises courbes ont parfois >100 sommets.
  if (pts.length > 8) pts = simplifyLine([...pts, pts[0]], 0.15).slice(0, -1);
  const out = [];
  let px = 0;
  let py = 0;
  for (const [x, y] of pts) {
    const ix = Math.round((x - ORIGIN[0]) * SCALE);
    const iy = Math.round((y - ORIGIN[1]) * SCALE);
    out.push(ix - px, iy - py);
    px = ix;
    py = iy;
  }
  return out;
}

function formatHours(p) {
  const ranges = [1, 2, 3]
    .map((i) => [p[`plage_hor${i}_debut`], p[`plage_hor${i}_fin`]])
    .filter(([a, b]) => a && b)
    .map(([a, b]) => `${a}–${b}`);
  return [...new Set(ranges)].join(', ');
}

/**
 * Marchés découverts (jours et horaires). Les perdre sans le voir retirerait les jours d'interdiction de
 * Parq : un échec arrête donc la génération, sauf avec --no-markets (aucun emplacement n'a alors de marché).
 */
async function buildMarkets() {
  const id = MARKETS_DATASET;
  if (NO_MARKETS) {
    console.warn('  ! --no-markets : jours de marché ignorés');
    return { join: new MarketJoin([]), records: null, sourceId: id };
  }
  let raw;
  try {
    raw = await fetchJson(odpExport(id), { label: 'Marchés découverts (Paris Data)' });
  } catch (err) {
    throw new Error(`marchés découverts indisponibles (${err.message}) : relancer plus tard, ou ajouter --no-markets pour générer sans jours de marché`);
  }
  const join = new MarketJoin(raw.features);
  if (!join.markets.length) throw new Error(`marchés découverts : aucun marché exploitable sur ${raw.features.length} (schéma modifié ?) ; --no-markets pour passer outre`);
  return { join, records: raw.features.length, sourceId: id };
}

async function buildVoirie(zones, markets) {
  const id = 'stationnement-sur-voie-publique-emprises';
  const raw = await fetchJson(odpExport(id), { label: 'Emprises de stationnement (Paris Data)', timeoutMs: 600_000 });
  const streets = new Dict();
  const zonesRes = new Dict();
  const regimes = new Dict();
  const hours = new Dict();
  const nums = new Dict();
  const reserves = new ReservesBuilder(ORIGIN, SCALE);
  const rows = [];
  const points = []; // pour la couverture : { pt, cat, zone, places }
  const stats = { total: 0, kept: 0, byCategory: {}, placesByCategory: {}, horsZone: 0, motoMixte: 0, motoMixtePlaces: 0 };
  // Ordre stable : l'index d'une ligne identifie l'emplacement dans Parq (voir sortEmprises).
  for (const f of sortEmprises(raw.features)) {
    stats.total++;
    const p = f.properties;
    const cat = voirieCategory(p);
    if (!f.geometry || (!cat && !isReserve(p))) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const center = ringCenter(polys[0][0]);
    const isBois = p.arrond === 21 || p.arrond === 22; // 21 = bois de Vincennes, 22 = bois de Boulogne
    const arr = p.arrond === 21 ? 12 : p.arrond === 22 ? 16 : p.arrond;
    const places = p.plarel ?? p.placal ?? 1;
    const num = streetNumber(p.numvoie, p.compnumvoie);
    const market = isMarketRegime(p.regpar) ? markets.match(center) : 0;
    if (!cat) {
      // Réservé (taxis, police, autocars, véhicules partagés, marché…) : reserves.json, pour Parq.
      reserves.add({ regpri: p.regpri, regpar: p.regpar ?? '', street: streetName(p.typevoie, p.nomvoie), num, places, arr, market, center });
      continue;
    }
    let zone = 0;
    for (const z of zones.geojson.features) if (pointInGeometry(center, z.geometry)) zone = z.properties.zone;
    if (!zone && ['mixte', 'rotatif', 'moto'].includes(cat)) {
      // Emplacements payants hors polygone (lisière des bois, quais...) : tarif de la zone de l'arrondissement.
      // Les horodateurs des bois (tarif « BOIS23 ») appliquent bien 4 €/h, soit la zone 2.
      zone = arr <= 11 ? 1 : 2;
      stats.horsZone++;
    }
    stats.kept++;
    stats.byCategory[cat] = (stats.byCategory[cat] ?? 0) + 1;
    stats.placesByCategory[cat] = (stats.placesByCategory[cat] ?? 0) + places;
    if (p.regpri === '2 ROUES' && p.regpar === 'Mixte') {
      stats.motoMixte++;
      stats.motoMixtePlaces += places;
    }
    const common = [
      VOIRIE_CATEGORIES.indexOf(cat),
      places,
      zone,
      arr,
      streets.id(streetName(p.typevoie, p.nomvoie)),
      p.n_voieadd ?? 0,
      p.n_voieadf ?? 0,
      zonesRes.id(p.zoneres ?? ''),
      TYPSTA[p.typsta] ?? 0,
      regimes.id(isBois && !/bois/i.test(p.regpar ?? '') ? `${p.regpar} (bois)` : p.regpar ?? ''),
      hours.id(formatHours(p)),
    ];
    const numId = nums.id(num);
    for (const poly of polys) rows.push([...common, encodeRing(poly[0]), numId, market]);
    points.push({ pt: center, cat, zone, places, arr });
  }
  const data = {
    version: 1,
    origin: ORIGIN,
    scale: SCALE,
    // num et market après ring : decodeVoirie (site, cœur) ne lit que les 12 premières colonnes.
    columns: ['cat', 'places', 'zone', 'arr', 'street', 'numFrom', 'numTo', 'zoneRes', 'typsta', 'regime', 'hours', 'ring', 'num', 'market'],
    categories: VOIRIE_CATEGORIES,
    typsta: ['', 'Longitudinal', 'Épi', 'Bataille'],
    streets: streets.values,
    zonesRes: zonesRes.values,
    regimes: regimes.values,
    hours: hours.values,
    nums: nums.values,
    markets: markets.values,
    rows,
  };
  stats.reserves = reserves.rows.length;
  console.log(`  ✓ moto « Mixte » (2 ROUES / Mixte) : ${stats.motoMixte} emplacements, ${stats.motoMixtePlaces} places, en catégorie moto`);
  console.log(`  ✓ réservées (autocars, location, autre régime, hors vélos) : ${stats.reserves} emplacements`);
  const { rows: marketRows, matched } = markets.stats;
  const marketLine = `marchés : ${marketRows} emplacements « Marché », ${matched} rattachés à un marché découvert (≤ ${MARKET_MAX_M} m), ${markets.values.length - 1} fiches`;
  if (!markets.markets.length) {
    console.warn(`  ! ${marketLine} (--no-markets : mention générique partout)`);
  } else if (!matched) {
    // Marchés chargés mais aucun rattaché : régimes ou emprises des marchés modifiés, à examiner.
    throw new Error(`${marketLine} : aucun rattachement ; --no-markets pour passer outre`);
  } else {
    console.log(`  ${matched * 2 >= marketRows ? '✓' : '!'} ${marketLine}`);
  }
  return { data, reserves: reserves.toFile(markets.values), points, stats, sourceId: id };
}

// ---------------------------------------------------------------------------
// 4. Parkings en ouvrage : Paris Data (tarifs détaillés) + BNLS + OpenStreetMap
// ---------------------------------------------------------------------------
const PARIS_PRICE_FIELDS = {
  15: 'tf_15mn_e',
  30: 'tf_30mn_e',
  60: 'tarif_1h',
  90: 'tf_1h30_e',
  120: 'tarif_2h',
  180: 'tarif_3h',
  240: 'tarif_4h',
  420: 'tf_7h_e',
  480: 'tf_8h_e',
  540: 'tf_9h_e',
  600: 'tf_10h_e',
  660: 'tf_11h_e',
  720: 'tf_12h_e',
  1440: 'tarif_24h',
};
const PARIS_MOTO_FIELDS = { 15: 'tf_15mn_mo', 30: 'tf_30mn_mo', 60: 'tmoto_1ehe', 1440: 'tf_24h_mot' };

function priceTable(record, fields) {
  const out = {};
  for (const [min, field] of Object.entries(fields)) {
    const v = num(record[field]);
    if (v != null && v >= 0) out[min] = round(v);
  }
  return Object.keys(out).length ? out : null;
}

function prettyAddress(a) {
  if (!a) return '';
  // « 13 ter rue fremicourt, 75015, Paris » → « 13 ter Rue Fremicourt, 75015 Paris »
  const parts = String(a).split(',').map((s) => s.trim()).filter(Boolean);
  const street = titleCase(parts[0] ?? '');
  const cp = parts.find((s) => /^75\d{3}$/.test(s));
  return cp ? `${street}, ${cp} Paris` : street;
}

async function buildParisCarParks() {
  const id = 'stationnement-en-ouvrage';
  const raw = await fetchJson(odpExport(id, 'json'), { label: 'Parkings en ouvrage (Paris Data)' });
  return {
    sourceId: id,
    parks: raw
      .filter((r) => r.geo_point_2d || (r.xlong && r.ylat))
      .map((r) => {
        const lon = r.geo_point_2d?.lon ?? r.xlong;
        const lat = r.geo_point_2d?.lat ?? r.ylat;
        const subscribersOnly = /abonn/i.test(r.type_usagers ?? '') || /ABONN/i.test(r.horaire_na ?? '');
        const hoursLabel = subscribersOnly ? 'Abonnés uniquement' : (r.horaire_na ?? '').replace(/\s*\/\s*/g, ' – ').replace('24h – 24', '24 h/24');
        return {
          id: `paris:${r.id}`,
          name: titleCase(r.nom),
          address: prettyAddress(r.adresse),
          arr: Number(r.arrdt) || null,
          operator: titleCase(r.deleg ?? ''),
          source: 'paris',
          url: r.url || null,
          phone: r.tel || null,
          public: !subscribersOnly,
          hours: hoursLabel || null,
          places: r.nb_places ?? null,
          placesPmr: r.nb_pmr ?? null,
          placesMoto: r.nb_2_rm ?? null,
          placesVelo: r.nb_velo ?? null,
          motoAccess: r.nb_2_rm > 0 || r.pass_2rm === 'OUI' ? true : null,
          veloAccess: r.nb_velo > 0 || num(r.tvelo_1m_e) != null ? true : null,
          covered: true,
          kind: 'underground',
          placesEv: r.nb_voitures_electriques ?? null,
          heightMax: r.hauteur_max ? round(r.hauteur_max / 100, 2) : null,
          relay: r.parc_relai === 'OUI',
          prices: subscribersOnly ? null : priceTable(r, PARIS_PRICE_FIELDS),
          pricesDate: (r.mis_a_jour ?? '').slice(0, 10) || null,
          motoPrices: subscribersOnly ? null : priceTable(r, PARIS_MOTO_FIELDS),
          subscriptions: {
            residentMonth: num(r.abo_resident),
            month: num(r.abo_non_resident ?? r.ab_1m_e),
            year: num(r.ab_1a_e),
            motoMonth: num(r.abmoto_1me),
            evMonth: num(r.abve_1m_e),
            pmrMonth: num(r.abpmr_1m_e),
            veloMonth: num(r.tvelo_1m_e),
            veloDay: num(r.tvelo_1j_e),
          },
          info: (r.info ?? []).filter(Boolean),
          updated: (r.mis_a_jour ?? '').slice(0, 10) || null,
          lon: round(lon, 6),
          lat: round(lat, 6),
        };
      }),
  };
}

// Prix OSM « charge=3.20€/h 31.90€/24h » → { 60: 3.2, 1440: 31.9 }
export function parseOsmCharge(charge) {
  if (!charge) return null;
  const out = {};
  const re = /(\d+(?:[.,]\d+)?)\s*(?:€|eur(?:os?)?)\s*(?:\/|par|per)\s*(24\s*h|1\s*h|h(?:our|eure)?|day|jour|j)\b/gi;
  for (const m of String(charge).matchAll(re)) {
    const v = Number(m[1].replace(',', '.'));
    const unit = m[2].toLowerCase().replace(/\s/g, '');
    const min = unit === '24h' || unit === 'day' || unit === 'jour' || unit === 'j' ? 1440 : 60;
    if (!(min in out)) out[min] = v;
  }
  return Object.keys(out).length ? out : null;
}

async function fetchOverpass(query) {
  let lastErr;
  for (const url of OVERPASS_MIRRORS) {
    try {
      const text = await fetchText(url, {
        label: `OpenStreetMap via ${new URL(url).host}`,
        init: { method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'User-Agent': 'ParkPrix/0.1 (open data map)' } },
        retries: 1,
        timeoutMs: 120_000,
      });
      const json = JSON.parse(text);
      if (!Array.isArray(json.elements)) throw new Error('réponse Overpass invalide');
      return json.elements;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const OSM_EXCLUDED_ACCESS = new Set(['private', 'no', 'permit', 'residents', 'delivery', 'employees', 'staff', 'emergency', 'military']);
async function buildOsmCarParks(parisGeoms) {
  const [w, s, e, n] = PARIS_BBOX;
  const query = `[out:json][timeout:90];nwr["amenity"="parking"](${s},${w},${n},${e});out center tags;`;
  let elements;
  try {
    elements = await fetchOverpass(query);
  } catch (err) {
    console.warn(`  ! OSM indisponible (${err.message}) — étape ignorée`);
    return [];
  }
  const parks = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    const lon = el.lon ?? el.center?.lon;
    const lat = el.lat ?? el.center?.lat;
    if (lon == null || !parisGeoms.some((g) => pointInGeometry([lon, lat], g))) continue;
    const kind = t.parking ?? (t['building'] === 'parking' ? 'multi-storey' : 'surface');
    const access = (t.access ?? 'yes').split(';')[0];
    if (OSM_EXCLUDED_ACCESS.has(access)) continue;
    if (['street_side', 'lane', 'sheds', 'carports', 'garage_boxes', 'disabled'].includes(kind)) continue;
    const named = Boolean(t.name || t.operator || t.brand);
    const covered = ['underground', 'multi-storey', 'rooftop'].includes(kind);
    if (!(covered && (named || t.fee === 'yes')) && !(kind === 'surface' && t.fee === 'yes' && named)) continue;
    const capacity = num(t.capacity);
    parks.push({
      id: `osm:${el.type}/${el.id}`,
      name: t.name ?? (t.operator ? `Parking ${t.operator}` : 'Parking'),
      address: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || null,
      arr: null,
      operator: t.operator ?? t.brand ?? null,
      source: 'osm',
      url: t.website ?? t['contact:website'] ?? null,
      phone: t.phone ?? t['contact:phone'] ?? null,
      public: access !== 'customers',
      customersOnly: access === 'customers',
      hours: t.opening_hours === '24/7' ? '24 h/24' : (t.opening_hours ?? null),
      places: capacity,
      placesPmr: num(t['capacity:disabled']),
      placesMoto: num(t['capacity:motorcycle']),
      placesVelo: num(t['capacity:bicycle']),
      motoAccess: t.motorcycle === 'yes' || num(t['capacity:motorcycle']) > 0 ? true : t.motorcycle === 'no' ? false : null,
      veloAccess: t.bicycle === 'yes' || num(t['capacity:bicycle']) > 0 ? true : null,
      covered,
      kind: ['underground', 'multi-storey', 'rooftop', 'surface'].includes(kind) ? kind : 'surface',
      placesEv: num(t['capacity:charging']),
      heightMax: num(String(t.maxheight ?? '').replace(/\s*m$/, '')),
      relay: t.park_ride === 'yes',
      prices: t.fee === 'no' ? { 60: 0, 1440: 0 } : parseOsmCharge(t.charge),
      pricesDate: null,
      free: t.fee === 'no',
      motoPrices: null,
      subscriptions: null,
      info: [],
      updated: null,
      lon: round(lon, 6),
      lat: round(lat, 6),
    });
  }
  return parks;
}

async function buildBnlsCarParks(parisGeoms) {
  try {
    const csv = await fetchText(BNLS_CSV, { label: 'BNLS (CSV consolidé data.gouv.fr)' });
    const parks = parseBnlsCsv(csv, { pricesDate: BNLS_DATE }).filter((p) => parisGeoms.some((g) => pointInGeometry([p.lon, p.lat], g)));
    for (const p of parks) p.name = titleCase(p.name);
    return parks;
  } catch (err) {
    console.warn(`  ! BNLS indisponible (${err.message}) — étape ignorée`);
    return [];
  }
}

const frDate = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s ?? '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const euros = (v) => num(typeof v === 'string' ? v.replace(/[€\s  ]/g, '') : v);

async function buildSaemesCarParks(parisGeoms) {
  try {
    const raw = await fetchJson(SAEMES_API, { label: 'Référentiel parkings (open data Saemes)' });
    const FORFAITS = {
      forfait_vl_forfait_nuit_19h_9h: 'Nuit 19h–9h',
      forfait_vl_forfait_nuit_20h_5h: 'Nuit 20h–5h',
      forfait_vl_forfait_nuit_21h_7h: 'Nuit 21h–7h',
      forfait_vl_forfait_week_end_vend_14h_a_lund_9h: 'Week-end (ven. 14h → lun. 9h)',
      forfait_vl_forfait_2_jours: '2 jours',
      forfait_vl_forfait_3_jours: '3 jours',
      forfait_vl_forfait_5_jours: '5 jours',
      forfait_vl_forfait_1_semaine: '1 semaine',
      forfait_vl_forfait_2_semaines: '2 semaines',
      forfait_vl_forfait_1_mois: '1 mois',
    };
    return raw
      .filter((r) => r.geo && !/v[ée]lostation/i.test(r.nom_parking ?? '') && parisGeoms.some((g) => pointInGeometry([r.geo.lon, r.geo.lat], g)))
      .map((r) => {
        const isPublic = r.type_de_parc !== 'résidentiel';
        const prices = {};
        for (const [min, k] of [
          [15, 'horaire_vl_15mn_15_min'],
          [60, 'horaire_vl_1h00_1_hr'],
          [180, 'horaire_vl_3h00_3_hr'],
          [1440, 'horaire_vl_24h00_24_hr'],
        ]) {
          const v = euros(r[k]);
          if (v != null) prices[min] = v;
        }
        const moto = {};
        for (const [min, k] of [
          [15, 'horaire_moto_15mn_15_min'],
          [60, 'horaire_moto_1h00_1_hr'],
          [180, 'horaire_moto_3h00_3_hr'],
          [1440, 'horaire_moto_24h00_24_hr'],
        ]) {
          const v = euros(r[k]);
          if (v != null) moto[min] = v;
        }
        const forfaits = Object.entries(FORFAITS)
          .map(([k, label]) => ({ label, price: euros(r[k]) }))
          .filter((f) => f.price != null);
        const hours = isPublic ? r.horaires_d_acces_au_public_pour_les_usagers_non_abonnes : 'Abonnés uniquement';
        return {
          id: `saemes:${r.code_parking}`,
          name: r.nom_parking,
          address: [r.adresse_principale_d_acces_vehicules, r.code_postal ? `${r.code_postal} Paris` : null].filter(Boolean).join(', '),
          arr: /^750(\d\d)$/.test(r.code_postal ?? '') ? Number(r.code_postal.slice(3)) : null,
          operator: 'Saemes',
          source: 'saemes',
          url: r.lien_web_parking || (r.site_web ? `https://${r.site_web.replace(/^https?:\/\//, '')}` : null),
          phone: r.telephone || null,
          public: isPublic,
          hours: hours ? String(hours).replace(/^24h\/24h?,? ?7j\/[78]$/i, '24 h/24').replace(/^24h\/24h$/i, '24 h/24') : null,
          places: num(r.nombre_de_places),
          placesPmr: null,
          placesMoto: null,
          placesVelo: null,
          motoAccess: r.acces_motos === 'oui' ? true : r.acces_motos === 'non' ? false : null,
          veloAccess: r.acces_velos === 'oui' ? true : r.acces_velos === 'non' ? false : null,
          covered: true,
          kind: 'underground',
          placesEv: null,
          ev: r.bornes_de_recharge_vehicule_electrique === 'oui',
          heightMax: num(r.hauteur_maximum),
          relay: r.type_de_parc === 'relais',
          prices: isPublic && Object.keys(prices).length ? prices : null,
          pricesDate: frDate(r.date_d_application_des_tarifs),
          motoPrices: isPublic && Object.keys(moto).length ? moto : null,
          subscriptions: {
            residentMonth: euros(r.abo_vl_abonnement_mensuel_placement_libre_residents_monthly_season_ticket_unallocated_space_resident),
            month: euros(r.abo_vl_abonnement_mensuel_placement_libre_monthly_season_ticket_unallocated_space_standard_libre_men),
            motoMonth: euros(r.abo_moto_abonnement_mensuel_placement_libre_monthly_season_ticket_unallocated_space_standard_libre_m),
            evMonth: euros(r.abo_vlelec_abonnement_mensuel_placement_libre_pour_vehicule_electrique_sans_recharge_monthly_season_),
            veloMonth: euros(r.abo_velo_abonnement_mensuel_placement_libre_monthly_season_ticket_unallocated_space_bike_standard_li),
          },
          forfaits,
          info: [],
          updated: frDate(r.date_d_application_des_tarifs),
          lon: round(r.geo.lon, 6),
          lat: round(r.geo.lat, 6),
        };
      });
  } catch (err) {
    console.warn(`  ! Saemes indisponible (${err.message}) — étape ignorée`);
    return [];
  }
}

async function buildIndigoCarParks(parisGeoms) {
  try {
    const meta = await fetchJson(INDIGO_DATASET_API, { label: 'Indigo (métadonnées transport.data.gouv.fr)' });
    const res = (meta.resources ?? []).find((r) => /json/i.test(r.format ?? '') && /apds/i.test(`${r.title} ${r.url}`));
    if (!res) throw new Error('ressource APDS introuvable');
    const apds = await fetchJson(res.original_url ?? res.url, { label: 'Parkings Indigo (APDS)' });
    const parks = [];
    for (const p of apds.places ?? []) {
      let [a, b] = p.indicativePointLocation?.coordinates ?? [];
      if (a == null) continue;
      // Le flux Indigo publie [lat, lon] au lieu de [lon, lat] : on remet dans l'ordre GeoJSON.
      const [lon, lat] = a > b ? [b, a] : [a, b];
      if (!parisGeoms.some((g) => pointInGeometry([lon, lat], g))) continue;
      const name = p.name?.find((n) => n.language === 'fr')?.string ?? p.name?.[0]?.string ?? 'Parking Indigo';
      parks.push({
        id: `indigo:${p.id}`,
        name,
        address: null,
        arr: null,
        operator: 'Indigo',
        source: 'indigo',
        url: 'https://fr.parkindigo.com/',
        phone: null,
        public: true,
        hours: null,
        places: p.characteristics?.spacesTotal || null,
        placesPmr: null,
        placesMoto: null,
        placesVelo: null,
        motoAccess: null,
        veloAccess: null,
        covered: true,
        kind: 'underground',
        placesEv: null,
        heightMax: null,
        relay: false,
        prices: null,
        pricesDate: null,
        motoPrices: null,
        subscriptions: null,
        info: [],
        updated: null,
        lon: round(lon, 6),
        lat: round(lat, 6),
      });
    }
    return { parks, url: res.original_url ?? res.url };
  } catch (err) {
    console.warn(`  ! Indigo indisponible (${err.message}) — étape ignorée`);
    return { parks: [], url: null };
  }
}

/**
 * Fusionne les sources, de la plus fiable à la moins fiable. Deux fiches à moins
 * de 80 m sont considérées comme le même parking : la fiche existante est
 * enrichie (tarifs plus récents, champs manquants) au lieu d'être dupliquée.
 */
const nameTokens = (s) =>
  new Set(
    String(s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !['parking', 'parc', 'public', 'saint', 'rue', 'place', 'avenue', 'boulevard', 'indigo', 'saemes'].includes(t)),
  );
const sameName = (a, b) => {
  const ta = nameTokens(a);
  return [...nameTokens(b)].some((t) => ta.has(t));
};

function mergeCarParks(lists) {
  const merged = [];
  const index = new GridIndex(150);
  const stats = {};
  for (const [key, list] of lists) {
    stats[key] = { added: 0, merged: 0 };
    for (const p of list) {
      const near = index
        .within([p.lon, p.lat], 80)
        .map((t) => ({ t, d: distanceM([t.lon, t.lat], [p.lon, p.lat]) }))
        .filter(({ t, d }) => d < 25 || sameName(t.name, p.name) || p.source === 'osm' || p.source === 'indigo')
        .sort((a, b) => a.d - b.d);
      const target = near[0]?.t;
      if (!target) {
        p.sources = [p.source];
        merged.push(p);
        index.insert([p.lon, p.lat], p);
        stats[key].added++;
        continue;
      }
      const newer = p.prices && (!target.prices || (p.pricesDate && target.pricesDate && p.pricesDate > target.pricesDate));
      if (newer) {
        // On garde une grille complète : on ne remplace que si la nouvelle source est plus récente.
        target.prices = { ...(target.prices ?? {}), ...p.prices };
        target.pricesDate = p.pricesDate;
        target.pricesSource = p.source;
      }
      target.motoPrices ??= p.motoPrices;
      target.placesMoto ??= p.placesMoto;
      target.placesVelo ??= p.placesVelo;
      target.motoAccess ??= p.motoAccess;
      target.veloAccess ??= p.veloAccess;
      // OpenStreetMap précise la structure réelle (souterrain / en élévation).
      if (p.source === 'osm' && p.kind && p.kind !== 'surface') target.kind = p.kind;
      target.covered ||= p.covered;
      target.forfaits ??= p.forfaits;
      target.url ??= p.url;
      target.phone ??= p.phone;
      target.hours ??= p.hours;
      target.heightMax ??= p.heightMax;
      target.places ??= p.places;
      target.address ||= p.address;
      target.operator ||= p.operator;
      target.ev ||= p.ev;
      target.public ||= p.public && Boolean(p.prices);
      target.sources = [...new Set([...target.sources, p.source])];
      stats[key].merged++;
    }
  }
  for (const p of merged) p.pricesSource ??= p.prices ? p.source : null;
  return { parks: merged, stats };
}

/**
 * Parkings publics sans tarif ouvert : estimation = médiane des parkings tarifés
 * (sources récentes) dans un rayon de 1 km. Affichée comme telle (« ≈ »), jamais
 * comptée dans la couverture.
 */
function addEstimates(parks) {
  const ref = parks.filter((p) => p.public && p.prices?.[60] > 0 && ['paris', 'saemes'].includes(p.pricesSource));
  const index = new GridIndex(500);
  ref.forEach((p) => index.insert([p.lon, p.lat], p));
  const median = (values) => {
    const v = values.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    return v.length % 2 ? v[(v.length - 1) / 2] : round((v[v.length / 2 - 1] + v[v.length / 2]) / 2);
  };
  let n = 0;
  for (const p of parks) {
    if (!p.public || p.prices) continue;
    const near = index.within([p.lon, p.lat], 1000);
    if (near.length < 2) continue;
    p.estimate = { 60: median(near.map((x) => x.prices[60])), 1440: median(near.map((x) => x.prices[1440])), n: near.length, radiusM: 1000 };
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 5. Bornes Belib' (regroupées par station)
// ---------------------------------------------------------------------------
async function buildBelib() {
  const id = 'belib-points-de-recharge-pour-vehicules-electriques-donnees-statiques';
  const raw = await fetchJson(odpExport(id), { label: "Bornes Belib' (Paris Data)" });
  const stations = new Map();
  for (const f of raw.features) {
    const p = f.properties;
    if (!f.geometry) continue;
    const key = p.id_station_local ?? p.id_station_itinerance;
    const s = stations.get(key) ?? {
      type: 'Feature',
      properties: {
        name: (p.nom_station ?? '').replace(/^Paris \| /, ''),
        address: p.adresse_station ?? '',
        pdc: 0,
        kw: 0,
        twoWheels: p.station_deux_roues === 'True',
        hours: p.horaires ?? '',
      },
      geometry: { type: 'Point', coordinates: f.geometry.coordinates.map((c) => round(c, 6)) },
    };
    s.properties.pdc++;
    s.properties.kw = Math.max(s.properties.kw, num(p.puissance_nominale) ?? 0);
    stations.set(key, s);
  }
  return { geojson: { type: 'FeatureCollection', features: [...stations.values()] }, count: raw.features.length, sourceId: id };
}

// ---------------------------------------------------------------------------
// 6. Contrôle croisé : tarif affiché sur les horodateurs vs grille des zones
// ---------------------------------------------------------------------------
async function checkMeters(zones) {
  const id = 'horodateurs-mobiliers';
  try {
    const raw = await fetchJson(odpExport(id, 'json'), { label: 'Horodateurs (Paris Data)' });
    let ok = 0;
    let mismatch = 0;
    for (const m of raw) {
      const pt = [m.geo_point_2d?.lon, m.geo_point_2d?.lat];
      const z = zones.geojson.features.find((f) => pointInGeometry(pt, f.geometry))?.properties.zone;
      if (!z || m.tarifhor_voiture == null) continue;
      if (zones.tariffs[z].vl[0] === m.tarifhor_voiture) ok++;
      else mismatch++;
    }
    console.log(`  ✓ horodateurs cohérents avec la grille : ${ok}, écarts : ${mismatch}`);
    return { ok, mismatch, total: raw.length, sourceId: id };
  } catch (err) {
    console.warn(`  ! contrôle horodateurs ignoré (${err.message})`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 7. Couverture : grille de 200 m sur Paris, une maille est couverte si un prix
//    connu (voirie ou parking) existe à moins de 250 m de son centre.
// ---------------------------------------------------------------------------
const CELL_M = 200;
const WALK_M = 250;
function computeCoverage(arrondissements, voiriePoints, carParks) {
  const priced = new GridIndex(CELL_M);
  const pricedCats = new Set(['mixte', 'rotatif', 'gratuit']);
  for (const p of voiriePoints) if (pricedCats.has(p.cat) && (p.zone || p.cat === 'gratuit')) priced.insert(p.pt, 'voirie');
  for (const c of carParks) if (c.public && c.prices && Object.keys(c.prices).length) priced.insert([c.lon, c.lat], 'parking');

  const geoms = arrondissements.features.map((f) => f.geometry);
  const bbox = geoms.map(bboxOf).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  const dLon = CELL_M / M_PER_DEG_LON;
  const dLat = CELL_M / M_PER_DEG_LAT;
  const perArr = new Map();
  const cells = [];
  let total = 0;
  let covered = 0;
  let strict = 0;
  for (let x = bbox[0]; x < bbox[2]; x += dLon) {
    for (let y = bbox[1]; y < bbox[3]; y += dLat) {
      const c = [x + dLon / 2, y + dLat / 2];
      const ai = geoms.findIndex((g) => pointInGeometry(c, g));
      if (ai < 0) continue;
      const ar = arrondissements.features[ai].properties.ar;
      const near = priced.within(c, WALK_M);
      const inCell = priced.within(c, CELL_M / 2).length > 0;
      const ok = near.length > 0;
      total++;
      if (ok) covered++;
      if (inCell) strict++;
      const s = perArr.get(ar) ?? { cells: 0, covered: 0 };
      s.cells++;
      if (ok) s.covered++;
      perArr.set(ar, s);
      cells.push({
        type: 'Feature',
        properties: { ok: ok ? 1 : 0 },
        geometry: {
          type: 'Polygon',
          coordinates: [[[x, y], [x + dLon, y], [x + dLon, y + dLat], [x, y + dLat], [x, y]].map(([a, b]) => [round(a, 5), round(b, 5)])],
        },
      });
    }
  }
  const byArr = Object.fromEntries([...perArr.entries()].sort((a, b) => a[0] - b[0]).map(([ar, s]) => [ar, round(s.covered / s.cells, 3)]));
  return {
    cellM: CELL_M,
    walkM: WALK_M,
    cells: total,
    covered,
    spatial: round(covered / total, 3),
    spatialStrict: round(strict / total, 3),
    byArrondissement: byArr,
    grid: { type: 'FeatureCollection', features: cells },
  };
}

// ---------------------------------------------------------------------------
const CAR_CATEGORIES = ['mixte', 'rotatif', 'gratuit'];
const voirieSource = (voirie) => ({
  id: voirie.sourceId,
  name: 'Stationnement sur voie publique – emprises',
  provider: 'Ville de Paris',
  url: odpPage(voirie.sourceId),
  license: 'ODbL',
  records: voirie.stats.total,
});
const marketsSource = (markets) => ({
  id: markets.sourceId,
  name: 'Marchés découverts (jours et horaires)',
  provider: 'Ville de Paris',
  url: odpPage(markets.sourceId),
  license: 'ODbL',
  records: markets.records,
});

/**
 * Fichier existant de public/data, ou à défaut sa copie commitée dans assets/parkprix, alors recopiée
 * dans public/data (amorce d'un clone neuf). Renvoie le texte.
 */
async function readExisting(name) {
  const file = path.join(OUT_DIR, name);
  try {
    return await readFile(file, 'utf8');
  } catch {
    /* absent : copie commitée */
  }
  const seed = path.join(SEED_DIR, SEED_FILES[name]);
  let text;
  try {
    text = await readFile(seed, 'utf8');
  } catch {
    throw new Error(`${name} absent de ${OUT_DIR} et de ${seed} : lancer d'abord npm run data sans --only`);
  }
  await writeFile(file, text);
  console.log(`  ${name} repris de la copie commitée ${path.relative(process.cwd(), seed)}`);
  return text;
}

/**
 * Mode partiel : réécrit voirie.json et/ou reserves.json à partir des emprises et des marchés, met à
 * jour meta.json (date, sources, places de voirie) et laisse le reste intact.
 */
async function mainPartial(only, t0) {
  if (!only.has('voirie') && !only.has('reserves')) throw new Error('--only : indiquer voirie et/ou reserves');
  if (only.has('markets') && NO_MARKETS) throw new Error('--only=…markets et --no-markets sont contradictoires');
  const parse = (name, text) => {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`${name} illisible (${err.message}) : lancer d'abord npm run data sans --only`);
    }
  };
  const zonesGeojson = parse('zones.geojson', await readExisting('zones.geojson'));
  const meta = parse('meta.json', await readExisting('meta.json'));
  // Pas relus, mais attendus par npm run parkprix:sync à côté des fichiers régénérés.
  await readExisting('parkings.geojson');
  await readExisting('belib.geojson');
  console.log(`Mode partiel (${[...only].join(', ')}) : zones.geojson et meta.json du ${meta.generatedAt} repris`);

  console.log('Stationnement sur voirie, places réservées et marchés');
  const markets = await buildMarkets();
  const voirie = await buildVoirie({ geojson: zonesGeojson }, markets.join);
  if (only.has('voirie')) await writeJson('voirie.json', voirie.data);
  if (only.has('reserves')) await writeJson('reserves.json', voirie.reserves);

  if (only.has('voirie')) {
    const cov = meta.coverage;
    const places = CAR_CATEGORIES.reduce((s, c) => s + (voirie.stats.placesByCategory[c] ?? 0), 0);
    const delta = places - (cov.voirie?.places ?? places);
    cov.voirie = { ...cov.voirie, places, pricedPlaces: places, byCategory: voirie.stats.placesByCategory, spots: voirie.stats.kept };
    cov.places = { total: cov.places.total + delta, priced: cov.places.priced + delta, share: round((cov.places.priced + delta) / Math.max(1, cov.places.total + delta), 3) };
  }
  // Les index de voirie et de reserves changent : la date suit (identifiants des emplacements dans Parq).
  meta.generatedAt = new Date().toISOString();
  // Attribution des marchés : nouvelle source si chargée ; avec --no-markets, l'ancienne reste tant qu'un
  // fichier non réécrit (voirie ou reserves) peut encore contenir des marchés.
  const previous = meta.sources.find((src) => src.id === MARKETS_DATASET);
  const marketsEntry = markets.records != null ? marketsSource(markets) : only.has('voirie') && only.has('reserves') ? null : previous;
  const sources = meta.sources.filter((src) => src.id !== MARKETS_DATASET).map((src) => (src.id === voirie.sourceId ? voirieSource(voirie) : src));
  const after = sources.findIndex((src) => src.id === voirie.sourceId);
  if (marketsEntry) sources.splice(after < 0 ? sources.length : after + 1, 0, marketsEntry);
  meta.sources = sources;
  await writeJson('meta.json', meta);
  console.log(`Terminé en ${((Date.now() - t0) / 1000).toFixed(0)} s (parkings, belib et couverture inchangés)`);
}

async function main() {
  const t0 = Date.now();
  await mkdir(OUT_DIR, { recursive: true });
  const only = parseOnly(process.argv);
  if (only) return mainPartial(only, t0);

  console.log('1/7 Zones tarifaires');
  const zones = await buildZones();
  await writeJson('zones.geojson', zones.geojson);

  console.log('2/7 Arrondissements');
  const arrs = await buildArrondissements();
  const parisGeoms = arrs.features.map((f) => f.geometry);

  console.log('3/7 Stationnement sur voirie, places réservées et marchés');
  const markets = await buildMarkets();
  const voirie = await buildVoirie(zones, markets.join);
  await writeJson('voirie.json', voirie.data);
  await writeJson('reserves.json', voirie.reserves);

  console.log('4/7 Parkings (Paris Data + Saemes + BNLS + Indigo + OpenStreetMap)');
  const paris = await buildParisCarParks();
  const saemes = await buildSaemesCarParks(parisGeoms);
  const bnls = await buildBnlsCarParks(parisGeoms);
  const indigo = await buildIndigoCarParks(parisGeoms);
  const osm = await buildOsmCarParks(parisGeoms);
  const merged = mergeCarParks([
    ['paris', paris.parks],
    ['saemes', saemes],
    ['bnls', bnls],
    ['indigo', indigo.parks],
    ['osm', osm],
  ]);
  console.log(`  parkings : ${JSON.stringify(merged.stats)}`);
  console.log(`  estimations (parkings sans tarif ouvert) : ${addEstimates(merged.parks)}`);
  await writeJson('parkings.geojson', {
    type: 'FeatureCollection',
    features: merged.parks.map(({ lon, lat, ...props }) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } })),
  });

  console.log("5/7 Bornes Belib'");
  const belib = await buildBelib();
  await writeJson('belib.geojson', belib.geojson);

  console.log('6/7 Contrôles');
  const meters = await checkMeters(zones);

  console.log('7/7 Couverture');
  const coverage = computeCoverage(arrs, voirie.points, merged.parks);
  const covByArr = coverage.byArrondissement;
  await writeJson('arrondissements.geojson', {
    type: 'FeatureCollection',
    features: arrs.features.map((f) => ({ ...f, properties: { ...f.properties, coverage: covByArr[f.properties.ar] ?? 0 } })),
  });
  await writeJson('coverage-grid.geojson', coverage.grid);

  const voiriePlaces = CAR_CATEGORIES.reduce((s, c) => s + (voirie.stats.placesByCategory[c] ?? 0), 0);
  const publicParks = merged.parks.filter((p) => p.public);
  const pricedParks = publicParks.filter((p) => p.prices);
  const placesIn = (list) => list.reduce((s, p) => s + (p.places ?? 0), 0);
  const meta = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    categories: VOIRIE_CATEGORIES,
    tariffs: zones.tariffs,
    coverage: {
      spatial: coverage.spatial,
      spatialStrict: coverage.spatialStrict,
      cellM: coverage.cellM,
      walkM: coverage.walkM,
      cells: coverage.cells,
      coveredCells: coverage.covered,
      byArrondissement: coverage.byArrondissement,
      voirie: { places: voiriePlaces, pricedPlaces: voiriePlaces, share: 1, byCategory: voirie.stats.placesByCategory, spots: voirie.stats.kept },
      parkings: {
        public: publicParks.length,
        priced: pricedParks.length,
        share: round(pricedParks.length / Math.max(1, publicParks.length), 3),
        places: placesIn(publicParks),
        pricedPlaces: placesIn(pricedParks),
        subscribersOnly: merged.parks.length - publicParks.length,
        covered: merged.parks.filter((p) => p.covered).length,
        sources: merged.stats,
      },
      places: {
        total: voiriePlaces + placesIn(publicParks),
        priced: voiriePlaces + placesIn(pricedParks),
        share: round((voiriePlaces + placesIn(pricedParks)) / Math.max(1, voiriePlaces + placesIn(publicParks)), 3),
      },
      meters,
    },
    sources: [
      { id: zones.sourceId, name: 'Stationnement sur voie publique – zones tarifaires', provider: 'Ville de Paris', url: odpPage(zones.sourceId), license: 'ODbL', records: zones.raw.features.length },
      voirieSource(voirie),
      ...(markets.records != null ? [marketsSource(markets)] : []),
      { id: paris.sourceId, name: 'Stationnement en ouvrage', provider: 'Ville de Paris', url: odpPage(paris.sourceId), license: 'ODbL', records: paris.parks.length },
      { id: 'saemes', name: 'Référentiel parkings Saemes', provider: 'Saemes', url: SAEMES_PAGE, license: 'Licence Ouverte / ODbL', records: saemes.length },
      { id: 'bnls', name: 'Base nationale des lieux de stationnement (gelée en 2024)', provider: 'transport.data.gouv.fr', url: BNLS_PAGE, license: 'ODbL', records: bnls.length },
      { id: 'indigo', name: 'Parkings Indigo (APDS)', provider: 'Indigo', url: INDIGO_PAGE, license: 'ODbL', records: indigo.parks.length },
      { id: 'osm', name: 'OpenStreetMap (amenity=parking)', provider: 'Contributeurs OpenStreetMap', url: 'https://www.openstreetmap.org/copyright', license: 'ODbL', records: osm.length },
      { id: belib.sourceId, name: "Belib' – points de recharge", provider: 'Ville de Paris', url: odpPage(belib.sourceId), license: 'ODbL', records: belib.count },
      { id: arrs.sourceId, name: 'Arrondissements', provider: 'Ville de Paris', url: odpPage(arrs.sourceId), license: 'ODbL', records: arrs.features.length },
      { id: 'horodateurs-mobiliers', name: 'Horodateurs (contrôle de cohérence)', provider: 'Ville de Paris', url: odpPage('horodateurs-mobiliers'), license: 'ODbL', records: meters?.total ?? null },
    ],
  };
  await writeJson('meta.json', meta);
  console.log(
    `\nCouverture spatiale : ${(coverage.spatial * 100).toFixed(1)} % des mailles de ${CELL_M} m à moins de ${WALK_M} m d'un prix connu` +
      ` (${(coverage.spatialStrict * 100).toFixed(1)} % avec un prix dans la maille)`,
  );
  console.log(`Voirie : ${voiriePlaces} places voitures tarifées · Parkings : ${pricedParks.length}/${publicParks.length} avec tarifs`);
  console.log(`Terminé en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
