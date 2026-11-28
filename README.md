# PokeScan price data
Built automatically every day by `.github/workflows/prices.yml` from [TCGCSV](https://tcgcsv.com), a free daily mirror of TCGplayer prices. Thank you, TCGCSV!
- `groups.json` lists the Pokémon sets.
- `g/<groupId>.json` has each set's cards, current Near Mint market and low prices, and daily price history (`[day since 2024-01-01, cents]`, stored only when the price changes).
