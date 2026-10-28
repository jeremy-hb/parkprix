import { defineConfig } from 'vite';

// base relative : le site fonctionne aussi bien à la racine d'un domaine que
// dans un sous-dossier (GitHub Pages : https://<user>.github.io/<repo>/).
//
// Mode « embed » (npm run embed, voir scripts/build-embed.mjs et docs/EXPO.md) : même page, compilée
// pour une WebView (Android WebView, WKWebView) puis réunie en un seul fichier map.html sans serveur.
export default defineConfig(({ mode }) =>
  mode === 'embed'
    ? {
        base: './',
        worker: { format: 'es' },
        build: {
          // Syntaxe abaissée pour les WebView plus anciennes (MapLibre exige de toute façon WebGL 2).
          target: ['chrome90', 'safari15'],
          chunkSizeWarningLimit: 2000,
          // Un seul script, pas de préchargement ni de copie de public/ (données et icônes : fournies autrement).
          modulePreload: false,
          copyPublicDir: false,
          rolldownOptions: { output: { codeSplitting: false } },
        },
        experimental: {
          // URL du worker laissée en texte : `new URL(…, import.meta.url)` échouerait dans une page sans
          // adresse (about:blank), et la page embarquée lit le worker dans #maplibre-worker.
          renderBuiltUrl: (filename, { hostType }) => (hostType === 'js' ? { runtime: JSON.stringify(filename) } : undefined),
        },
      }
    : {
        base: './',
        worker: { format: 'es' },
        build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
        server: { host: true },
      },
);
