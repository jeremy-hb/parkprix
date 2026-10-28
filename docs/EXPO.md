# Brancher ParkPrix dans une app Expo

Le projet est découpé pour qu'une future app Expo / React Native réutilise tout ce qui a de la valeur :

```
packages/core   @parkprix/core — TypeScript pur, sans DOM (vérifié par tsc : lib ES2023 seule)
                ├─ moteur de prix (grille officielle, jours fériés, heure de Paris sans Intl)
                ├─ client de l'API de données (fetch) + décodage de voirie.json
                ├─ style de carte façon Waze (objet MapLibre) + calques stationnement
                └─ modèle : prix affichés, couleurs, « les moins chers autour », vélo / moto
apps/web        site Vite + MapLibre GL JS (utilise @parkprix/core)
apps/web/public/data/v1   API de données statique (JSON / GeoJSON), voir DATA_API.md
apps/web/public/sprites   planche d'icônes PNG (P, bulles de prix, vélo, moto…) 1x / 2x
```

Trois chemins d'intégration, cumulables :

| | A. WebView (immédiat) | B. Carte native MapLibre (recommandé à terme) | C. Carte embarquée (sans serveur) |
|---|---|---|---|
| Effort | ~30 lignes | un écran carte + un panneau en composants RN | un fichier `map.html` + ~100 lignes |
| Rendu | le site dans une WebView | MapLibre Native (fluide, hors-ligne possible) | la page du site, sans son interface, dans une WebView ou une iframe `srcdoc` |
| Réutilisé | tout le site | `@parkprix/core` : style, calques, prix, données | la page du site + `@parkprix/core` (protocole) |
| Données | serveur du site | serveur ou copie locale | fournies par l'app (aucun serveur, aucun GitHub Pages) |
| Expo Go | oui | non (development build, plugin natif) | oui |

---

## A. Intégration WebView (quelques minutes)

```bash
npx expo install react-native-webview
```

```tsx
// app/(tabs)/carte.tsx
import { useRef } from 'react';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

const PARKPRIX_URL = 'https://calvinndmb.github.io/Parking/'; // site déployé (GitHub Pages)

export default function CarteParking() {
  // <object> : contourne le paramètre de type par défaut (undefined) des typings de react-native-webview.
  const web = useRef<WebView<object>>(null);
  const send = (command: object) => web.current?.postMessage(JSON.stringify(command));

  const onMessage = (e: WebViewMessageEvent) => {
    const event = JSON.parse(e.nativeEvent.data);
    if (event.source !== 'parkprix') return;
    if (event.type === 'ready') send({ type: 'setVehicle', vehicle: 'voiture' });
    if (event.type === 'select' && event.kind === 'parking') {
      console.log(`${event.name} : ${event.label}`); // ex. « Saint Sulpice : 10,80 € »
    }
  };

  return (
    <WebView<object>
      ref={web}
      source={{ uri: `${PARKPRIX_URL}?chrome=0&vehicle=voiture&duration=120` }}
      onMessage={onMessage}
      geolocationEnabled
    />
  );
}
```

### Paramètres d'URL

| Paramètre | Valeurs | Effet |
|---|---|---|
| `chrome` | `0` | carte seule : pas de barre de recherche, puces, panneau ni boutons (l'app fournit sa propre interface) |
| `vehicle` | `voiture`, `suv`, `electrique`, `moto`, `velo` | véhicule initial |
| `duration` | `30`, `60`, `120`, `180`, `240`, `360`, `600`, `1440` | durée initiale (minutes) |
| `theme` | `day`, `night` | thème de carte |
| `parking` | identifiant (`paris:75101-P-006`…) | ouvre la fiche d'un parking |
| `#zoom/lat/lon` | ex. `#16/48.8508/2.3334` | position de la carte |

### Événements envoyés par la carte (`onMessage`)

Tous les messages ont `source: 'parkprix'` et un `type` :

| `type` | Contenu |
|---|---|
| `ready` | `dataVersion` (`v1`) — la carte et les 60 000 emplacements sont chargés |
| `settings` | `vehicle`, `minutes`, `start` (ISO ou `null` = maintenant), `theme` |
| `select` | `kind: 'parking'` → `id`, `name`, `price`, `label`, `lon`, `lat`<br>`kind: 'spot'` → `index`, `street`, `category`, `zone`, `price`, `lon`, `lat`<br>`kind: 'belib'` → `name`, `lon`, `lat` |
| `deselect` | la fiche a été fermée |
| `focus` | point de recherche choisi : `lon`, `lat`, `label` (aussi pour un toucher dans le vide : « Point choisi sur la carte ») ; précédé de `deselect` si une fiche était ouverte |
| `moveend` | `lon`, `lat`, `zoom` après chaque déplacement |
| `loaded` | fond de carte et parkings affichés, **avant** la voirie (`ready` arrive plusieurs secondes après) |
| `tilesError` | fond de carte injoignable (hors connexion) ; envoyé une fois, les prix restent affichés |
| `error` | `message` : échec du chargement (données, WebGL 2 absent…) ; la carte ne s'affichera pas |
| `needData` | mode embarqué `chunks` seulement : `files`, fichiers à envoyer par `loadData` (voir C) |

### Commandes acceptées (`web.current.postMessage(JSON.stringify(cmd))`)

| Commande | Exemple |
|---|---|
| `setVehicle` | `{ type: 'setVehicle', vehicle: 'velo' }` |
| `setDuration` | `{ type: 'setDuration', minutes: 180 }` |
| `setStart` | `{ type: 'setStart', start: '2026-10-04T12:00:00Z' }` (`null` = maintenant) |
| `setTheme` | `{ type: 'setTheme', theme: 'night' }` |
| `flyTo` | `{ type: 'flyTo', lon: 2.35, lat: 48.86, zoom: 16 }` |
| `focus` | `{ type: 'focus', lon: 2.35, lat: 48.86, label: 'Destination' }` → liste des moins chers autour |
| `selectParking` / `deselect` | `{ type: 'selectParking', id: 'paris:75101-P-006' }` |
| `setLayers` | `{ type: 'setLayers', layers: { velo: true, moto: true, zones: false } }` |
| `setChrome` | `{ type: 'setChrome', visible: false }` |
| `loadData` | `{ type: 'loadData', file: 'voirie.json', index: 0, total: 9, chunk: '…' }` (mode embarqué `chunks`, voir C) |

Les commandes sont validées côté carte (valeurs hors liste ignorées). Le même protocole fonctionne dans une `<iframe>` (via `window.postMessage`).
Types et validation sont dans `@parkprix/core` (`packages/core/src/protocol.ts`) : `HostEvent`, `HostCommand`,
`parseCommand` (côté carte) et `parseHostEvent` (côté hôte : filtre `source: 'parkprix'` et valide chaque champ).

---

## C. Carte embarquée, sans serveur (`map.html`)

La page du site (`apps/web`) a un **mode embarqué** : l'app fournit tout (code, données, réglages) et la page
n'accède au réseau que pour le fond de carte OpenFreeMap. C'est ce qu'utilise l'app Parq (`assets/parkprix/map.html`,
`src/services/mapHtml.ts`, `src/components/map/PriceMap*.tsx`). Le site autonome ne change pas.

### 1. Construire la coquille

```bash
npm run embed -- --out ../chemin/vers/map.html     # dans Parq : npm run parkprix:map
```

1. `vite build --mode embed --outDir dist-embed` (voir `apps/web/vite.config.ts`) : cible `chrome90` / `safari15`,
   un seul morceau JS, pas de préchargement, pas de copie de `public/`, URL du worker laissée en texte.
2. `scripts/build-embed.mjs` réunit tout en **un seul fichier** (~2 Mo) :

| Contenu | Où |
|---|---|
| code de la page (module ES, ~1,1 Mo) | `<script type="module">` en ligne, dans `<head>` après le marqueur |
| CSS | `<style>` |
| worker MapLibre (~500 Ko) | `<script type="text/plain" id="maplibre-worker">`, transformé en URL `blob:` par la page, qui retire ensuite la balise |
| planche d'icônes @2x (JSON + PNG en base64, ~85 Ko) | `<script type="application/json" id="parkprix-assets">` (lu une fois puis retiré), servie à MapLibre par le protocole `parkprix://` (`apps/web/src/map/embedded-assets.ts`) ; chaque icône porte `pixelRatio: 2`, la planche sert donc aussi aux écrans 1x |
| police Noto Sans Bold, plages 0-255, 8192-8447, 8704-8959 (~210 Ko) | idem ; téléchargées sur OpenFreeMap au build (cache `.cache/glyphs`, `--refresh` pour les renouveler). Ce sont les caractères des bulles de prix et des étiquettes de zone (chiffres, « € », « ≈ », « ≤ », espaces fines), lisibles hors connexion. Regular, l'italique et les autres plages ne servent qu'aux libellés du fond de carte, dont les tuiles viennent du réseau : ils sont demandés à OpenFreeMap comme sur le site (`FONTS` et `RANGES` de `build-embed.mjs`) |
| `Object.hasOwn` et `.at()` pour Chrome < 93 et Safari < 15.4 | petit correctif en tête de la page et du worker (la syntaxe est abaissée par Vite, pas les API) |

Le script vérifie qu'il n'y a qu'un morceau JS, **aucun `</script` ni `<!--`** dans le code en ligne, aucune
adresse relative dans le CSS, et un **marqueur unique** `<!--PARKPRIX_BOOT-->` à la fin de `<head>`, avant le
module. Google Fonts et l'icône sont retirés (polices système), le zoom de page est bloqué
(`maximum-scale=1, user-scalable=no`) et le fond vaut `#0B0E11` avant le premier rendu. `<html>` part avec
`data-theme="night" data-chrome="off"` : l'interface ParkPrix ne clignote pas avant la lecture des options.

La coquille ne contient **aucune donnée** : elle se reconstruit seulement quand le code de la page change.

### 2. Assembler la page dans l'app

L'hôte remplace le marqueur (une seule fois, par `split(MARKER).join(boot)` — jamais `String.replace`, les données
peuvent contenir `$'`) par :

```html
<script>window.__PARKPRIX_OPTIONS__={"embedded":true,"theme":"night","chrome":false,"dataMode":"inline",…}</script>
<script type="application/json" id="pp-data-meta.json">{…}</script>
<script type="application/json" id="pp-data-voirie.json">{…}</script>
…
```

- Dans les options comme dans les données, chaque `<` devient `\u003c` (`texte.replace(/</g, '\\u003c')`) : le
  JSON reste valide et aucune balise ne peut se fermer trop tôt.
- Identifiants : `dataScriptId(fichier)` (`pp-data-` + nom) pour `meta.json`, `zones.geojson`, `parkings.geojson`,
  `belib.geojson` et `voirie.json` (`EMBEDDED_DATA_FILES`). La page lit chaque balise une fois puis la retire du
  document. Grille de couverture et arrondissements ne sont pas embarqués : le calque `coverage` reste éteint.

**Options** (`EmbedOptions`, validées par la page ; elles remplacent les paramètres d'URL, qu'une page `srcdoc`
ou `source={{ html }}` n'a pas) :

| Option | Effet |
|---|---|
| `embedded: true` | active le mode embarqué (sinon : comportement du site) |
| `chrome` | `false` : carte seule, l'hôte fournit ses contrôles |
| `vehicle`, `minutes`, `theme` | réglages initiaux (rien n'est lu ni écrit dans `localStorage` : une page `srcdoc` partage celui de l'app) |
| `center` (`[lon, lat]`), `zoom` | vue initiale |
| `focus` (`{ lon, lat, label }`) | repère posé à l'ouverture (événement `focus` renvoyé) |
| `parking` | parking sélectionné à l'ouverture (événement `select`) |
| `dataMode` | `inline` (balises ci-dessus) ou `chunks` (voir 4) |

En mode embarqué, l'historique n'est pas touché (`hash: false` : `history.replaceState` lève une SecurityError dans
une page `srcdoc`).

### 3. Afficher la page

- **React Native** : `<WebView source={{ html, baseUrl: 'https://parkprix.invalid/' }} originWhitelist={['*']} … />`.
  La base https factice donne une vraie origine (worker `blob:`, `localStorage`) ; aucune requête n'y part.
  Événements : `onMessage` (texte JSON) ; commandes : `postMessage(JSON.stringify(cmd))`.
- **Web** : `<iframe srcdoc={html}>` sans `sandbox`, créée après le montage. Événements : `message` filtré sur
  `e.source === iframe.contentWindow` ; commandes : `iframe.contentWindow.postMessage(cmd, '*')`.

Déroulé : `settings`, puis `loaded` (l'hôte retire son voile), éventuellement `focus` et `select` venus des options,
puis `ready` quand la voirie est affichée. Sans `loaded` au bout de quelques secondes, ou sur `error`, l'hôte affiche
son écran de repli ; `tilesError` n'empêche pas l'affichage des prix.

Mieux vaut envoyer les commandes à partir de `loaded`. Une commande reçue avant (sauf `loadData`, traitée tout de
suite) est gardée par la page et appliquée juste après `loaded`, dans l'ordre d'arrivée et après les options.

### 4. Mode `chunks` (grosses pages sur Android)

Si une page de ~7 Mo (coquille + données) ne s'affiche pas dans la WebView, l'hôte envoie la coquille avec
`dataMode: 'chunks'` et peu ou pas de balises de données. La page émet aussitôt `needData` avec la liste des
fichiers sans balise, dans l'ordre (voirie en dernier) ; l'hôte répond par des `loadData` :

```ts
for (const file of event.files) {
  const parts = chunkText(texts[file], 512_000);
  parts.forEach((chunk, index) => send({ type: 'loadData', file, index, total: parts.length, chunk }));
}
```

Les morceaux peuvent arriver dans le désordre ou en double ; un nouvel envoi du même fichier avec un autre `total`
repart de zéro, et un morceau reçu après que le fichier est complet est ignoré. `loaded` arrive quand `meta`,
`zones`, `parkings` et `belib` sont reçus, `ready` après la voirie. Une fois un fichier lu, la page n'en garde pas
le texte. `loadData` est la seule commande traitée avant `loaded` (les autres attendent, voir 3).

---

## B. Carte native avec MapLibre React Native

### 1. Installer

```bash
npx expo install @maplibre/maplibre-react-native
```

`app.json` :

```json
{ "expo": { "plugins": ["@maplibre/maplibre-react-native"] } }
```

MapLibre Native est un module natif : utiliser un *development build* (`npx expo run:ios` / `run:android`), pas Expo Go.
La version 11 demande Expo ≥ 54, React Native ≥ 0.80 et React ≥ 19.1.

### 2. Utiliser le cœur partagé

Dans ce dépôt (workspaces npm), ajouter l'app dans `apps/mobile` avec la dépendance `"@parkprix/core": "0.2.0"` :
Expo (SDK ≥ 52) gère les monorepos automatiquement et Metro compile directement les sources TypeScript de `packages/core`.
Hors monorepo, copier `packages/core/src` ou le publier sur un registre privé.

### 3. Écran carte

```tsx
import { useEffect, useMemo, useState } from 'react';
// « Map » est renommé pour ne pas masquer le Map natif de JavaScript utilisé plus bas.
import { Camera, GeoJSONSource, Layer, Map as MapView, type LayerSpecification, type StyleSpecification } from '@maplibre/maplibre-react-native';
import {
  FIRST_LABEL_LAYER,
  SOURCES,
  VOIRIE_SOURCE_OPTIONS,
  buildBasemapStyle,
  createDataClient,
  parkingLayers,
  parkingsFeatureCollection,
  quoteParking,
  streetStyle,
  zoneLabelsFeatureCollection,
  type CoreData,
  type Settings,
  type VoirieData,
} from '@parkprix/core';

const BASE = 'https://calvinndmb.github.io/Parking/'; // héberge data/v1 et sprites/
const data = createDataClient(BASE);

export function ParkingMap({ settings, theme }: { settings: Settings; theme: 'day' | 'night' }) {
  const [core, setCore] = useState<CoreData>();
  const [voirie, setVoirie] = useState<VoirieData>();
  useEffect(() => {
    data.loadCore().then(setCore);
    data.loadVoirie().then(setVoirie);
  }, []);

  // Le même style « façon Waze » que le site (fond + icônes du sprite). Le paramètre de type
  // indique la copie des types de style embarquée par MapLibre React Native.
  const mapStyle = useMemo(() => buildBasemapStyle<StyleSpecification>({ theme, spriteUrl: `${BASE}sprites/parkprix` }), [theme]);
  if (!core) return null;

  const categories = core.meta.categories;
  const quotes = new Map(core.parkings.map((p) => [p.id, quoteParking(p, settings)]));
  const street = streetStyle(settings, core.meta.tariffs, categories);
  const { below, above } = parkingLayers<LayerSpecification>({
    theme,
    categories,
    iconCategories: settings.vehicle === 'velo' ? ['velo'] : settings.vehicle === 'moto' ? ['moto'] : [],
    paint: { voirieColor: street.color, voirieOpacity: street.opacity, zoneColor: street.zoneColor },
  });
  const belowIds = new Set(below.map((l) => l.id));
  // Les calques « below » (zones, bordures de trottoir) passent sous les libellés du fond de carte.
  const layersOf = (source: string) =>
    [...below, ...above]
      .filter((l) => 'source' in l && l.source === source)
      .map((l) => <Layer key={l.id} {...l} beforeId={belowIds.has(l.id) ? FIRST_LABEL_LAYER : undefined} />);

  return (
    <MapView mapStyle={mapStyle} style={{ flex: 1 }}>
      <Camera initialViewState={{ center: [2.3417, 48.859], zoom: 13 }} />
      <GeoJSONSource id={SOURCES.zones} data={core.zones}>{layersOf(SOURCES.zones)}</GeoJSONSource>
      {voirie && (
        <GeoJSONSource id={SOURCES.voirie} data={voirie.geojson} {...VOIRIE_SOURCE_OPTIONS}>
          {layersOf(SOURCES.voirie)}
        </GeoJSONSource>
      )}
      <GeoJSONSource
        id={SOURCES.parkings}
        data={parkingsFeatureCollection(core.parkings, quotes, settings, { showSubscribers: true, selectedId: null })}
        onPress={(e) => console.log(e.nativeEvent.features[0]?.properties)}
      >
        {layersOf(SOURCES.parkings)}
      </GeoJSONSource>
      <GeoJSONSource id={SOURCES.zoneLabels} data={zoneLabelsFeatureCollection(street, settings)}>{layersOf(SOURCES.zoneLabels)}</GeoJSONSource>
    </MapView>
  );
}
```

Les calques « below » sont insérés sous les libellés grâce à `beforeId`, les « P » et bulles de prix restent au-dessus.
Pour les icônes vélo / moto, ajouter la source `SOURCES.voiriePoints` avec `voiriePointsCollection(voirie, ['velo', 'moto'])`.

### 4. Ce qui reste propre à l'app mobile

- Le panneau (liste « les moins chers autour », fiches) : à recomposer en composants RN à partir de
  `nearbyOptions()`, `quoteStreet()`, `quoteParking()` et `CATEGORY_LABELS` — toute la logique est déjà dans le cœur.
- La recherche d'adresse : même API IGN (`https://data.geopf.fr/geocodage/search`), appelable avec `fetch`.
- La géolocalisation : `expo-location` ou `<UserLocation />` de MapLibre.
- Le lien « Y aller avec Waze » : `Linking.openURL('https://waze.com/ul?ll=LAT,LON&navigate=yes')`.

## Compatibilité vérifiée

- Les deux exemples de ce guide ont été vérifiés au typage (TypeScript strict, sans DOM) contre React Native 0.81,
  React 19.1, `@maplibre/maplibre-react-native` 11.4 et `react-native-webview` 14.

- `packages/core` compile sans la bibliothèque DOM (`tsc -p packages/core`, lancé par la CI).
- `buildBasemapStyle<S>()` et `parkingLayers<L>()` prennent le type de style du moteur appelant :
  MapLibre React Native embarque sa propre copie des types de style (26.2.1) et MapLibre GL JS la sienne (26.4.x).
- L'heure de Paris est calculée sans `Intl` (Hermes) et vérifiée contre `Intl` sur 20 000 instants.
- Les prix sont formatés sans `Intl.NumberFormat` (« 10,80 € », « 3 650 € »).
- Carte embarquée (C), vérifiée dans Chromium avec une iframe `srcdoc` : modes `inline` et `chunks` (morceaux dans le
  désordre, en double, données en partie en ligne), commandes `setVehicle`, `setDuration`, `setStart`, `setTheme`,
  `flyTo`, `selectParking`, `deselect`, sélection d'une place au toucher, commandes envoyées avant `loaded` ; hors
  connexion simulé (`tilesError`, bulles de prix lisibles grâce aux polices embarquées) ; WebGL 2 absent et fichier
  manquant (`error`). Tests automatiques du pont (options, données embarquées) : `tests/bridge.test.ts`.
