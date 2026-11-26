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
import argparse, datetime as dt, json, os, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request

CATEGORY = 3  # Pokémon (English)
BASE = 'https://tcgcsv.com'
UA = 'PokeScan/1.0 (+https://github.com/chadant1/poke-scan)'
EPOCH = dt.date(2024, 1, 1)
KEEP_DAYS = 400
DAILY_DAYS = 120
PAUSE = 0.15


def day_num(d):
    return (d - EPOCH).days


class Throttled(Exception):
    pass


def get(url, binary=False, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            time.sleep(PAUSE)
            return data if binary else json.loads(data)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                raise Throttled(url)  # never hammer a server that asked us to slow down
            if e.code == 404 or i == tries - 1:
                raise
            print(f'  retry {url}: {e}', file=sys.stderr)
            time.sleep(2 + i * 3)
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
    groups, meta = {}, {'lastDay': None, 'firstDay': None}
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


ARCHIVE_PAUSE = 6      # seconds between archive downloads
CHUNK_DAYS = 45        # archive days per run at most


def dedupe(h):
    out = []
    for p in sorted(h, key=lambda x: x[0]):
        if out and out[-1][0] == p[0]:
            out[-1] = p
        elif not out or out[-1][1] != p[1]:
            out.append(p)
    return out


def backfill(groups, start, end):
    """
    Load TCGCSV daily archives for start..end, newest first, so whatever we get
    is a contiguous block ending at `end`. Stops politely at the first 429.
    Returns the earliest day loaded (or None). Each archive is downloaded once.
    """
    if not shutil.which('7z'):
        print('7z not found; skipping backfill', file=sys.stderr)
        return None
    work = tempfile.mkdtemp()
    got = []  # (date, folder) newest first
    d = end
    try:
        while d >= start:
            name = f'prices-{d.isoformat()}.ppmd.7z'
            try:
                blob = get(f'{BASE}/archive/tcgplayer/{name}', binary=True, tries=2)
            except Throttled:
                print(f'archive server asked us to slow down at {d}; will continue next run')
                break
            except urllib.error.HTTPError as e:
                print(f'archive {d}: HTTP {e.code} (skipped)')
                got.append((d, None))
                d -= dt.timedelta(days=1)
                continue
            arc = os.path.join(work, name)
            open(arc, 'wb').write(blob)
            out = os.path.join(work, d.isoformat() + '_x')
            subprocess.run(['7z', 'x', '-y', f'-o{out}', arc], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.remove(arc)
            got.append((d, os.path.join(out, d.isoformat(), str(CATEGORY))))
            print(f'archive {d}: ok')
            d -= dt.timedelta(days=1)
            time.sleep(ARCHIVE_PAUSE)

        if not got:
            return None
        # Build the block's series oldest -> newest, then put it in front of what we have.
        block = {}
        for day, root in sorted(got):
            if not root or not os.path.isdir(root):
                continue
            dn = day_num(day)
            for gid in os.listdir(root):
                f = os.path.join(root, gid, 'prices')
                if not os.path.isfile(f):
                    continue
                try:
                    rows = results(json.load(open(f)))
                except Exception as e:  # noqa
                    print(f'  bad file {f}: {e}', file=sys.stderr)
                    continue
                for r in rows:
                    m = r.get('marketPrice')
                    if m is None:
                        continue
                    key = (int(gid), str(r.get('productId')), r.get('subTypeName') or 'Normal')
                    h = block.setdefault(key, [])
                    c = int(round(float(m) * 100))
                    if not h or h[-1][1] != c:
                        h.append([dn, c])
            shutil.rmtree(os.path.dirname(os.path.dirname(root)), ignore_errors=True)
        for (gid, pid, sub), h in block.items():
            g = ensure_group(groups, gid)
            ent = g['prices'].setdefault(pid, {}).setdefault(sub, {'m': None, 'l': None, 'h': []})
            ent['h'] = dedupe(h + ent['h'])
        return min(day for day, _ in got)
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ----------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='')
    ap.add_argument('--out', default='out')
    ap.add_argument('--backfill-days', type=int, default=0)
    ap.add_argument('--force-sync', action='store_true')
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
    changed = False

    # 1) Today's sets, cards and prices (once per TCGCSV update).
    if meta.get('lastDay') is None or tn > meta['lastDay'] or a.force_sync:
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
            except Throttled:
                print('  TCGCSV asked us to slow down; keeping yesterday\'s data for the rest')
                break
            except Exception as e:  # noqa
                print(f'  set {gid} failed: {e}', file=sys.stderr)
            if i % 25 == 0:
                print(f'  {i}/{len(glist)} {g["name"]}')
        meta['lastDay'] = tn
        if meta.get('firstDay') is None:
            meta['firstDay'] = tn
        changed = True
    else:
        print('No new TCGCSV data since the last run.')

    # 2) Fill in the past year from the archive, a chunk per run.
    target = max(today - dt.timedelta(days=a.backfill_days), dt.date(2024, 2, 8)) if a.backfill_days > 0 else None
    first = EPOCH + dt.timedelta(days=meta['firstDay']) if meta.get('firstDay') is not None else today
    if target and first > target:
        end = first - dt.timedelta(days=1)
        start = max(target, end - dt.timedelta(days=CHUNK_DAYS - 1))
        print(f'Backfilling {start} .. {end}')
        earliest = backfill(groups, start, end)
        if earliest is not None:
            meta['firstDay'] = day_num(earliest)
            changed = True
    meta['backfillComplete'] = bool(target) and meta.get('firstDay') is not None and meta['firstDay'] <= day_num(target)

    if not changed and a.data:
        print('Nothing new; not publishing.')
        os.makedirs(a.out, exist_ok=True)
        open(os.path.join(a.out, '.nothing-new'), 'w').write('1')
        return

    compact(groups, tn)
    meta.update({'updated': (EPOCH + dt.timedelta(days=meta['lastDay'])).isoformat(),
                 'epoch': EPOCH.isoformat(), 'source': 'TCGCSV (TCGplayer prices)'})

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
