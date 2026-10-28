// Protocole entre la carte ParkPrix (page web, iframe ou WebView) et son hôte
// (app Expo / React Native, page parente). Pur : aucune API de navigateur, pour
// être partagé par la page (apps/web/src/bridge.ts) et par l'app hôte.

import type { Theme } from './style/basemap';
import { DURATIONS, VEHICLES } from './model';
import type { Vehicle } from './types';

export type LayerKey = 'street' | 'parkings' | 'subscribers' | 'zones' | 'velo' | 'moto' | 'belib' | 'coverage';

/** Fichiers de données que l'hôte peut fournir à une carte embarquée (sans serveur). */
export type EmbeddedDataFile = 'meta.json' | 'zones.geojson' | 'parkings.geojson' | 'belib.geojson' | 'voirie.json';

export const EMBEDDED_DATA_FILES: readonly EmbeddedDataFile[] = ['meta.json', 'zones.geojson', 'parkings.geojson', 'belib.geojson', 'voirie.json'];

/** Événements émis par la carte vers l'hôte (toujours accompagnés de `source: 'parkprix'`). */
export type HostEvent =
  | { type: 'ready'; dataVersion: string }
  | { type: 'settings'; vehicle: Vehicle; minutes: number; start: string | null; theme: Theme }
  | { type: 'select'; kind: 'parking'; id: string; name: string; price: number | null; label: string; lon: number; lat: number }
  | { type: 'select'; kind: 'spot'; index: number; street: string; category: string; zone: number; price: number | null; lon: number; lat: number }
  | { type: 'select'; kind: 'belib'; name: string; lon: number; lat: number }
  | { type: 'deselect' }
  | { type: 'focus'; lon: number; lat: number; label: string }
  | { type: 'moveend'; lon: number; lat: number; zoom: number }
  /** Carte affichée (fond et parkings), avant la voirie : l'hôte peut retirer son voile. */
  | { type: 'loaded' }
  /** Fond de carte injoignable (hors connexion) : les prix restent affichés. */
  | { type: 'tilesError' }
  | { type: 'error'; message: string }
  /** Mode `chunks` : la carte attend ces fichiers, envoyés par morceaux (commande loadData). */
  | { type: 'needData'; files: EmbeddedDataFile[] };

/** Commandes envoyées par l'hôte à la carte. */
export type HostCommand =
  | { type: 'setVehicle'; vehicle: Vehicle }
  | { type: 'setDuration'; minutes: number }
  | { type: 'setStart'; start: string | null }
  | { type: 'setTheme'; theme: Theme }
  | { type: 'flyTo'; lon: number; lat: number; zoom?: number }
  | { type: 'focus'; lon: number; lat: number; label?: string }
  | { type: 'selectParking'; id: string }
  | { type: 'deselect' }
  | { type: 'setLayers'; layers: Partial<Record<LayerKey, boolean>> }
  | { type: 'setChrome'; visible: boolean }
  /** Morceau `index` (à partir de 0) sur `total` du texte d'un fichier de données. */
  | { type: 'loadData'; file: EmbeddedDataFile; index: number; total: number; chunk: string };

/** Réglages d'une carte embarquée, posés par l'hôte dans `window.__PARKPRIX_OPTIONS__`. */
export interface EmbedOptions {
  embedded: true;
  vehicle?: Vehicle;
  minutes?: number;
  theme?: Theme;
  /** Interface ParkPrix (barre, fiches, légende) ; false quand l'hôte fournit ses contrôles. */
  chrome: boolean;
  /** [lon, lat] */
  center?: [number, number];
  zoom?: number;
  focus?: { lon: number; lat: number; label: string };
  /** Parking à sélectionner à l'ouverture. */
  parking?: string;
  /** inline : données dans la page (balises JSON) ; chunks : envoyées ensuite par loadData. */
  dataMode: 'inline' | 'chunks';
}

/** Marqueur unique de la coquille map.html, remplacé par les options et les données. */
export const EMBED_MARKER = '<!--PARKPRIX_BOOT-->';

/** Identifiant de la balise `<script type="application/json">` qui porte un fichier de données. */
export const dataScriptId = (file: EmbeddedDataFile) => `pp-data-${file}`;

const VEHICLE_IDS: readonly Vehicle[] = VEHICLES.map((v) => v.id);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isPrice = (v: unknown): v is number | null => v === null || isNum(v);
const isTheme = (v: unknown): v is Theme => v === 'day' || v === 'night';
const isVehicle = (v: unknown): v is Vehicle => VEHICLE_IDS.includes(v as Vehicle);
const isDataFile = (v: unknown): v is EmbeddedDataFile => EMBEDDED_DATA_FILES.includes(v as EmbeddedDataFile);

/** Objet d'un message : tel quel, ou JSON (react-native-webview ne transmet que du texte). */
function asRecord(raw: unknown): Record<string, unknown> | null {
  let data = raw;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

/** Valide une commande reçue (les messages viennent d'une source externe). */
export function parseCommand(raw: unknown): HostCommand | null {
  const c = asRecord(raw);
  if (!c) return null;
  switch (c.type) {
    case 'setVehicle':
      return isVehicle(c.vehicle) ? { type: 'setVehicle', vehicle: c.vehicle } : null;
    case 'setDuration':
      return DURATIONS.some((d) => d.min === c.minutes) ? { type: 'setDuration', minutes: c.minutes as number } : null;
    case 'setStart':
      return c.start === null || (typeof c.start === 'string' && !Number.isNaN(Date.parse(c.start))) ? { type: 'setStart', start: c.start as string | null } : null;
    case 'setTheme':
      return isTheme(c.theme) ? { type: 'setTheme', theme: c.theme } : null;
    case 'flyTo':
      return isNum(c.lon) && isNum(c.lat) ? { type: 'flyTo', lon: c.lon, lat: c.lat, zoom: isNum(c.zoom) ? c.zoom : undefined } : null;
    case 'focus':
      return isNum(c.lon) && isNum(c.lat) ? { type: 'focus', lon: c.lon, lat: c.lat, label: typeof c.label === 'string' ? c.label.slice(0, 120) : undefined } : null;
    case 'selectParking':
      return typeof c.id === 'string' ? { type: 'selectParking', id: c.id } : null;
    case 'deselect':
      return { type: 'deselect' };
    case 'setLayers': {
      if (!c.layers || typeof c.layers !== 'object') return null;
      const layers: Partial<Record<LayerKey, boolean>> = {};
      for (const [k, v] of Object.entries(c.layers as Record<string, unknown>)) if (typeof v === 'boolean') layers[k as LayerKey] = v;
      return { type: 'setLayers', layers };
    }
    case 'setChrome':
      return typeof c.visible === 'boolean' ? { type: 'setChrome', visible: c.visible } : null;
    case 'loadData':
      return isDataFile(c.file) && isIndex(c.index) && isIndex(c.total) && c.index < c.total && isStr(c.chunk)
        ? { type: 'loadData', file: c.file, index: c.index, total: c.total, chunk: c.chunk }
        : null;
    default:
      return null;
  }
}

/** Valide un événement reçu de la carte : seuls les messages `source: 'parkprix'` bien formés passent. */
export function parseHostEvent(raw: unknown): (HostEvent & { source: 'parkprix' }) | null {
  const e = asRecord(raw);
  if (!e || e.source !== 'parkprix') return null;
  const event = hostEvent(e);
  return event && { ...event, source: 'parkprix' as const };
}

function hostEvent(e: Record<string, unknown>): HostEvent | null {
  switch (e.type) {
    case 'ready':
      return isStr(e.dataVersion) ? { type: 'ready', dataVersion: e.dataVersion } : null;
    case 'settings':
      return isVehicle(e.vehicle) && isNum(e.minutes) && (e.start === null || isStr(e.start)) && isTheme(e.theme)
        ? { type: 'settings', vehicle: e.vehicle, minutes: e.minutes, start: e.start, theme: e.theme }
        : null;
    case 'select':
      if (!isNum(e.lon) || !isNum(e.lat)) return null;
      if (e.kind === 'parking') {
        return isStr(e.id) && isStr(e.name) && isPrice(e.price) && isStr(e.label)
          ? { type: 'select', kind: 'parking', id: e.id, name: e.name, price: e.price, label: e.label, lon: e.lon, lat: e.lat }
          : null;
      }
      if (e.kind === 'spot') {
        return isIndex(e.index) && isStr(e.street) && isStr(e.category) && isNum(e.zone) && isPrice(e.price)
          ? { type: 'select', kind: 'spot', index: e.index, street: e.street, category: e.category, zone: e.zone, price: e.price, lon: e.lon, lat: e.lat }
          : null;
      }
      if (e.kind === 'belib') return isStr(e.name) ? { type: 'select', kind: 'belib', name: e.name, lon: e.lon, lat: e.lat } : null;
      return null;
    case 'deselect':
      return { type: 'deselect' };
    case 'focus':
      return isNum(e.lon) && isNum(e.lat) && isStr(e.label) ? { type: 'focus', lon: e.lon, lat: e.lat, label: e.label } : null;
    case 'moveend':
      return isNum(e.lon) && isNum(e.lat) && isNum(e.zoom) ? { type: 'moveend', lon: e.lon, lat: e.lat, zoom: e.zoom } : null;
    case 'loaded':
      return { type: 'loaded' };
    case 'tilesError':
      return { type: 'tilesError' };
    case 'error':
      return { type: 'error', message: isStr(e.message) ? e.message.slice(0, 500) : 'Erreur inconnue' };
    case 'needData':
      return Array.isArray(e.files) && e.files.every(isDataFile) ? { type: 'needData', files: [...e.files] } : null;
    default:
      return null;
  }
}
