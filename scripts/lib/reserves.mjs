// Emplacements réservés à d'autres usages (taxis, police, transport de fonds, autocars, véhicules
// partagés, marché…) : absents de voirie.json (le site ne les affiche pas), publiés pour Parq dans
// reserves.json, qui les présente comme interdits au public avec leur usage.

import { Dict } from './text.mjs';

/** Régimes prioritaires des emplacements réservés. */
export const RESERVE_REGPRI = new Set(['AUTOCAR', 'LOCATION', 'AUTRE REGIME']);
/** Vélos, Vélib' et bacs Trilib' : sans intérêt pour un véhicule motorisé (Parq les ignore). */
export const RESERVE_IGNORED = new Set(["Vélib'", "Trilib'", 'Vélos', 'Vélo-cargo', 'Box à vélos']);

/** Vrai pour un emplacement réservé retenu dans reserves.json (propriétés des emprises Paris Data). */
export function isReserve(p) {
  return RESERVE_REGPRI.has(p.regpri) && !RESERVE_IGNORED.has(p.regpar ?? '');
}

/** Colonnes de reserves.json (contrat lu par src/services/parkprixData.ts de Parq). */
export const RESERVE_COLUMNS = ['regpri', 'regpar', 'street', 'num', 'places', 'arr', 'market', 'x', 'y'];

/** Construit reserves.json ligne à ligne ; `x` et `y` en micro-degrés depuis `origin` (centre de l'emprise). */
export class ReservesBuilder {
  constructor(origin, scale) {
    this.origin = origin;
    this.scale = scale;
    this.regpri = new Dict();
    this.regpar = new Dict();
    this.streets = new Dict();
    this.nums = new Dict();
    this.rows = [];
  }

  add({ regpri, regpar, street, num, places, arr, market, center }) {
    this.rows.push([
      this.regpri.id(regpri),
      this.regpar.id(regpar),
      this.streets.id(street),
      this.nums.id(num),
      places,
      arr,
      market,
      Math.round((center[0] - this.origin[0]) * this.scale),
      Math.round((center[1] - this.origin[1]) * this.scale),
    ]);
  }

  /** `markets` : le dictionnaire de voirie.json (mêmes index), recopié pour que le fichier se suffise. */
  toFile(markets) {
    return {
      version: 1,
      origin: this.origin,
      scale: this.scale,
      columns: RESERVE_COLUMNS,
      regpri: this.regpri.values,
      regpar: this.regpar.values,
      streets: this.streets.values,
      nums: this.nums.values,
      markets,
      rows: this.rows,
    };
  }
}
