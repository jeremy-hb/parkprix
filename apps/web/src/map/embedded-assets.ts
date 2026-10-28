// Mode embarqué (map.html de l'app hôte, sans serveur) : planche d'icônes et polices servies par un
// protocole `parkprix://` depuis la balise `#parkprix-assets` de la page (scripts/build-embed.mjs).
// Une page `srcdoc` ou `source={{ html }}` n'a pas d'adresse d'où charger `sprites/…` ; et les glyphes
// embarqués gardent les bulles de prix lisibles hors connexion.

import { addProtocol } from 'maplibre-gl';
import { OPENFREEMAP_GLYPHS } from '@parkprix/core';

/** Contenu de `#parkprix-assets` (écrit par scripts/build-embed.mjs). */
interface EmbeddedAssets {
  /** Planche @2x : chaque icône porte pixelRatio 2, elle sert donc aussi aux écrans 1x. */
  sprite: { json: object; png: string };
  /** « Noto Sans Bold/0-255 » → .pbf en base64. */
  glyphs: Record<string, string>;
}

export const EMBEDDED_SPRITE_URL = 'parkprix://sprites/parkprix';
export const EMBEDDED_GLYPHS_URL = 'parkprix://fonts/{fontstack}/{range}.pbf';

const base64ToBuffer = (b64: string): ArrayBuffer => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

/**
 * Worker MapLibre embarqué en texte (`#maplibre-worker`) → URL `blob:` ; null hors mode embarqué (le site
 * garde l'URL de son build). La balise est retirée ensuite : le Blob garde seul ses 500 Ko.
 */
export function embeddedWorkerUrl(): string | null {
  const el = document.getElementById('maplibre-worker');
  if (!el) return null;
  const blob = new Blob([el.textContent ?? ''], { type: 'text/javascript' });
  el.remove();
  return URL.createObjectURL(blob);
}

let assets: EmbeddedAssets | null = null;
function readAssets(): EmbeddedAssets {
  if (!assets) {
    const el = document.getElementById('parkprix-assets');
    assets = el?.textContent ? (JSON.parse(el.textContent) as EmbeddedAssets) : { sprite: { json: {}, png: '' }, glyphs: {} };
    el?.remove(); // l'objet lu suffit ensuite (planche relue au changement de thème, plages à la demande)
  }
  return assets;
}

/**
 * Déclare `parkprix://` auprès de MapLibre :
 * - `parkprix://sprites/parkprix[@2x].json|png` → planche @2x embarquée ;
 * - `parkprix://fonts/<police>/<plage>.pbf` → plage embarquée, sinon demandée à OpenFreeMap (comme le site).
 */
export function installEmbeddedAssets() {
  addProtocol('parkprix', async (params, abort) => {
    const [, kind, rest] = /^parkprix:\/\/(sprites|fonts)\/(.+)$/.exec(params.url) ?? [];
    if (kind === 'sprites') {
      const { sprite } = readAssets();
      if (rest.endsWith('.json')) return { data: sprite.json };
      if (rest.endsWith('.png') && sprite.png) return { data: base64ToBuffer(sprite.png) };
    }
    if (kind === 'fonts') {
      const [stack, range] = decodeURIComponent(rest.replace(/\.pbf$/, '')).split('/');
      const b64 = readAssets().glyphs[`${stack}/${range}`];
      if (b64) return { data: base64ToBuffer(b64) };
      const res = await fetch(OPENFREEMAP_GLYPHS.replace('{fontstack}', stack).replace('{range}', range), { signal: abort.signal });
      if (!res.ok) throw new Error(`Polices ${stack} ${range} : HTTP ${res.status}`);
      return { data: await res.arrayBuffer() };
    }
    throw new Error(`Ressource embarquée inconnue : ${params.url}`);
  });
}
