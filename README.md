# PokeScan — Pokémon card identifier & value checker

Point your phone's camera at a Pokémon card and PokeScan will:

- **Identify the card and its set** (e.g. *Mega Greninja ex – 116/086 – ME04: Chaos Rising*) by reading the name and collector number on the card.
- Show the **TCGplayer Near Mint market price**, the lowest listing, and reverse-holo and other printings.
- Draw a **1-year price history graph** (1M / 3M / 6M / 1Y). Touch the graph to see the price on any day.
- Show a **1-year snapshot**: low and high market price, and the change over the year.
- Show **PSA 8, PSA 9 and PSA 10** values from recent eBay and Fanatics sales (optional free key), or link straight to eBay sold listings.
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

## Where the prices come from (free)

TCGplayer no longer gives API access to new developers. PokeScan uses these sources instead:

- **Near Mint market price and the 1-year graph** come from [TCGCSV](https://tcgcsv.com), a free daily copy of TCGplayer's prices.
  - TCGCSV blocks browser apps, so a GitHub Action in this repo (`.github/workflows/prices.yml`) collects the Pokémon prices once a day.
  - It publishes them to this repo's **`data`** branch, and the app reads them from there.
  - The first run loads the past year from TCGCSV's daily archive. That archive is downloaded only once.
  - No key and no fee.
- **PSA 8 / 9 / 10 is optional.** No free service offers graded prices without signing up. PokemonPriceTracker has a **Free plan ($0, no credit card)** that includes PSA prices.
  - Paste its key in **Settings → PSA 8 / 9 / 10 prices**.
  - Each card uses 2 of the 100 daily free credits, so about 50 cards a day.
  - Without a key, the PSA buttons open recent eBay sold listings for that card and grade.
- **No data yet?** If the free data isn't available for a card yet, for example a brand-new set, the app shows the current TCGplayer price from TCGdex instead.

> GitHub pauses scheduled jobs in a repo after 60 days without activity. The daily price commits keep it active. If prices ever stop updating, open **Actions → Update prices → Run workflow**.

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
| Near Mint market price and daily history | TCGCSV, collected nightly by `tools/build_prices.py` to the `data` branch |
| PSA 8 / 9 / 10 (optional) | PokemonPriceTracker free plan, `/cards/{tcgplayerId}?includeEbay=true` |

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
js/market.js          free TCGplayer prices + history (data branch)
js/prices.js          combines prices; PSA values (PokemonPriceTracker)
tools/build_prices.py nightly price collector (GitHub Action)
js/chart.js           the price-history graph
sw.js                 offline support and caching
```

---

PokeScan is a personal, non-commercial project. It is not affiliated with Nintendo, The Pokémon Company, TCGplayer, eBay or PokemonPriceTracker. Card data comes from TCGdex. Prices come from TCGplayer via TCGCSV (thank you!). PSA values come from PokemonPriceTracker under its free personal-use plan.
