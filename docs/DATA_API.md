# API de données ParkPrix — v1

Données statiques (JSON / GeoJSON, WGS84) générées par `npm run data` et servies avec le site :

```
<BASE>/data/v1/meta.json              version, tarifs officiels, catégories, couverture, sources
<BASE>/data/v1/zones.geojson          2 zones tarifaires (polygones)
<BASE>/data/v1/voirie.json            ~60 000 emplacements sur rue (format compact, voir plus bas)
<BASE>/data/v1/reserves.json          ~3 000 emplacements réservés (taxis, police…), pour l'app Parq
<BASE>/data/v1/parkings.geojson       ~280 parkings (points) fusionnés depuis 5 sources
<BASE>/data/v1/belib.geojson          stations de recharge Belib'
<BASE>/data/v1/arrondissements.geojson  contours + couverture par arrondissement
<BASE>/data/v1/coverage-grid.geojson  grille de couverture (mailles de 200 m)
<BASE>/sprites/parkprix[@2x].{json,png}  icônes de la carte (sprite MapLibre)
```

`<BASE>` = l'URL du site (ex. GitHub Pages `https://<compte>.github.io/Parking/`).
Le client TypeScript `createDataClient(BASE)` de `@parkprix/core` charge et décode tout (web, Node, React Native).
Toute évolution incompatible du format donnera un dossier `v2` ; `meta.schemaVersion` vaut `1`.
Licence : bases dérivées de données ODbL → **ODbL** (attribution « Paris Data, Saemes, Indigo, BNLS, OpenStreetMap »).

## meta.json

| Champ | Type | Contenu |
|---|---|---|
| `schemaVersion` | `1` | version du contrat |
| `generatedAt` | ISO 8601 | date de génération |
| `categories` | `string[]` | ordre des catégories de voirie.json : `mixte`, `rotatif`, `gratuit`, `moto`, `pmr`, `electrique`, `livraison`, `velo` |
| `tariffs` | `{ "1": ZoneTariffs, "2": ZoneTariffs }` | grille officielle par zone : prix de chaque tranche horaire (6 tranches) pour `vl`, `vlSamedi`, `suv`, `moto`, `motoSamedi` |
| `coverage` | objet | couverture spatiale, places, parkings, contrôle horodateurs (voir `CoverageMeta` dans `packages/core/src/types.ts`) |
| `sources` | `SourceMeta[]` | nom, fournisseur, URL, licence, nombre d'enregistrements |

Exemple de grille : zone 1 voiture `[6, 6, 12, 15, 18, 18]` → 1 h = 6 €, 2 h = 12 €, 3 h = 24 €, 6 h = 75 €
(chaque quart d'heure coûte le quart du tarif de l'heure en cours : `progressiveCost()`).

## voirie.json (format compact)

```jsonc
{
  "version": 1,
  "origin": [2.2, 48.8],         // origine des coordonnées
  "scale": 1000000,              // micro-degrés
  "categories": ["mixte", …],     // = meta.categories
  "typsta": ["", "Longitudinal", "Épi", "Bataille"],
  "streets": ["", "Rue de Chabrol", …],   // dictionnaires de chaînes
  "zonesRes": ["", "10G", …],
  "regimes": ["", "Mixte", "Vélos", …],
  "hours": ["", "05:00–14:30", …],
  "nums": ["", "22", "12 bis", …],        // numéros dans la rue (colonne 12)
  "markets": [null, { "name": "Marché Bastille", "days": 17, "weekday": "7h-13h30", "saturday": "", "sunday": "7h-14h30" }, …],
  "columns": ["cat", "places", "zone", "arr", "street", "numFrom", "numTo", "zoneRes", "typsta", "regime", "hours", "ring", "num", "market"],
  "rows": [
    // [cat, places, zone, arr, street, numFrom, numTo, zoneRes, typsta, regime, hours, ring, num, market]
    [0, 3, 1, 10, 1, 59, 73, 1, 1, 1, 0, [150670, 77175, 10, 0, 0, 20, -10, 0], 4, 0]
  ]
}
```

- Les colonnes 0 à 10 sont des entiers ; les colonnes `street`, `zoneRes`, `typsta`, `regime`, `hours` sont des index dans les dictionnaires.
- `zone` : 1 ou 2 (0 = hors zone tarifaire) ; `arr` : arrondissement (bois rattachés au 12e / 16e).
- `ring` : contour de l'emprise, premier sommet en micro-degrés depuis `origin`, puis deltas `[dx, dy, …]` (anneau non refermé).
  `decodeVoirie()` reconstruit les polygones GeoJSON (propriétés `k = cat × 10 + zone` et `c = cat`) et un index des centres.
- `hours` : plages horaires publiées de l'emprise (`plage_hor1..3`, sans les jours) ; sur les emplacements « Marché »,
  c'est la plage où le stationnement est neutralisé (installation et nettoyage compris), plus large que le marché lui-même.
- **Catégories** : `regpri` → `mixte` (PAYANT MIXTE), `rotatif` (PAYANT ROTATIF), `gratuit`, `pmr` (GIG/GIC),
  `electrique`, `livraison` ; `2 ROUES` → `velo` pour Vélos, Vélo-cargo et Box à vélos, **`moto` pour tout le reste**,
  y compris « 2 ROUES / Mixte » (243 emplacements, places moto mixtes comme « Motos payant Mixte »). AUTOCAR,
  LOCATION et AUTRE REGIME ne sont pas dans voirie.json : voir `reserves.json`.

**Colonnes ajoutées après `ring`** (compatibles : `decodeVoirie()` et le site ne lisent que les colonnes 0 à 11 ;
un lecteur doit trouver `num` et `market` d'après `columns`, à défaut aux positions 12 et 13) :

| Colonne | Contenu |
|---|---|
| 12 `num` | index dans `nums` : numéro dans la rue (`numvoie`), avec « bis », « ter » ou « quater » quand `compnumvoie` le précise (le reste de ce champ, texte libre, est ignoré) ; 0 = `""`, numéro inconnu (≈ 37 % des lignes) |
| 13 `market` | index dans `markets` : marché découvert qui neutralise l'emplacement ; 0 = aucun (`markets[0]` vaut `null`) |

**Marchés** (`markets`, index ≥ 1) : `{ name, days, weekday, saturday, sunday }`.
- `days` : jours de tenue en masque de bits, **bit 0 = dimanche**, bit 1 = lundi … bit 6 = samedi (Bastille : 17 = jeudi et dimanche).
- `weekday`, `saturday`, `sunday` : horaires du marché (vente) en semaine, le samedi, le dimanche, au format `"7h-13h30"` ;
  `""` les jours où il ne se tient pas.
- Source : Paris Data « Marchés découverts » (`marches-decouverts`, 80 marchés, mis à jour en avril 2024). Les jours
  sont l'union des indicateurs `lundi` … `dimanche` et des jours cités par `jours_tenue` (ils divergent pour le
  marché du Télégraphe) : mieux vaut un jour de trop qu'un jour de fourrière oublié.
- Jointure : seuls les emplacements dont le régime particulier contient « Marché » (Mixte Marché, Rotatif Marché,
  Gratuit Marché, et « Marché » dans reserves.json : ≈ 600) sont rattachés, au marché dont l'emprise (`geo_shape`)
  est la plus proche du centre de l'emplacement, **à 30 m au plus** (≈ 83 % rattachés). Plusieurs marchés au même
  endroit à moins de 10 m près (Edgar Quinet et marché de la Création, Raspail et Raspail bio) sont fusionnés :
  noms joints par « / », union des jours. Sans correspondance, `market` vaut 0 : afficher une mention générique.
- Les jours peuvent avoir changé depuis 2024 : toujours inviter à vérifier le panneau.

## reserves.json (places réservées, pour Parq)

Emplacements interdits au public, absents de voirie.json : `regpri` AUTOCAR, LOCATION ou AUTRE REGIME, sauf les
`regpar` Vélib', Trilib', Vélos, Vélo-cargo et Box à vélos (≈ 3 078 lignes, ≈ 130 Ko). Le site ne le charge pas.

```jsonc
{
  "version": 1,
  "origin": [2.2, 48.8],
  "scale": 1000000,
  "columns": ["regpri", "regpar", "street", "num", "places", "arr", "market", "x", "y"],
  "regpri": ["", "AUTRE REGIME", "LOCATION", "AUTOCAR"],
  "regpar": ["", "Taxi gaine autorisée", "SP - Police", "Marché", …],   // valeurs brutes de Paris Data
  "streets": ["", "Rue de Rivoli", …],
  "nums": ["", "41", …],
  "markets": [null, …],            // copie du dictionnaire de voirie.json (mêmes index)
  "rows": [
    // [regpri, regpar, street, num, places, arr, market, x, y]
    [1, 1, 1, 1, 4, 1, 0, 137600, 60600]
  ]
}
```

- `regpri`, `regpar`, `street`, `num`, `market` : index dans les dictionnaires (0 = `""` ou aucun marché).
- `x`, `y` : centre de l'emprise en micro-degrés **absolus** depuis `origin` (pas de deltas) : `lon = 2.2 + x / 1e6`.
- `markets` est facultatif pour un lecteur : absent, les index `market` renvoient au dictionnaire de voirie.json.

## Génération partielle

`npm run data -- --only=voirie,reserves,markets` ne retélécharge que les emprises et les marchés (Paris Data), quand
une autre source (Overpass, Saemes, BNLS…) échoue. Il réécrit voirie.json et reserves.json à partir de
`zones.geojson` et `meta.json` existants, met à jour dans `meta.json` la date, les sources et les places de voirie,
et laisse parkings, belib, arrondissements et couverture inchangés.

- **Clone neuf** : `public/data/` n'est pas versionné. S'il manque `zones.geojson`, `meta.json`, `parkings.geojson`
  ou `belib.geojson`, le mode partiel les reprend de la copie commitée par Parq (`../assets/parkprix/*.pkjson` et
  `meta.json`) et les recopie dans `public/data/v1`, pour que `npm run parkprix:sync` trouve tous les fichiers.
  `arrondissements.geojson` et `coverage-grid.geojson` (site seulement) restent absents jusqu'à une génération complète.
- **Marchés** : ils sont toujours rechargés avec `voirie` ou `reserves` (`markets` est implicite). Si la source
  « marchés découverts » échoue, ou si aucun emplacement « Marché » n'est rattaché, la génération (partielle ou
  complète) s'arrête sans rien écrire de la voirie. `--no-markets` passe outre, explicitement : aucun emplacement
  n'a alors de marché (mention générique), le contrôle affiche « ! », et la source n'est retirée de `meta.sources`
  que si voirie.json et reserves.json sont tous deux réécrits.

## Ordre des lignes

L'export des emprises change d'ordre d'un téléchargement à l'autre. Les emprises sont donc triées avant l'écriture
(`id_old` quand il existe, puis centre, puis contenu) : à contenu égal, chaque emplacement garde le même index
dans voirie.json et reserves.json, et les dictionnaires le même ordre. Un index ne vaut toutefois que pour une
version des données : dès que le contenu change, les lignes suivantes se décalent (Parq préfixe ses identifiants
par la date des données).

## parkings.geojson

Points (`FeatureCollection<Point>`) ; propriétés principales (type `CarPark`) :

| Champ | Contenu |
|---|---|
| `id` | identifiant stable préfixé par la source (`paris:75101-P-006`, `saemes:PMO33`, `osm:way/123`, `indigo:1553`, `bnls:…`) |
| `name`, `address`, `operator`, `url`, `phone` | fiche |
| `public` | `false` = réservé aux abonnés |
| `covered`, `kind` | parking fermé (`underground`, `multi-storey`, `rooftop`) ou `surface` — les parkings fermés portent un « P » |
| `prices` | `{ "15": 1.35, "60": 5.4, "1440": 48.6, … }` durée en minutes → prix en € (ou `null`) |
| `pricesDate`, `pricesSource` | fraîcheur et source des tarifs |
| `motoPrices` | idem pour les deux-roues motorisés |
| `estimate` | pour les parkings sans tarif ouvert : médiane des voisins (`{ "60", "1440", n, radiusM }`), à afficher « ≈ » |
| `places`, `placesPmr`, `placesMoto`, `placesVelo`, `placesEv`, `heightMax` | capacités |
| `motoAccess`, `veloAccess` | `true` / `false` / `null` (inconnu) |
| `subscriptions` | abonnements mensuels / annuels (`residentMonth`, `month`, `year`, `motoMonth`, `veloMonth`, `veloDay`, …) |
| `forfaits` | forfaits nuit / week-end (Saemes) |
| `sources` | toutes les sources fusionnées dans la fiche |

Prix pour une durée quelconque : `quoteCarPark(prices, minutes)` (interpolation au quart d'heure, cumul au-delà de 24 h).

## zones.geojson, belib.geojson, arrondissements.geojson, coverage-grid.geojson

- `zones` : `{ zone: 1 | 2 }`.
- `belib` : `{ name, address, pdc, kw, twoWheels, hours }` (une station par point).
- `arrondissements` : `{ ar, nom, label, coverage }` (part des mailles couvertes).
- `coverage-grid` : carrés de 200 m `{ ok: 0 | 1 }` (1 = prix connu à moins de 250 m).

## Sources amont

Paris Data (zones tarifaires, emprises, stationnement en ouvrage, horodateurs, Belib', arrondissements, marchés découverts),
open data Saemes, Parkings Indigo (APDS, transport.data.gouv.fr), Base nationale des lieux de stationnement,
OpenStreetMap (Overpass). Détails, licences et fraîcheur : `meta.sources` et [PLAN.md](../PLAN.md).
