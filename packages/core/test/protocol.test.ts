import { describe, expect, it } from 'vitest';
import { dataScriptId, EMBED_MARKER, EMBEDDED_DATA_FILES, parseCommand, parseHostEvent } from '../src/protocol';

describe('commandes de l’hôte', () => {
  it('valide les commandes connues, en objet ou en JSON', () => {
    expect(parseCommand({ type: 'setVehicle', vehicle: 'moto' })).toEqual({ type: 'setVehicle', vehicle: 'moto' });
    expect(parseCommand('{"type":"setDuration","minutes":120}')).toEqual({ type: 'setDuration', minutes: 120 });
    expect(parseCommand({ type: 'flyTo', lon: 2.35, lat: 48.86 })).toEqual({ type: 'flyTo', lon: 2.35, lat: 48.86, zoom: undefined });
    expect(parseCommand({ type: 'setLayers', layers: { zones: false, velo: 'oui' } })).toEqual({ type: 'setLayers', layers: { zones: false } });
  });
  it('rejette les commandes mal formées', () => {
    expect(parseCommand('pas du JSON')).toBeNull();
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand([])).toBeNull();
    expect(parseCommand({ type: 'setVehicle', vehicle: 'camion' })).toBeNull();
    expect(parseCommand({ type: 'setDuration', minutes: 45 })).toBeNull();
    expect(parseCommand({ type: 'inconnue' })).toBeNull();
  });
  it('accepte les morceaux de données (mode chunks)', () => {
    const cmd = { type: 'loadData', file: 'voirie.json', index: 1, total: 3, chunk: '{"rows":' };
    expect(parseCommand(JSON.stringify(cmd))).toEqual(cmd);
    expect(parseCommand({ ...cmd, file: 'autre.json' })).toBeNull();
    expect(parseCommand({ ...cmd, index: 3 })).toBeNull();
    expect(parseCommand({ ...cmd, index: -1 })).toBeNull();
    expect(parseCommand({ ...cmd, chunk: 12 })).toBeNull();
  });
});

describe('événements de la carte', () => {
  it('ne garde que les messages ParkPrix bien formés', () => {
    expect(parseHostEvent({ source: 'parkprix', type: 'loaded' })).toEqual({ source: 'parkprix', type: 'loaded' });
    expect(parseHostEvent(JSON.stringify({ source: 'parkprix', type: 'ready', dataVersion: 'v1' }))).toEqual({ source: 'parkprix', type: 'ready', dataVersion: 'v1' });
    expect(parseHostEvent({ type: 'loaded' })).toBeNull();
    expect(parseHostEvent({ source: 'autre', type: 'loaded' })).toBeNull();
    expect(parseHostEvent('{')).toBeNull();
    expect(parseHostEvent({ source: 'parkprix', type: 'inconnu' })).toBeNull();
  });
  it('valide les sélections et retire les champs inattendus', () => {
    const spot = { source: 'parkprix', type: 'select', kind: 'spot', index: 12, street: 'Rue de Rivoli', category: 'mixte', zone: 1, price: 12, lon: 2.34, lat: 48.86 };
    expect(parseHostEvent({ ...spot, extra: true })).toEqual(spot);
    expect(parseHostEvent({ ...spot, index: 1.5 })).toBeNull();
    const parking = { source: 'parkprix', type: 'select', kind: 'parking', id: 'paris:1', name: 'P', price: null, label: '?', lon: 2.3, lat: 48.8 };
    expect(parseHostEvent(parking)).toEqual(parking);
    expect(parseHostEvent({ ...parking, lon: 'x' })).toBeNull();
    expect(parseHostEvent({ source: 'parkprix', type: 'select', kind: 'belib', name: 'Borne', lon: 2.3, lat: 48.8 })).toMatchObject({ kind: 'belib' });
  });
  it('valide les nouveaux événements de la carte embarquée', () => {
    expect(parseHostEvent({ source: 'parkprix', type: 'tilesError' })).toEqual({ source: 'parkprix', type: 'tilesError' });
    expect(parseHostEvent({ source: 'parkprix', type: 'error', message: 'WebGL' })).toEqual({ source: 'parkprix', type: 'error', message: 'WebGL' });
    expect(parseHostEvent({ source: 'parkprix', type: 'needData', files: ['voirie.json'] })).toEqual({ source: 'parkprix', type: 'needData', files: ['voirie.json'] });
    expect(parseHostEvent({ source: 'parkprix', type: 'needData', files: ['voirie.json', 'x'] })).toBeNull();
    expect(parseHostEvent({ source: 'parkprix', type: 'settings', vehicle: 'suv', minutes: 60, start: null, theme: 'night' })).toMatchObject({ vehicle: 'suv' });
  });
});

describe('coquille embarquée', () => {
  it('expose le marqueur et les identifiants des balises de données', () => {
    expect(EMBED_MARKER).toBe('<!--PARKPRIX_BOOT-->');
    expect(dataScriptId('voirie.json')).toBe('pp-data-voirie.json');
    expect(EMBEDDED_DATA_FILES).toEqual(['meta.json', 'zones.geojson', 'parkings.geojson', 'belib.geojson', 'voirie.json']);
  });
});
