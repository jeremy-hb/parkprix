// Pont avec une application hôte : app Expo / React Native (react-native-webview)
// ou page web parente (iframe). La carte envoie des événements et accepte des
// commandes JSON — voir docs/EXPO.md. Le protocole lui-même (types, validation)
// est dans @parkprix/core (protocol.ts), partagé avec l'hôte.

import {
  DURATIONS,
  EMBEDDED_DATA_FILES,
  VEHICLES,
  dataScriptId,
  parseCommand,
  type EmbeddedDataFile,
  type HostCommand,
  type HostEvent,
  type Theme,
  type Vehicle,
} from '@parkprix/core';

// Déplacés dans le cœur : réexportés pour les imports existants de la page.
export { parseCommand };
export type { HostCommand, HostEvent, LayerKey } from '@parkprix/core';

interface RNWebView {
  postMessage(message: string): void;
}

const VEHICLE_IDS: Vehicle[] = VEHICLES.map((v) => v.id);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVehicle = (v: unknown): v is Vehicle => VEHICLE_IDS.includes(v as Vehicle);
const isMinutes = (v: unknown): v is number => DURATIONS.some((d) => d.min === v);
const isTheme = (v: unknown): v is Theme => v === 'day' || v === 'night';
const isLonLat = (lon: unknown, lat: unknown) => isNum(lon) && isNum(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;

export function postToHost(event: HostEvent) {
  const message = { source: 'parkprix', ...event };
  const rn = (window as unknown as { ReactNativeWebView?: RNWebView }).ReactNativeWebView;
  if (rn?.postMessage) rn.postMessage(JSON.stringify(message));
  else if (window.parent !== window) window.parent.postMessage(message, '*');
}

export function onHostCommand(handler: (command: HostCommand) => void) {
  const listener = (e: Event) => {
    const command = parseCommand((e as MessageEvent).data);
    if (command) handler(command);
  };
  window.addEventListener('message', listener);
  // Android (react-native-webview) émet les messages sur document.
  document.addEventListener('message', listener);
}

export interface PageOptions {
  /** Carte embarquée dans une app hôte (`window.__PARKPRIX_OPTIONS__.embedded`), sans serveur. */
  embedded: boolean;
  vehicle: Vehicle | null;
  minutes: number | null;
  theme: Theme | null;
  chrome: boolean;
  parking: string | null;
  /** [lon, lat] */
  center: [number, number] | null;
  zoom: number | null;
  focus: { lon: number; lat: number; label: string } | null;
  dataMode: 'inline' | 'chunks';
}

const hostOptions = () => (window as unknown as { __PARKPRIX_OPTIONS__?: unknown }).__PARKPRIX_OPTIONS__;

/**
 * Réglages initiaux passés dans l'URL : ?vehicle=moto&duration=60&theme=night&chrome=0.
 * En mode embarqué, `window.__PARKPRIX_OPTIONS__` (EmbedOptions, posé par l'hôte avant le script de la
 * page) passe devant : une page `srcdoc` ou `source={{ html }}` n'a pas d'URL à lire. Options validées,
 * puisqu'elles viennent de l'extérieur.
 */
export function readUrlOptions(search = location.search, embed: unknown = hostOptions()): PageOptions {
  const q = new URLSearchParams(search);
  const o = (embed && typeof embed === 'object' ? embed : {}) as Record<string, unknown>;
  const embedded = o.embedded === true;
  const vehicle = isVehicle(o.vehicle) ? o.vehicle : q.get('vehicle');
  const minutes = isMinutes(o.minutes) ? o.minutes : Number(q.get('duration'));
  const theme = isTheme(o.theme) ? o.theme : q.get('theme');
  const c = Array.isArray(o.center) ? o.center : [];
  const f = (o.focus && typeof o.focus === 'object' ? o.focus : {}) as Record<string, unknown>;
  return {
    embedded,
    vehicle: isVehicle(vehicle) ? vehicle : null,
    minutes: isMinutes(minutes) ? minutes : null,
    theme: isTheme(theme) ? theme : null,
    // Embarquée, la carte n'affiche son interface que si l'hôte la demande (chrome: true).
    chrome: embedded ? o.chrome === true : q.get('chrome') !== '0' && q.get('embed') !== 'map',
    parking: typeof o.parking === 'string' ? o.parking : q.get('parking'),
    center: isLonLat(c[0], c[1]) ? [c[0] as number, c[1] as number] : null,
    zoom: isNum(o.zoom) ? o.zoom : null,
    focus: isLonLat(f.lon, f.lat) ? { lon: f.lon as number, lat: f.lat as number, label: typeof f.label === 'string' ? f.label.slice(0, 120) : 'Destination' } : null,
    dataMode: o.dataMode === 'chunks' ? 'chunks' : 'inline',
  };
}

/** Même forme que le `fetchImpl` de createDataClient. */
type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface Incoming {
  /** Texte complet, résolu quand tous les morceaux sont là. */
  text: Promise<string>;
  resolve: ((text: string) => void) | null;
  /** Morceaux reçus pour le `total` en cours. */
  parts: string[];
  received: number;
}

/**
 * Données d'une carte embarquée, servies à createDataClient à la place de fetch :
 * - balise `<script type="application/json" id="pp-data-<fichier>">` posée par l'hôte, lue une fois puis
 *   retirée du document (voirie : 4 Mo de texte à libérer) ;
 * - sinon, en mode `chunks`, texte reçu par morceaux (commandes loadData), attendu puis assemblé.
 * Un autre fichier (couverture, arrondissements), ou un fichier déjà lu, répond 404 comme un fichier absent.
 */
export function embeddedData(dataMode: 'inline' | 'chunks') {
  // Fichiers en cours de réception. Une entrée est retirée dès que la page a lu son texte : rien ne
  // retient ensuite les 4 Mo de la voirie (ni l'entrée, ni sa promesse, ni sa fonction resolve).
  const incoming = new Map<EmbeddedDataFile, Incoming>();
  /** Fichiers reçus en entier : un loadData tardif (renvoi de l'hôte) est ignoré. */
  const complete = new Set<EmbeddedDataFile>();
  const slot = (file: EmbeddedDataFile) => {
    let s = incoming.get(file);
    if (!s) {
      let resolve!: (text: string) => void;
      const text = new Promise<string>((r) => (resolve = r));
      s = { text, resolve, parts: [], received: 0 };
      incoming.set(file, s);
    }
    return s;
  };
  const isFile = (name: string): name is EmbeddedDataFile => EMBEDDED_DATA_FILES.includes(name as EmbeddedDataFile);
  const tag = (file: EmbeddedDataFile) => document.getElementById(dataScriptId(file));
  const ok = (text: string) => ({ ok: true, status: 200, json: async (): Promise<unknown> => JSON.parse(text) });
  const notFound = { ok: false, status: 404, json: async () => null };

  const fetchImpl: FetchLike = async (url) => {
    const file = url.slice(url.lastIndexOf('/') + 1);
    if (!isFile(file)) return notFound;
    const el = tag(file);
    if (el) {
      const text = el.textContent ?? '';
      el.remove();
      return ok(text);
    }
    if (dataMode !== 'chunks' || (complete.has(file) && !incoming.has(file))) return notFound;
    const text = await slot(file).text;
    incoming.delete(file);
    return ok(text);
  };

  return {
    fetch: fetchImpl,
    /** Fichiers à demander à l'hôte (mode chunks) : ceux qui n'ont pas de balise dans la page. */
    missing: (): EmbeddedDataFile[] => EMBEDDED_DATA_FILES.filter((f) => !tag(f)),
    /** Range un morceau reçu ; un nouvel envoi du même fichier avec un autre `total` repart de zéro. */
    receive(cmd: Extract<HostCommand, { type: 'loadData' }>) {
      if (complete.has(cmd.file)) return;
      const s = slot(cmd.file);
      if (s.parts.length !== cmd.total) {
        s.parts = new Array<string>(cmd.total);
        s.received = 0;
      }
      if (s.parts[cmd.index] === undefined) s.received++;
      s.parts[cmd.index] = cmd.chunk;
      if (s.received < cmd.total) return;
      const text = s.parts.join('');
      const resolve = s.resolve!;
      s.parts = [];
      s.resolve = null;
      complete.add(cmd.file);
      resolve(text);
    },
  };
}
