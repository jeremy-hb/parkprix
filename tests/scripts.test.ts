import { describe, expect, it } from 'vitest';
// @ts-expect-error — modules JS du pipeline (sans types)
import { streetName, streetNumber, titleCase } from '../scripts/lib/text.mjs';
// @ts-expect-error — modules JS du pipeline (sans types)
import { parseCsv } from '../scripts/lib/bnls.mjs';
// @ts-expect-error — modules JS du pipeline (sans types)
import { distanceM, distanceToGeometryM, pointInGeometry, simplifyLine } from '../scripts/lib/geo.mjs';
// @ts-expect-error — modules JS du pipeline (sans types)
import { VOIRIE_CATEGORIES, sortEmprises, voirieCategory } from '../scripts/lib/categories.mjs';
// @ts-expect-error — modules JS du pipeline (sans types)
import { RESERVE_COLUMNS, ReservesBuilder, isReserve } from '../scripts/lib/reserves.mjs';
// @ts-expect-error — modules JS du pipeline (sans types)
import { MarketJoin, hoursRange, isMarketRegime, marketDays, marketName, parseMarket } from '../scripts/lib/markets.mjs';
import { VOIRIE_CATEGORIES_V1 } from '../packages/core/src/data';

describe('pipeline : textes', () => {
  it('met en forme les noms de voies', () => {
    expect(streetName('AV DE', 'CHOISY')).toBe('Avenue de Choisy');
    expect(streetName("RUE D'", 'ALESIA')).toBe("Rue d'Alesia");
    expect(streetName('BD', 'SAINT-GERMAIN')).toBe('Boulevard Saint-Germain');
    expect(titleCase('13 ter rue fremicourt')).toBe('13 ter Rue Fremicourt');
  });

  it('écrit le numéro dans la rue (dictionnaire nums)', () => {
    expect(streetNumber(12, null)).toBe('12');
    expect(streetNumber(12, 'BIS')).toBe('12 bis');
    expect(streetNumber(47, '*** BIS')).toBe('47 bis');
    expect(streetNumber(7, 'T')).toBe('7 ter');
    expect(streetNumber(3, 'quater')).toBe('3 quater');
    // Complément en texte libre : ignoré.
    expect(streetNumber(9, '11')).toBe('9');
    expect(streetNumber(138, 'angle de rue de vaugiard')).toBe('138');
    expect(streetNumber(null, 'BIS')).toBe('');
    expect(streetNumber(0, null)).toBe('');
  });
});

describe('pipeline : catégories de voirie', () => {
  it('range les deux-roues « Mixte » avec les motos, les vélos à part', () => {
    expect(voirieCategory({ regpri: '2 ROUES', regpar: 'Mixte' })).toBe('moto');
    expect(voirieCategory({ regpri: '2 ROUES', regpar: 'Motos payant Mixte' })).toBe('moto');
    expect(voirieCategory({ regpri: '2 ROUES', regpar: 'Motos payant Rotatif' })).toBe('moto');
    expect(voirieCategory({ regpri: '2 ROUES', regpar: 'Vélos' })).toBe('velo');
    expect(voirieCategory({ regpri: '2 ROUES', regpar: 'Vélo-cargo' })).toBe('velo');
    expect(voirieCategory({ regpri: '2 ROUES', regpar: 'Box à vélos' })).toBe('velo');
  });

  it('range les emprises dans un ordre stable, quel que soit l’ordre de l’export', () => {
    const emprise = (idOld: string | null, x: number, regpar = 'Mixte') => ({
      type: 'Feature',
      properties: { id_old: idOld, regpri: 'PAYANT MIXTE', regpar },
      geometry: { type: 'Polygon', coordinates: [[[x, 48.85], [x + 0.0001, 48.85], [x + 0.0001, 48.8501], [x, 48.85]]] },
    });
    const features = [
      emprise(null, 2.31),
      emprise('B2', 2.36),
      emprise(null, 2.3, 'Rotatif'),
      emprise('A1', 2.37),
      emprise(null, 2.3, 'Mixte'),
      { type: 'Feature', properties: { id_old: null }, geometry: { type: 'MultiPolygon', coordinates: [emprise(null, 2.305).geometry.coordinates] } },
    ];
    const order = (list: typeof features) => sortEmprises(list).map((f: (typeof features)[number]) => features.indexOf(f));
    // id_old d'abord, puis centre (ouest → est), puis contenu à centre égal.
    expect(order(features)).toEqual([3, 1, 4, 2, 5, 0]);
    expect(order([...features].reverse())).toEqual([3, 1, 4, 2, 5, 0]);
    expect(order([features[2], features[5], features[0], features[4], features[1], features[3]])).toEqual([3, 1, 4, 2, 5, 0]);
  });

  it('garde les autres correspondances et écarte les réservées', () => {
    expect(voirieCategory({ regpri: 'PAYANT MIXTE', regpar: 'Mixte Marché' })).toBe('mixte');
    expect(voirieCategory({ regpri: 'PAYANT ROTATIF', regpar: 'Rotatif' })).toBe('rotatif');
    expect(voirieCategory({ regpri: 'GRATUIT', regpar: 'Gratuit' })).toBe('gratuit');
    expect(voirieCategory({ regpri: 'LIVRAISON', regpar: 'ZL périodique' })).toBe('livraison');
    expect(voirieCategory({ regpri: 'GIG/GIC', regpar: 'GIG/GIC Standard' })).toBe('pmr');
    expect(voirieCategory({ regpri: 'ELECTRIQUE', regpar: "Bélib'" })).toBe('electrique');
    expect(voirieCategory({ regpri: 'AUTRE REGIME', regpar: 'Taxi gaine autorisée' })).toBeNull();
    expect(voirieCategory({ regpri: 'LOCATION', regpar: "Vélib'" })).toBeNull();
  });
});

describe('pipeline : places réservées', () => {
  it('retient autocars, location et autre régime, sauf vélos et Trilib', () => {
    expect(isReserve({ regpri: 'AUTRE REGIME', regpar: 'Taxi gaine autorisée' })).toBe(true);
    expect(isReserve({ regpri: 'AUTRE REGIME', regpar: 'Marché' })).toBe(true);
    expect(isReserve({ regpri: 'AUTOCAR', regpar: 'Autocar (payant)' })).toBe(true);
    expect(isReserve({ regpri: 'LOCATION', regpar: 'Autopartage' })).toBe(true);
    expect(isReserve({ regpri: 'LOCATION', regpar: "Vélib'" })).toBe(false);
    expect(isReserve({ regpri: 'AUTRE REGIME', regpar: "Trilib'" })).toBe(false);
    expect(isReserve({ regpri: 'PAYANT MIXTE', regpar: 'Mixte' })).toBe(false);
    expect(isReserve({ regpri: '2 ROUES', regpar: 'Vélos' })).toBe(false);
  });

  it('écrit reserves.json au format lu par Parq', () => {
    const b = new ReservesBuilder([2.2, 48.8], 1e6);
    b.add({ regpri: 'AUTRE REGIME', regpar: 'SP - Police', street: 'Rue de Rivoli', num: '41', places: 4, arr: 1, market: 0, center: [2.3376, 48.8606] });
    b.add({ regpri: 'AUTRE REGIME', regpar: 'Marché', street: 'Rue de Rivoli', num: '', places: 2, arr: 1, market: 1, center: [2.3377, 48.8607] });
    const file = b.toFile([null, { name: 'Marché X', days: 1, weekday: '', saturday: '', sunday: '7h-14h30' }]);
    expect(file.columns).toEqual(['regpri', 'regpar', 'street', 'num', 'places', 'arr', 'market', 'x', 'y']);
    expect(RESERVE_COLUMNS).toEqual(file.columns);
    expect(file).toMatchObject({ version: 1, origin: [2.2, 48.8], scale: 1e6, regpri: ['', 'AUTRE REGIME'], regpar: ['', 'SP - Police', 'Marché'], streets: ['', 'Rue de Rivoli'], nums: ['', '41'] });
    expect(file.rows).toEqual([
      [1, 1, 1, 1, 4, 1, 0, 137600, 60600],
      [1, 2, 1, 0, 2, 1, 1, 137700, 60700],
    ]);
    expect(file.markets[1].name).toBe('Marché X');
  });
});

describe('pipeline : marchés découverts', () => {
  // Propriétés au format de l'export Paris Data « marches-decouverts ».
  const props = (over: Record<string, unknown>) => ({
    nom_long: 'MARCHÉ TEST',
    jours_tenue: 'mercredi, samedi',
    lundi: 0, mardi: 0, mercredi: 1, jeudi: 0, vendredi: 0, samedi: 1, dimanche: 0,
    h_deb_sem_1: '07:00', h_fin_sem_1: '13:30', h_deb_sam: '07:00', h_fin_sam: '14:30', h_deb_dim: null, h_fin_dim: null,
    ...over,
  });
  // Emprise d'environ 70 × 55 m autour de [2.35, 48.85].
  const square = (x: number, y: number) => ({
    type: 'Polygon',
    coordinates: [[[x, y], [x + 0.001, y], [x + 0.001, y + 0.0005], [x, y + 0.0005], [x, y]]],
  });

  it('lit jours (bit 0 = dimanche) et horaires', () => {
    expect(hoursRange('07:00', '13:30')).toBe('7h-13h30');
    expect(hoursRange('07:00', null)).toBe('');
    expect(parseMarket(props({}))).toEqual({
      name: 'Marché Test',
      days: (1 << 3) | (1 << 6),
      weekday: '7h-13h30',
      saturday: '7h-14h30',
      sunday: '',
    });
    expect(parseMarket(props({ nom_long: 'MARCHÉ AUX FLEURS REINE ÉLIZABETH II' })).name).toBe('Marché aux Fleurs Reine Élizabeth II');
    expect(parseMarket(props({ nom_long: 'MARCHÉ TELEGRAPHE' })).name).toBe('Marché Télégraphe');
    expect(parseMarket(props({ jours_tenue: '', mercredi: 0, samedi: 0 }))).toBeNull();
  });

  it('rend leurs accents aux noms publiés en majuscules sans accents', () => {
    const names = {
      'MARCHÉ REUNION': 'Marché Réunion',
      'MARCHÉ PLACE DES FETES': 'Marché Place des Fêtes',
      'MARCHÉ PORTE DOREE': 'Marché Porte Dorée',
      'MARCHÉ PRESIDENT WILSON': 'Marché Président Wilson',
      'MARCHÉ CRIMEE CURIAL': 'Marché Crimée Curial',
      'MARCHÉ JEAN JAURES': 'Marché Jean Jaurès',
      'MARCHÉ SAINT-HONORE': 'Marché Saint-Honoré',
      'MARCHÉ SAINT-ELOI': 'Marché Saint-Éloi',
      'MARCHÉ SALPETRIERE': 'Marché Salpêtrière',
      'MARCHÉ BARBES': 'Marché Barbès',
      'MARCHÉ ALESIA': 'Marché Alésia',
      'MARCHÉ PYRENEES': 'Marché Pyrénées',
      'MARCHÉ MENILMONTANT': 'Marché Ménilmontant',
      'MARCHÉ LES HALLES': 'Marché Les Halles',
      'MARCHÉ GROS LA FONTAINE': 'Marché Gros La Fontaine',
      // Inchangés : déjà accentués, ou sans accent.
      'MARCHÉ BIOLOGIQUE PLACE DU PÈRE CHAILLET': 'Marché Biologique Place du Père Chaillet',
      "MARCHÉ JEANNE D'ARC": "Marché Jeanne d'Arc",
      'MARCHÉ BIOLOGIQUE DES BATIGNOLLES': 'Marché Biologique des Batignolles',
    };
    for (const [raw, name] of Object.entries(names)) expect(marketName(raw)).toBe(name);
  });

  it('garde l’union des jours publiés quand texte et indicateurs divergent', () => {
    // Télégraphe : « mercredi, samedi » en clair, indicateur jeudi.
    expect(marketDays(props({ mercredi: 0, jeudi: 1 }))).toBe((1 << 3) | (1 << 4) | (1 << 6));
    // « tous les jours sauf le lundi » : seuls les indicateurs comptent.
    const allButMonday = { jours_tenue: 'tous les jours sauf le lundi', lundi: 0, mardi: 1, mercredi: 1, jeudi: 1, vendredi: 1, samedi: 1, dimanche: 1 };
    expect(marketDays(props(allButMonday))).toBe(0b1111101);
  });

  it('rattache un emplacement « Marché » au marché le plus proche, à 30 m au plus', () => {
    expect(isMarketRegime('Mixte Marché')).toBe(true);
    expect(isMarketRegime('Marché')).toBe(true);
    expect(isMarketRegime('Mixte')).toBe(false);
    const join = new MarketJoin([
      { type: 'Feature', properties: props({ nom_long: 'MARCHÉ NORD' }), geometry: square(2.35, 48.85) },
      { type: 'Feature', properties: props({ nom_long: 'MARCHÉ SUD', jours_tenue: 'dimanche', mercredi: 0, samedi: 0, dimanche: 1, h_deb_dim: '08:00', h_fin_dim: '14:00' }), geometry: square(2.35, 48.84) },
    ]);
    expect(join.values).toEqual([null]);
    // Dans l'emprise, puis à ≈ 20 m au nord : Marché Nord ; à ≈ 50 m : aucun.
    expect(join.match([2.3505, 48.8502])).toBe(1);
    expect(join.match([2.3505, 48.8507])).toBe(1);
    expect(join.match([2.3505, 48.851])).toBe(0);
    expect(join.match([2.3505, 48.8402])).toBe(2);
    expect(join.values.map((m: { name: string } | null) => m?.name ?? null)).toEqual([null, 'Marché Nord', 'Marché Sud']);
    expect(join.stats).toEqual({ rows: 4, matched: 3 });
  });

  it('fusionne deux marchés au même endroit (jours différents)', () => {
    const join = new MarketJoin([
      { type: 'Feature', properties: props({ nom_long: 'MARCHÉ EDGAR QUINET' }), geometry: square(2.35, 48.85) },
      { type: 'Feature', properties: props({ nom_long: 'MARCHÉ DE LA CRÉATION EDGAR QUINET', jours_tenue: 'dimanche', mercredi: 0, samedi: 0, dimanche: 1, h_deb_dim: '10:00', h_fin_dim: '19:00' }), geometry: square(2.35, 48.85) },
    ]);
    expect(join.match([2.3505, 48.8502])).toBe(1);
    expect(join.match([2.3502, 48.8501])).toBe(1);
    expect(join.values[1]).toEqual({
      name: 'Marché de la Création Edgar Quinet / Marché Edgar Quinet',
      days: (1 << 0) | (1 << 3) | (1 << 6),
      weekday: '7h-13h30',
      saturday: '7h-14h30',
      sunday: '10h-19h',
    });
  });

  it('se passe des marchés si la source manque', () => {
    const join = new MarketJoin([]);
    expect(join.match([2.35, 48.85])).toBe(0);
    expect(join.values).toEqual([null]);
  });
});

describe('pipeline : CSV', () => {
  it('gère séparateur « ; » et guillemets', () => {
    const rows = parseCsv('id;nom;info\n1;"Parking ""Centre""";"a;b"\n2;Autre;\n');
    expect(rows).toEqual([
      { id: '1', nom: 'Parking "Centre"', info: 'a;b' },
      { id: '2', nom: 'Autre', info: '' },
    ]);
  });
});

describe('pipeline : géométrie', () => {
  const square = { type: 'Polygon', coordinates: [[[2.3, 48.85], [2.31, 48.85], [2.31, 48.86], [2.3, 48.86], [2.3, 48.85]]] };
  it('teste l’appartenance à un polygone', () => {
    expect(pointInGeometry([2.305, 48.855], square)).toBe(true);
    expect(pointInGeometry([2.32, 48.855], square)).toBe(false);
  });
  it('mesure des distances en mètres', () => {
    expect(distanceM([2.3, 48.85], [2.3, 48.86])).toBeGreaterThan(1100);
    expect(distanceM([2.3, 48.85], [2.3, 48.86])).toBeLessThan(1120);
  });
  it('simplifie une ligne presque droite', () => {
    expect(simplifyLine([[2.3, 48.85], [2.30001, 48.850001], [2.30015, 48.850001], [2.3002, 48.85]], 1)).toHaveLength(2);
  });
});

describe('contrat de données v1', () => {
  it('le pipeline et le cœur partagent le même ordre de catégories', () => {
    expect(VOIRIE_CATEGORIES).toEqual(VOIRIE_CATEGORIES_V1);
  });
});
