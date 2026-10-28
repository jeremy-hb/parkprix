// Ordre des catégories d'emplacements = index dans voirie.json (contrat data/v1).
// Doit rester identique à VOIRIE_CATEGORIES_V1 dans packages/core/src/data.ts (vérifié par les tests).
import { ringCenter } from './geo.mjs';

export const VOIRIE_CATEGORIES = ['mixte', 'rotatif', 'gratuit', 'moto', 'pmr', 'electrique', 'livraison', 'velo'];

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Emprises dans un ordre stable. L'export Paris Data change d'ordre d'un téléchargement à l'autre, or
 * l'index d'une ligne de voirie.json ou de reserves.json identifie l'emplacement dans Parq
 * (`pp:<horodatage des données>:<index>`) : à contenu égal, chaque emplacement doit garder son
 * index. Tri par `id_old` (≈ 65 % des emprises, unique), puis par centre, puis par contenu complet
 * (dernier recours).
 */
export function sortEmprises(features) {
  const keyed = features.map((f) => {
    const g = f.geometry;
    const polys = !g ? null : g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    return { f, id: String(f.properties?.id_old ?? ''), center: polys ? ringCenter(polys[0][0]) : [Infinity, Infinity], text: null };
  });
  const text = (k) => (k.text ??= JSON.stringify([k.f.properties, k.f.geometry]));
  keyed.sort(
    (a, b) =>
      (a.id ? 0 : 1) - (b.id ? 0 : 1) ||
      byText(a.id, b.id) ||
      a.center[0] - b.center[0] ||
      a.center[1] - b.center[1] ||
      byText(text(a), text(b)),
  );
  return keyed.map((k) => k.f);
}

/** Régimes « 2 ROUES » réservés aux vélos ; tous les autres sont des places moto. */
export const VELO_REGIMES = new Set(['Vélos', 'Box à vélos', 'Vélo-cargo']);

/**
 * Catégorie d'un emplacement (propriétés `regpri` / `regpar` des emprises Paris Data), ou null s'il
 * n'est pas dans voirie.json (réservé à d'autres usages : voir lib/reserves.mjs).
 * « 2 ROUES / Mixte » (243 emplacements) est une place moto mixte, comme « Motos payant Mixte ».
 */
export function voirieCategory(p) {
  switch (p.regpri) {
    case 'PAYANT MIXTE':
      return 'mixte';
    case 'PAYANT ROTATIF':
      return 'rotatif';
    case 'GRATUIT':
      return 'gratuit';
    case 'ELECTRIQUE':
      return 'electrique';
    case 'GIG/GIC':
      return 'pmr';
    case 'LIVRAISON':
      return 'livraison';
    case '2 ROUES':
      return VELO_REGIMES.has(p.regpar) ? 'velo' : 'moto';
    default:
      return null;
  }
}
