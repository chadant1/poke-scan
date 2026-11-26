# PokeScan — Pokémon card identifier & value checker

Point your phone's camera at a Pokémon card and PokeScan will:

- **Identify the card and its set** (e.g. *Mega Greninja ex – 116/086 – ME04: Chaos Rising*) by reading the name and collector number on the card.
- Show the **TCGplayer Near Mint market price**, the latest daily price, lowest listing, and the number of listings and sellers.
- Draw a **1-year price history graph** (1M / 3M / 6M / 1Y). Bars underneath show how many copies sold. Touch the graph to see the price on any day.
- Show a **1-year snapshot**: low and high market price, total copies sold and average sold per day.
- Show **graded values for PSA 8, PSA 9 and PSA 10** from recent eBay and Fanatics sold listings.
- List the **product details**: rarity, type, HP, stage, abilities, attacks, weakness, retreat cost and artist.
- Keep a **Recent** list of the cards you've scanned, with their combined value.
- **Light and dark mode**: follow the phone setting, or pick one with the sun/moon button or in Settings.

The camera picture is read **on your phone** and then discarded. It is never saved or uploaded. Only the card name and number are sent to the card and price services.

## Install it on your phone

**Android**
1. On your phone, open **https://github.com/chadant1/poke-scan/releases/latest/download/PokeScan.apk**.
2. Open the downloaded file and allow "install unknown apps" for your browser when asked.
3. Open PokeScan and allow the camera.

> Each build is signed with a fresh debug key. To install a newer build, uninstall the old one first.

**iPhone / iPad** (works on Android too)
1. Open **https://chadant1.github.io/poke-scan/** in **Safari**. GitHub Pages must be turned on for this repo: *Settings → Pages → Deploy from a branch → `main` / root*.
2. Tap **Share → Add to Home Screen**.
3. Open PokeScan from the home screen and allow the camera.

## Turn on prices, the graph and PSA values (free key)

TCGplayer no longer gives API access to new developers. PokeScan gets TCGplayer prices, price history and eBay graded sales from **[PokemonPriceTracker](https://www.pokemonpricetracker.com/api-signup)** instead.

1. Sign up for the **free** plan. No credit card is needed.
2. Copy your API key from their dashboard.
3. In PokeScan go to **Settings → Price data key**, paste the key, then tap **Save** and **Test key**.

The free plan gives **100 credits a day**:
- A card the app hasn't priced before uses about 10 credits, which works out to roughly 8–10 new cards a day.
- Opening a card again within 12 hours is free, because results are saved on the phone.
- If you need more, the $9.99/month plan gives 20,000 credits a day.

**Without a key**, PokeScan still identifies cards and shows TCGplayer's market, low, mid and high prices from TCGdex. It does not show the graph or graded prices.

## Scanning tips

- Fill the white frame with the card. The dashed boxes should cover the **name** at the top and the **card number** at the bottom.
- Avoid glare, especially on holo and full-art cards. Use the flashlight button in dim light.
- If the scanner isn't sure, it shows the closest matches to tap. You can also type the name and number yourself.
- You can read a saved photo with the picture button, or use the **Search** tab.
- *What the scanner read* (under the shutter) shows the exact text it picked up.

## How it works

| Step | Source |
|---|---|
| Read the name, number and set code | [Tesseract.js](https://github.com/naptha/tesseract.js), running on the phone |
| Match the number and set size (e.g. 116/**086**) to the set, then the card | [TCGdex API](https://tcgdex.dev) (free, open) |
| Near Mint market price, daily history and volume | PokemonPriceTracker `/cards?includeHistory=true` (TCGplayer data) |
| PSA 8 / 9 / 10 | PokemonPriceTracker `/cards?includeEbay=true` (eBay and Fanatics sold listings) |

It is a plain HTML/CSS/JavaScript app with no build step. The Android APK is the same app wrapped with Capacitor by GitHub Actions (`.github/workflows/android.yml`).

### Run it locally

```bash
python3 -m http.server 8000
# open http://localhost:8000 (the camera needs https or localhost)
```

### Files

```
index.html            app layout
css/app.css           light & dark themes
js/app.js             screens, camera, scan flow, card page
js/ocr.js             on-device text reading
js/parse.js           pulls the number / name / set code out of the text
js/identify.js        finds the exact card + set (TCGdex)
js/prices.js          prices, history and PSA values (PokemonPriceTracker)
js/chart.js           the price-history graph
sw.js                 offline support and caching
```

---

PokeScan is a personal, non-commercial project. It is not affiliated with Nintendo, The Pokémon Company, TCGplayer, eBay or PokemonPriceTracker. Card data comes from TCGdex. Prices come from PokemonPriceTracker under its free personal-use plan.
