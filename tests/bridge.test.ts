// Pont de la page carte avec son hôte (apps/web/src/bridge.ts) : réglages lus dans l'URL ou dans
// `window.__PARKPRIX_OPTIONS__` (mode embarqué), données embarquées (balises ou morceaux loadData),
// messages. Le DOM est remplacé par de petits faux objets (vitest tourne sous Node).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDED_DATA_FILES, createDataClient, dataScriptId, type EmbeddedDataFile, type HostCommand } from '@parkprix/core';
import { embeddedData, onHostCommand, postToHost, readUrlOptions } from '../apps/web/src/bridge';

afterEach(() => {
  vi.unstubAllGlobals();
});

type LoadData = Extract<HostCommand, { type: 'loadData' }>;

/** Balises `<script>` de la page (id → texte) ; `remove()` retire la balise. */
function fakeDocument(tags: Record<string, string> = {}) {
  const els = new Map(Object.entries(tags));
  vi.stubGlobal('document', {
    getElementById: (id: string) => (els.has(id) ? { textContent: els.get(id)!, remove: () => els.delete(id) } : null),
  });
  return els;
}

const tagsFor = (files: Partial<Record<EmbeddedDataFile, string>>) =>
  Object.fromEntries(Object.entries(files).map(([f, text]) => [dataScriptId(f as EmbeddedDataFile), text]));

const urlOf = (file: string) => `./data/v1/${file}`;
const piece = (file: EmbeddedDataFile, index: number, total: number, chunk: string): LoadData => ({ type: 'loadData', file, index, total, chunk });
/** Découpe un texte en morceaux loadData, comme chunkText côté hôte. */
const split = (file: EmbeddedDataFile, text: string, size: number): LoadData[] => {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.map((chunk, index) => piece(file, index, parts.length, chunk));
};
/** true si la promesse est réglée après un tour de boucle. */
const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((r) => setTimeout(r, 0));
  return done;
};

describe('pont : réglages de la page (readUrlOptions)', () => {
  const none = { center: null, zoom: null, focus: null, dataMode: 'inline' };

  it("site : paramètres d'URL", () => {
    expect(readUrlOptions('?vehicle=moto&duration=60&theme=night&chrome=0&parking=paris:1', null)).toEqual({
      embedded: false,
      vehicle: 'moto',
      minutes: 60,
      theme: 'night',
      chrome: false,
      parking: 'paris:1',
      ...none,
    });
    expect(readUrlOptions('', null)).toEqual({ embedded: false, vehicle: null, minutes: null, theme: null, chrome: true, parking: null, ...none });
    expect(readUrlOptions('?embed=map', null).chrome).toBe(false);
    expect(readUrlOptions('?vehicle=avion&duration=45&theme=sepia', null)).toMatchObject({ vehicle: null, minutes: null, theme: null });
  });

  it("mode embarqué : les options de l'hôte passent devant l'URL", () => {
    const embed = {
      embedded: true,
      vehicle: 'suv',
      minutes: 180,
      theme: 'day',
      chrome: false,
      center: [2.35, 48.85],
      zoom: 16,
      focus: { lon: 2.3499, lat: 48.853, label: 'Vous êtes ici' },
      parking: 'paris:75101-P-006',
      dataMode: 'chunks',
    };
    expect(readUrlOptions('?vehicle=moto&duration=60&theme=night&parking=autre', embed)).toEqual({ ...embed, embedded: true });
  });

  it("mode embarqué : options invalides ignorées (repli sur l'URL ou valeur par défaut)", () => {
    const embed = {
      embedded: true,
      vehicle: 'avion',
      minutes: 45,
      theme: 'sepia',
      chrome: 'oui',
      center: [200, 48.85],
      zoom: '16',
      focus: { lon: 2.35 },
      parking: 42,
      dataMode: 'autre',
    };
    expect(readUrlOptions('?vehicle=velo&duration=30', embed)).toEqual({
      embedded: true,
      vehicle: 'velo',
      minutes: 30,
      theme: null,
      chrome: false, // embarquée : interface ParkPrix seulement si chrome === true
      parking: null,
      ...none,
    });
    const o = (extra: object) => readUrlOptions('', { embedded: true, ...extra });
    expect(o({ center: ['2.35', 48.85] }).center).toBeNull();
    expect(o({ center: [2.35] }).center).toBeNull();
    expect(o({ center: { lon: 2.35, lat: 48.85 } }).center).toBeNull();
    expect(o({ zoom: Number.NaN }).zoom).toBeNull();
    expect(o({ zoom: Number.POSITIVE_INFINITY }).zoom).toBeNull();
    expect(o({ focus: { lon: 2.35, lat: 95, label: 'x' } }).focus).toBeNull();
    expect(o({ chrome: true }).chrome).toBe(true);
  });

  it('mode embarqué : libellé du repère par défaut et tronqué', () => {
    const focus = (label: unknown) => readUrlOptions('', { embedded: true, focus: { lon: 2.35, lat: 48.85, label } }).focus;
    expect(focus(undefined)).toEqual({ lon: 2.35, lat: 48.85, label: 'Destination' });
    expect(focus('x'.repeat(300))?.label).toHaveLength(120);
  });

  it('options qui ne sont pas un objet, ou embedded différent de true : comportement du site', () => {
    for (const embed of ['{"embedded":true}', 42, null, [true]]) {
      expect(readUrlOptions('?chrome=0', embed)).toMatchObject({ embedded: false, chrome: false, dataMode: 'inline' });
    }
    expect(readUrlOptions('', { embedded: 'true' })).toMatchObject({ embedded: false, chrome: true });
  });
});

describe('pont : données embarquées (embeddedData)', () => {
  it('inline : balise lue une fois puis retirée du document', async () => {
    const els = fakeDocument(tagsFor({ 'meta.json': '{"a":1}' }));
    const data = embeddedData('inline');
    const res = await data.fetch(urlOf('meta.json'));
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ a: 1 });
    expect(els.size).toBe(0);
    expect((await data.fetch(urlOf('meta.json'))).status).toBe(404);
  });

  it('inline : fichier sans balise ou non embarqué → 404, sans attendre', async () => {
    fakeDocument();
    const data = embeddedData('inline');
    expect((await data.fetch(urlOf('voirie.json'))).status).toBe(404);
    expect((await data.fetch(urlOf('coverage-grid.geojson'))).status).toBe(404);
    await expect(createDataClient('./', data.fetch).loadVoirie()).rejects.toThrow('voirie.json : HTTP 404');
  });

  it("chunks : missing() liste les fichiers sans balise, dans l'ordre (voirie en dernier)", () => {
    fakeDocument(tagsFor({ 'meta.json': '{}', 'zones.geojson': '{}' }));
    expect(embeddedData('chunks').missing()).toEqual(['parkings.geojson', 'belib.geojson', 'voirie.json']);
    fakeDocument();
    expect(embeddedData('chunks').missing()).toEqual([...EMBEDDED_DATA_FILES]);
  });

  it('chunks : morceaux dans le désordre et en double, attendus puis assemblés', async () => {
    fakeDocument();
    const data = embeddedData('chunks');
    const pending = data.fetch(urlOf('voirie.json'));
    const [a, b, c] = split('voirie.json', '{"rows":[1,2,3],"x":"é"}', 9);
    data.receive(c);
    data.receive(a);
    data.receive(c);
    expect(await settled(pending)).toBe(false);
    data.receive(b);
    const res = await pending;
    expect(await res.json()).toEqual({ rows: [1, 2, 3], x: 'é' });
  });

  it('chunks : morceaux reçus avant la demande de la page', async () => {
    fakeDocument();
    const data = embeddedData('chunks');
    split('belib.geojson', '{"type":"FeatureCollection","features":[]}', 10).forEach((p) => data.receive(p));
    expect(await (await data.fetch(urlOf('belib.geojson'))).json()).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('chunks : un nouvel envoi avec un autre total repart de zéro', async () => {
    fakeDocument();
    const data = embeddedData('chunks');
    const pending = data.fetch(urlOf('meta.json'));
    data.receive(piece('meta.json', 0, 3, 'ancien'));
    data.receive(piece('meta.json', 2, 3, 'envoi'));
    data.receive(piece('meta.json', 1, 2, '2}'));
    expect(await settled(pending)).toBe(false);
    data.receive(piece('meta.json', 0, 2, '{"v":'));
    expect(await (await pending).json()).toEqual({ v: 2 });
  });

  it('chunks : fichier lu une seule fois, morceaux tardifs ignorés', async () => {
    fakeDocument();
    const data = embeddedData('chunks');
    data.receive(piece('zones.geojson', 0, 1, '{"z":1}'));
    expect(await (await data.fetch(urlOf('zones.geojson'))).json()).toEqual({ z: 1 });
    data.receive(piece('zones.geojson', 0, 1, '{"z":2}')); // renvoi de l'hôte
    const again = data.fetch(urlOf('zones.geojson'));
    expect(await settled(again)).toBe(true);
    expect((await again).status).toBe(404);
  });

  it('chunks : balise présente lue en ligne (mode mixte), fichier non embarqué → 404', async () => {
    fakeDocument(tagsFor({ 'meta.json': '{"m":1}' }));
    const data = embeddedData('chunks');
    expect(await (await data.fetch(urlOf('meta.json'))).json()).toEqual({ m: 1 });
    const other = data.fetch(urlOf('arrondissements.geojson'));
    expect(await settled(other)).toBe(true);
    expect((await other).status).toBe(404);
  });

  it('chunks : createDataClient charge le cœur envoyé par morceaux', async () => {
    fakeDocument(tagsFor({ 'meta.json': '{"generatedAt":"2026-09-30"}' }));
    const data = embeddedData('chunks');
    // Comme main.ts : needData avant loadCore (la lecture retire aussitôt les balises).
    const needed = data.missing();
    expect(needed).toEqual(['zones.geojson', 'parkings.geojson', 'belib.geojson', 'voirie.json']);
    const core = createDataClient('./', data.fetch).loadCore();
    const empty = '{"type":"FeatureCollection","features":[]}';
    const parkings = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { id: 'p1', name: 'Lagrange Maubert' }, geometry: { type: 'Point', coordinates: [2.35, 48.85] } }],
    });
    const texts: Partial<Record<EmbeddedDataFile, string>> = { 'zones.geojson': empty, 'parkings.geojson': parkings, 'belib.geojson': empty };
    expect(await settled(core)).toBe(false);
    for (const file of needed.filter((f) => f !== 'voirie.json')) split(file, texts[file]!, 16).reverse().forEach((p) => data.receive(p));
    const { meta, parkings: list } = await core;
    expect(meta).toEqual({ generatedAt: '2026-09-30' });
    expect(list).toEqual([{ id: 'p1', name: 'Lagrange Maubert', lon: 2.35, lat: 48.85 }]);
  });
});

describe('pont : messages', () => {
  it('postToHost : texte JSON vers react-native-webview, sinon objet vers la page parente', () => {
    const rn = vi.fn();
    vi.stubGlobal('window', { ReactNativeWebView: { postMessage: rn } });
    postToHost({ type: 'loaded' });
    expect(rn).toHaveBeenCalledWith('{"source":"parkprix","type":"loaded"}');

    const parent = { postMessage: vi.fn() };
    vi.stubGlobal('window', { parent });
    postToHost({ type: 'needData', files: ['voirie.json'] });
    expect(parent.postMessage).toHaveBeenCalledWith({ source: 'parkprix', type: 'needData', files: ['voirie.json'] }, '*');
  });

  it('onHostCommand : commandes validées, reçues sur window et sur document (Android)', () => {
    const listeners: ((e: { data: unknown }) => void)[] = [];
    const target = { addEventListener: (_type: string, l: (e: { data: unknown }) => void) => listeners.push(l) };
    vi.stubGlobal('window', target);
    vi.stubGlobal('document', target);
    const handler = vi.fn();
    onHostCommand(handler);
    expect(listeners).toHaveLength(2);
    listeners[0]({ data: '{"type":"setDuration","minutes":60}' });
    listeners[1]({ data: { type: 'loadData', file: 'voirie.json', index: 0, total: 1, chunk: '{}' } });
    listeners[0]({ data: { type: 'setDuration', minutes: 61 } });
    listeners[0]({ data: 'pas du JSON' });
    expect(handler.mock.calls).toEqual([
      [{ type: 'setDuration', minutes: 60 }],
      [{ type: 'loadData', file: 'voirie.json', index: 0, total: 1, chunk: '{}' }],
    ]);
  });
});
