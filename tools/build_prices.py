#!/usr/bin/env python3
"""
Build PokeScan's free price data from TCGCSV (https://tcgcsv.com), a daily
mirror of TCGplayer prices. Runs in GitHub Actions once a day.

Output (one JSON file per TCGplayer set, read by the app):
  out/groups.json        list of Pokémon sets (TCGplayer "groups")
  out/g/<groupId>.json   cards in the set, current prices and daily price history

History is stored compactly: [dayNumber, cents] only when the market price
changes (the app forward-fills). Daily points are kept for the last 120 days,
weekly before that, ~13 months in total.

Usage:
  python build_prices.py --data <existing data dir or ''> --out out [--backfill-days 366]
"""
import argparse, datetime as dt, json, os, shutil, subprocess, sys, tempfile, time, urllib.request

CATEGORY = 3  # Pokémon (English)
BASE = 'https://tcgcsv.com'
UA = 'PokeScan/1.0 (+https://github.com/chadant1/poke-scan)'
EPOCH = dt.date(2024, 1, 1)
KEEP_DAYS = 400
DAILY_DAYS = 120
PAUSE = 0.15


def day_num(d):
    return (d - EPOCH).days


def get(url, binary=False, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            time.sleep(PAUSE)
            return data if binary else json.loads(data)
        except Exception as e:  # noqa
            if i == tries - 1:
                raise
            print(f'  retry {url}: {e}', file=sys.stderr)
            time.sleep(2 + i * 3)


def results(payload):
    if isinstance(payload, dict):
        return payload.get('results') or []
    return payload or []


# ----------------------------------------------------------------- state

def load_state(data_dir):
    groups, meta = {}, {'lastDay': None}
    if data_dir and os.path.isfile(os.path.join(data_dir, 'groups.json')):
        gj = json.load(open(os.path.join(data_dir, 'groups.json')))
        meta = gj.get('meta', meta)
        for g in gj.get('groups', []):
            p = os.path.join(data_dir, 'g', f"{g['id']}.json")
            if os.path.isfile(p):
                groups[g['id']] = json.load(open(p))
    return groups, meta


def ensure_group(groups, gid):
    g = groups.get(gid)
    if g is None:
        g = groups[gid] = {'id': gid, 'name': '', 'abbr': '', 'published': None, 'products': [], 'prices': {}}
    return g


def apply_prices(groups, gid, rows, dnum):
    g = ensure_group(groups, gid)
    for r in rows:
        pid = str(r.get('productId'))
        sub = r.get('subTypeName') or 'Normal'
        m = r.get('marketPrice')
        low = r.get('lowPrice')
        ent = g['prices'].setdefault(pid, {}).setdefault(sub, {'m': None, 'l': None, 'h': []})
        ent['m'] = m
        ent['l'] = low
        if m is None:
            continue
        c = int(round(float(m) * 100))
        h = ent['h']
        if h and h[-1][0] >= dnum:
            continue  # already have this day (or newer)
        if not h or h[-1][1] != c:
            h.append([dnum, c])


def compact(groups, today_n):
    cutoff = today_n - KEEP_DAYS
    daily_from = today_n - DAILY_DAYS
    for g in groups.values():
        for subs in g['prices'].values():
            for ent in subs.values():
                h = ent['h']
                if not h:
                    continue
                # Drop points older than the window, but keep the last one before it (moved to the cutoff)
                old = [p for p in h if p[0] < cutoff]
                h = ([[cutoff, old[-1][1]]] if old else []) + [p for p in h if p[0] >= cutoff]
                # Weekly before the daily window: keep the last change within each week.
                out, week_of = [], {}
                for p in h:
                    if p[0] >= daily_from:
                        out.append(p)
                    else:
                        wk = p[0] // 7
                        if wk in week_of:
                            out[week_of[wk]] = [out[week_of[wk]][0], p[1]]
                        else:
                            week_of[wk] = len(out)
                            out.append(p)
                # Remove consecutive duplicates created by the merge.
                ded = []
                for p in out:
                    if not ded or ded[-1][1] != p[1]:
                        ded.append(p)
                ent['h'] = ded


# ----------------------------------------------------------------- sources

def fetch_groups():
    return results(get(f'{BASE}/tcgplayer/{CATEGORY}/groups'))


def fetch_products(gid):
    out = []
    for p in results(get(f'{BASE}/tcgplayer/{CATEGORY}/{gid}/products')):
        ext = {e.get('name'): e.get('value') for e in (p.get('extendedData') or [])}
        num = ext.get('Number')
        if not num:
            continue  # sealed products, accessories
        out.append([p.get('productId'), p.get('name') or '', num, ext.get('Rarity') or ''])
    return out


def fetch_prices(gid):
    return results(get(f'{BASE}/tcgplayer/{CATEGORY}/{gid}/prices'))


def backfill(groups, start, end):
    """Process TCGCSV daily archives for start..end (inclusive). Downloaded once only."""
    if not shutil.which('7z'):
        print('7z not found; skipping backfill', file=sys.stderr)
        return
    d = start
    while d <= end:
        name = f'prices-{d.isoformat()}.ppmd.7z'
        tmp = tempfile.mkdtemp()
        try:
            blob = get(f'{BASE}/archive/tcgplayer/{name}', binary=True)
            arc = os.path.join(tmp, name)
            open(arc, 'wb').write(blob)
            subprocess.run(['7z', 'x', '-y', f'-o{tmp}', arc], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            root = os.path.join(tmp, d.isoformat(), str(CATEGORY))
            n = 0
            if os.path.isdir(root):
                for gid in os.listdir(root):
                    f = os.path.join(root, gid, 'prices')
                    if os.path.isfile(f):
                        try:
                            apply_prices(groups, int(gid), results(json.load(open(f))), day_num(d))
                            n += 1
                        except Exception as e:  # noqa
                            print(f'  bad file {f}: {e}', file=sys.stderr)
            print(f'archive {d}: {n} sets')
        except Exception as e:  # noqa
            print(f'archive {d} failed: {e}', file=sys.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        d += dt.timedelta(days=1)


# ----------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='')
    ap.add_argument('--out', default='out')
    ap.add_argument('--backfill-days', type=int, default=0)
    a = ap.parse_args()

    groups, meta = load_state(a.data)
    today = dt.datetime.now(dt.timezone.utc).date()

    try:
        stamp = get(f'{BASE}/last-updated.txt', binary=True).decode().strip()
        print('TCGCSV last updated:', stamp)
        today = dt.date.fromisoformat(stamp[:10])
    except Exception as e:  # noqa
        print('could not read last-updated.txt:', e, file=sys.stderr)
    tn = day_num(today)

    # 1) Backfill from the archive (first run only, or when asked).
    if a.backfill_days > 0:
        first = today - dt.timedelta(days=a.backfill_days)
        first = max(first, dt.date(2024, 2, 8))
        last_done = meta.get('lastDay')
        if last_done is not None:
            first = max(first, EPOCH + dt.timedelta(days=last_done + 1))
        backfill(groups, first, today - dt.timedelta(days=1))

    # 2) Today's sets, cards and prices.
    glist = fetch_groups()
    print(f'{len(glist)} sets')
    for i, gr in enumerate(glist):
        gid = gr['groupId']
        g = ensure_group(groups, gid)
        g['name'] = gr.get('name') or g['name']
        g['abbr'] = gr.get('abbreviation') or ''
        g['published'] = (gr.get('publishedOn') or '')[:10] or None
        try:
            g['products'] = fetch_products(gid) or g['products']
            apply_prices(groups, gid, fetch_prices(gid), tn)
        except Exception as e:  # noqa
            print(f'  set {gid} failed: {e}', file=sys.stderr)
        if i % 25 == 0:
            print(f'  {i}/{len(glist)} {g["name"]}')

    compact(groups, tn)
    meta = {'lastDay': tn, 'updated': today.isoformat(), 'epoch': EPOCH.isoformat(), 'source': 'TCGCSV (TCGplayer prices)'}

    # 3) Write.
    os.makedirs(os.path.join(a.out, 'g'), exist_ok=True)
    listed = []
    for gid, g in sorted(groups.items()):
        if not g.get('name'):
            continue
        prod_ids = {str(p[0]) for p in g['products']}
        g['prices'] = {k: v for k, v in g['prices'].items() if k in prod_ids}
        with open(os.path.join(a.out, 'g', f'{gid}.json'), 'w') as f:
            json.dump(g, f, separators=(',', ':'))
        listed.append({'id': gid, 'name': g['name'], 'abbr': g['abbr'], 'published': g['published'], 'n': len(g['products'])})
    with open(os.path.join(a.out, 'groups.json'), 'w') as f:
        json.dump({'meta': meta, 'groups': listed}, f, separators=(',', ':'))
    print(f'wrote {len(listed)} sets for {today}')


if __name__ == '__main__':
    main()
