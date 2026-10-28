#!/usr/bin/env node
// Carte embarquée : réunit la page compilée en mode « embed » (apps/web/dist-embed, voir vite.config.ts)
// en UN fichier HTML autonome, sans serveur ni requête relative, pour une WebView (react-native-webview,
// `source={{ html, baseUrl }}`) ou une iframe `srcdoc`. Voir docs/EXPO.md (mode embarqué).
//
//   npm run embed                                  # → apps/web/dist-embed/map.html
//   npm run embed -- --out ../assets/parkprix/map.html
//   npm run embed -- --refresh                     # re-télécharge les polices (cache .cache/glyphs)
//
// La page produite (« coquille », ~2 Mo) contient le code, le CSS, le worker MapLibre, la planche
// d'icônes @2x et des plages de polices, mais aucune donnée : l'hôte remplace le marqueur unique
// <!--PARKPRIX_BOOT--> par `window.__PARKPRIX_OPTIONS__` et les balises JSON des données.

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Derrière un proxy HTTPS, le fetch natif de Node (≥ 22.21) ne l'utilise que si NODE_USE_ENV_PROXY=1.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } });
  process.exit(child.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'apps/web');
const DIST = path.join(WEB, 'dist-embed');
const GLYPH_CACHE = path.join(ROOT, '.cache/glyphs');

/** = EMBED_MARKER de packages/core/src/protocol.ts (l'hôte le remplace par options et données). */
const MARKER = '<!--PARKPRIX_BOOT-->';
/** Même adresse que OPENFREEMAP_GLYPHS (packages/core/src/style/basemap.ts). */
const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
/**
 * Polices embarquées : seulement ce qu'affichent les calques de ParkPrix hors connexion, c'est-à-dire les
 * bulles de prix et les étiquettes de zone, toutes en Bold (packages/core/src/style/parking-layers.ts).
 * Plages : latin (0-255 : chiffres, « é », « · »), ponctuation et symboles (8192-8447 : « € », « — »,
 * espaces fines), opérateurs (8704-8959 : « ≈ », « ≤ »). Regular, Italic et les autres plages ne servent
 * qu'aux libellés du fond de carte, dont les tuiles viennent déjà du réseau : ils sont demandés à
 * OpenFreeMap comme sur le site (map/embedded-assets.ts). Regular et Bold sur 4 plages : +530 Ko.
 */
const FONTS = ['Noto Sans Bold'];
const RANGES = ['0-255', '8192-8447', '8704-8959'];
/** Fond de la page avant le premier rendu (thème nuit de l'app hôte). */
const BACKGROUND = '#0B0E11';
/**
 * MapLibre appelle Object.hasOwn et .at(), absents de Chrome < 93 et Safari < 15.4 : la syntaxe est
 * abaissée par Vite (chrome90, safari15), pas les API. Ajouté à la page et au worker.
 */
const POLYFILLS =
  'Object.hasOwn||(Object.hasOwn=function(o,k){return Object.prototype.hasOwnProperty.call(o,k)});' +
  '(function(){function at(n){n=Math.trunc(n)||0;if(n<0)n+=this.length;return n<0||n>=this.length?void 0:this[n]}' +
  '[Array.prototype,String.prototype,Object.getPrototypeOf(Int8Array.prototype)].forEach(function(p){' +
  'p.at||Object.defineProperty(p,"at",{value:at,writable:true,configurable:true})})})();';

const { values: args } = parseArgs({
  options: { out: { type: 'string', default: path.join(DIST, 'map.html') }, refresh: { type: 'boolean', default: false } },
});

const kb = (n) => `${Math.round(n / 1024).toLocaleString('fr-FR')} Ko`;
const fail = (message) => {
  throw new Error(`build-embed : ${message}`);
};

/** Contenu d'un <script> ou <style> en ligne : aucune séquence qui fermerait la balise ou changerait l'analyse HTML. */
function inlineSafe(label, text, tag = 'script') {
  const bad = [`</${tag}`, '<!--'].find((s) => text.toLowerCase().includes(s));
  if (bad) fail(`« ${bad} » dans ${label} : impossible de l'inclure tel quel dans la page`);
  return text;
}

async function download(url, { retries = 3, timeoutMs = 30_000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('réponse vide');
      return buf;
    } catch (err) {
      if (attempt >= retries) throw new Error(`${url} : ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/** Plages de glyphes (.pbf) en base64, depuis le cache disque ou OpenFreeMap. */
async function loadGlyphs() {
  const glyphs = {};
  for (const font of FONTS) {
    for (const range of RANGES) {
      const file = path.join(GLYPH_CACHE, font, `${range}.pbf`);
      let buf = args.refresh ? null : await readFile(file).catch(() => null);
      if (!buf?.length) {
        buf = await download(GLYPHS_URL.replace('{fontstack}', encodeURIComponent(font)).replace('{range}', range));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, buf);
        console.log(`  ↓ ${font} ${range} (${kb(buf.length)})`);
      }
      glyphs[`${font}/${range}`] = buf.toString('base64');
    }
  }
  return glyphs;
}

async function main() {
  let html = await readFile(path.join(DIST, 'index.html'), 'utf8').catch(() =>
    fail(`${path.relative(ROOT, DIST)}/index.html absent : lancer d'abord « npm run build -w @parkprix/web -- --mode embed --outDir dist-embed » (ou « npm run embed »)`),
  );
  const assets = await readdir(path.join(DIST, 'assets'));

  // 1. Un seul script : le module de la page (le worker est à part).
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>\s*/g)];
  const chunks = assets.filter((f) => f.endsWith('.js') && !f.startsWith('maplibre-gl-worker-'));
  if (scripts.length !== 1 || chunks.length !== 1 || scripts[0][1] !== `assets/${chunks[0]}`)
    fail(`un seul morceau JS attendu (trouvés : ${chunks.join(', ') || 'aucun'}) : vérifier codeSplitting dans vite.config.ts`);
  const js = inlineSafe(chunks[0], await readFile(path.join(DIST, scripts[0][1]), 'utf8'));
  html = html.replace(scripts[0][0], '');

  // 2. Le CSS en <style>.
  const links = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\.\/(assets\/[^"]+\.css)"[^>]*>\s*/g)];
  if (links.length !== 1) fail(`une seule feuille de style attendue (trouvées : ${links.length})`);
  const css = inlineSafe(links[0][1], await readFile(path.join(DIST, links[0][1]), 'utf8'), 'style');
  const relativeUrl = css.match(/url\((?!["']?(?:data:|#))[^)]*\)/);
  if (relativeUrl) fail(`adresse relative dans le CSS (${relativeUrl[0]}) : elle ne se chargerait pas dans la page embarquée`);
  html = html.replace(links[0][0], '');

  // 3. Le worker MapLibre, en texte (main.ts en fait une URL blob:).
  const workers = assets.filter((f) => /^maplibre-gl-worker-.*\.js$/.test(f));
  if (workers.length !== 1) fail(`un seul worker MapLibre attendu (trouvés : ${workers.length})`);
  const worker = inlineSafe(workers[0], await readFile(path.join(DIST, 'assets', workers[0]), 'utf8'));

  // 4. Planche @2x et polices, servies par le protocole parkprix:// (map/embedded-assets.ts).
  const sprites = path.join(WEB, 'public/sprites');
  const embedded = {
    sprite: {
      json: JSON.parse(await readFile(path.join(sprites, 'parkprix@2x.json'), 'utf8')),
      png: (await readFile(path.join(sprites, 'parkprix@2x.png'))).toString('base64'),
    },
    glyphs: await loadGlyphs(),
  };
  const embeddedJson = JSON.stringify(embedded).replace(/</g, '\\u003c');

  // 5. Rien à charger de l'extérieur : ni Google Fonts (repli sur les polices système), ni icône.
  html = html.replace(/<link\b[^>]*>\s*/g, (tag) => (/fonts\.(googleapis|gstatic)\.com|rel="icon"/.test(tag) ? '' : tag));
  if (/<link\b/.test(html)) fail('lien externe inattendu dans index.html');

  // 6. WebView : pas de zoom de page (la carte gère le pincement), fond sombre dès le premier affichage,
  //    interface ParkPrix masquée jusqu'à ce que la page lise les options de l'hôte.
  html = html
    .replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />')
    .replace(/<meta name="theme-color"[^>]*>/, `<meta name="theme-color" content="${BACKGROUND}" />`)
    .replace(/<html\b[^>]*>/, '<html lang="fr" data-theme="night" data-chrome="off">');

  // 7. Marqueur unique à la fin de <head>, AVANT le module : options et données existent à son lancement.
  if (html.includes(MARKER)) fail('marqueur déjà présent dans index.html');
  const head = [
    `<style>${css}</style>`,
    `<style>html, body { background: ${BACKGROUND}; }</style>`,
    `<script>${POLYFILLS}</script>`,
    MARKER,
    `<script type="module">${js}</script>`,
  ].join('\n');
  const tail = [
    `<script type="text/plain" id="maplibre-worker">${POLYFILLS}\n${worker}</script>`,
    `<script type="application/json" id="parkprix-assets">${embeddedJson}</script>`,
  ].join('\n');
  if (html.split('</head>').length !== 2 || html.split('</body>').length !== 2) fail('index.html inattendu (</head> ou </body>)');
  html = html.replace('</head>', () => `${head}\n</head>`).replace('</body>', () => `${tail}\n</body>`);

  // 8. Contrôles de la coquille (repris par src/services/parkprixData.test.ts dans Parq).
  if (html.split(MARKER).length !== 2) fail('le marqueur doit être présent une seule fois');
  if ((html.match(/id="maplibre-worker"/g) ?? []).length !== 1) fail('#maplibre-worker doit être présent une seule fois');
  if (html.search(/<script\b[^>]*\btype="module"/) < html.indexOf(MARKER)) fail('le module doit suivre le marqueur');
  if ((html.match(/<script\b/gi) ?? []).length !== (html.match(/<\/script>/gi) ?? []).length) fail('balises <script> déséquilibrées');
  if (/\b(?:src|href)="\.?\/?assets\//.test(html)) fail('référence restante à assets/');

  const out = path.resolve(args.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, html);
  const size = Buffer.byteLength(html);
  console.log(`✓ ${path.relative(process.cwd(), out)} : ${kb(size)}`);
  console.log(
    `  code ${kb(js.length)} · worker ${kb(worker.length)} · CSS ${kb(css.length)} · icônes ${kb(embedded.sprite.png.length)} · polices ${kb(Object.values(embedded.glyphs).reduce((n, g) => n + g.length, 0))}`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
