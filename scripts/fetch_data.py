#!/usr/bin/env python3
"""Pull official public data into site/data/*.json.

Every source runs on its own: if one fails, its previous file is kept and the
failure is recorded in site/data/meta.json. Standard library only.
Secrets: API_DATA_GOV_KEY (Congress.gov + FEC). It is redacted from all output.
"""
import csv, io, json, os, re, sys, time, traceback, datetime as dt
import urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'site', 'data')
DEBUG = os.path.join(ROOT, 'debug')
KEY = os.environ.get('API_DATA_GOV_KEY', '').strip()
UA = 'gov-tracker/1.0 (personal civic data project; https://github.com/G0ldenT41nt67/gov-tracker)'
NOW = dt.datetime.now(dt.timezone.utc)
TODAY = NOW.date()
CONGRESS = (TODAY.year - 1789) // 2 + 1
os.makedirs(OUT, exist_ok=True)
os.makedirs(DEBUG, exist_ok=True)


# ---------- helpers ----------
def redact(s):
    s = re.sub(r'api_key=[^&\s\'"]+', 'api_key=REDACTED', str(s))
    return s.replace(KEY, 'REDACTED') if KEY else s


def get(url, params=None, as_json=True, tries=4, timeout=90):
    if params:
        url += ('&' if '?' in url else '?') + urllib.parse.urlencode(params, doseq=True)
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA, 'Accept': 'application/json' if as_json else '*/*'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            return json.loads(body) if as_json else body.decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            last = f'HTTP {e.code}'
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(min(60, 3 * 2 ** i))
                continue
            raise RuntimeError(redact(f'HTTP {e.code} for {url}'))
        except Exception as e:  # network hiccup
            last = e
            time.sleep(2 * 2 ** i)
    raise RuntimeError(redact(f'Gave up on {url}: {last}'))


def num(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def load(name, default=None):
    try:
        with open(os.path.join(OUT, name + '.json')) as f:
            return json.load(f)
    except Exception:
        return default


def write(name, obj, folder=OUT):
    with open(os.path.join(folder, name + '.json'), 'w') as f:
        json.dump(obj, f, separators=(',', ':'), ensure_ascii=False)


def dbg(name, obj):
    with open(os.path.join(DEBUG, name + '.json'), 'w') as f:
        json.dump(obj, f, indent=1, ensure_ascii=False, default=str)


OLD_META = load('meta', {}) or {}
META = {'generated_at': NOW.isoformat(timespec='seconds'), 'congress': CONGRESS, 'sources': {}}


def run(name, fn):
    t = time.time()
    stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
    try:
        note = fn() or {}
        META['sources'][name] = {'ok': True, 'fetched_at': stamp, 'last_ok': stamp,
                                 'seconds': round(time.time() - t, 1), **note}
        print(f'[ok]   {name} ({time.time() - t:.0f}s) {note}')
    except Exception as e:
        prev = (OLD_META.get('sources') or {}).get(name, {})
        META['sources'][name] = {'ok': False, 'fetched_at': stamp, 'last_ok': prev.get('last_ok'),
                                 'error': redact(f'{type(e).__name__}: {e}'),
                                 'trace': redact(traceback.format_exc()[-1500:])}
        print(f'[FAIL] {name}: {redact(e)}')


# ---------- Money: Treasury Fiscal Data + USAspending ----------
FD = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service'


def fd_all(path, params):
    rows, page = [], 1
    while True:
        p = dict(params, **{'page[number]': page, 'page[size]': 10000})
        d = get(FD + path, p)
        rows += d.get('data', [])
        if page >= int((d.get('meta') or {}).get('total-pages') or 1):
            return rows
        page += 1


def parse_mts9(rs):
    """Monthly Treasury Statement table 9: receipts by source, outlays by function.
    Group headers (e.g. 'Social Insurance and Retirement Receipts:') carry no amount;
    their value is the sum of the deeper rows beneath them."""
    rs = sorted(rs, key=lambda r: num(r.get('src_line_nbr')) or num(r.get('sequence_number_cd')) or 0)
    sec, group = None, None
    out = {'receipts': [], 'outlays': [], 'totals': {}}
    for r in rs:
        d = (r.get('classification_desc') or '').strip()
        dl = d.lower()
        fytd = num(r.get('current_fytd_rcpt_outly_amt'))
        mon = num(r.get('current_month_rcpt_outly_amt'))
        lvl = int(num(r.get('sequence_level_nbr')) or 0)
        if group and lvl <= group['lvl']:
            group = None
        if fytd is None and mon is None:
            if dl.startswith('receipts'):
                sec = 'receipts'
            elif 'outlays' in dl:
                sec = 'outlays'
            elif sec:
                group = {'name': d.rstrip(':').strip(), 'lvl': lvl, 'fytd': 0.0, 'month': 0.0}
                out[sec].append(group)
            continue
        if dl.startswith('total'):
            if sec:
                out['totals'][sec] = {'fytd': fytd, 'month': mon}
            continue
        if 'surplus' in dl or 'deficit' in dl:
            out['totals']['deficit'] = {'fytd': fytd, 'month': mon}
            continue
        if not sec:
            continue
        if group and lvl > group['lvl']:
            group['fytd'] += fytd or 0
            group['month'] += mon or 0
        out[sec].append({'name': d, 'lvl': lvl, 'fytd': fytd, 'month': mon})
    for s in ('receipts', 'outlays'):
        if out[s]:
            top = min(i['lvl'] for i in out[s])
            out[s] = [i for i in out[s] if i['lvl'] == top]
    for k in ('fytd', 'month'):
        if 'deficit' not in out['totals'] and out['totals'].get('receipts') and out['totals'].get('outlays'):
            out['totals']['deficit'] = {}
        if out['totals'].get('deficit') is not None and out['totals']['deficit'].get(k) is None \
                and out['totals'].get('receipts') and out['totals'].get('outlays'):
            out['totals']['deficit'][k] = out['totals']['receipts'][k] - out['totals']['outlays'][k]
    return out


def money():
    rows = fd_all('/v1/accounting/mts/mts_table_9', {'filter': 'record_date:gte:2014-09-01'})
    by_date = {}
    for r in rows:
        by_date.setdefault(r['record_date'], []).append(r)
    dates = sorted(by_date)
    latest = dates[-1]
    dbg('mts9_latest_raw', [{k: r.get(k) for k in (
        'src_line_nbr', 'sequence_level_nbr', 'record_type_cd', 'classification_desc',
        'current_month_rcpt_outly_amt', 'current_fytd_rcpt_outly_amt')} for r in
        sorted(by_date[latest], key=lambda r: num(r.get('src_line_nbr')) or 0)])
    parsed = {d: parse_mts9(by_date[d]) for d in dates}
    checks = {}
    monthly, years = [], []
    for d in dates:
        p = parsed[d]
        t = p['totals']
        rec, outl = t.get('receipts', {}), t.get('outlays', {})
        if rec.get('month') is None or outl.get('month') is None:
            continue
        monthly.append({'date': d, 'receipts': rec['month'], 'outlays': outl['month'],
                        'deficit': (t.get('deficit') or {}).get('month', rec['month'] - outl['month'])})
        if d[5:7] == '09' or d == latest:
            fy = int(d[:4]) + (1 if d[5:7] in ('10', '11', '12') else 0)
            fsum = sum(i['fytd'] or 0 for i in p['outlays'])
            rsum = sum(i['fytd'] or 0 for i in p['receipts'])
            checks[d] = {'outlay_items_sum': fsum, 'outlay_total': outl.get('fytd'),
                         'receipt_items_sum': rsum, 'receipt_total': rec.get('fytd')}
            years.append({
                'fy': fy, 'as_of': d, 'complete': d[5:7] == '09',
                'receipts': rec.get('fytd'), 'outlays': outl.get('fytd'),
                'deficit': (t.get('deficit') or {}).get('fytd'),
                'functions': [{'name': i['name'], 'amount': i['fytd']} for i in p['outlays']],
                'sources': [{'name': i['name'], 'amount': i['fytd']} for i in p['receipts']],
            })
    dbg('mts9_checks', {'latest': latest, 'parsed_latest': parsed[latest], 'sum_checks': checks})
    # keep one entry per FY (a partial FY is replaced by its September close)
    fy_map = {}
    for y in years:
        if y['fy'] not in fy_map or y['complete']:
            fy_map[y['fy']] = y
    years = [fy_map[k] for k in sorted(fy_map)]

    debt_rows = fd_all('/v2/accounting/od/debt_to_penny', {
        'filter': 'record_date:gte:2005-01-01',
        'fields': 'record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt'})
    debt_rows.sort(key=lambda r: r['record_date'])
    month_end = {}
    for r in debt_rows:
        month_end[r['record_date'][:7]] = r
    hist = [{'date': r['record_date'], 'total': num(r['tot_pub_debt_out_amt'])} for r in month_end.values()]
    last = debt_rows[-1]
    debt = {'latest': {'date': last['record_date'], 'total': num(last['tot_pub_debt_out_amt']),
                       'public': num(last['debt_held_public_amt']),
                       'intragov': num(last['intragov_hold_amt'])}, 'history': hist}

    agencies = None
    try:
        a = get('https://api.usaspending.gov/api/v2/references/toptier_agencies/',
                {'sort': 'outlay_amount', 'order': 'desc'})
        res = a.get('results', [])
        agencies = {
            'fy': res[0].get('active_fy') if res else None,
            'fq': res[0].get('active_fq') if res else None,
            'items': [{'name': x.get('agency_name'), 'abbr': x.get('abbreviation'),
                       'code': x.get('toptier_code'), 'slug': x.get('agency_slug'),
                       'outlays': num(x.get('outlay_amount')),
                       'obligated': num(x.get('obligated_amount')),
                       'budget_authority': num(x.get('budget_authority_amount'))} for x in res]}
    except Exception as e:
        META.setdefault('warnings', []).append(redact(f'USAspending agencies: {e}'))
        agencies = (load('money', {}) or {}).get('agencies')

    write('money', {'years': years, 'monthly': monthly, 'debt': debt, 'agencies': agencies})
    return {'latest_mts': latest, 'debt_date': last['record_date'], 'fiscal_years': len(years)}


# ---------- Congress: Congress.gov API ----------
CG = 'https://api.congress.gov/v3'


def cg(path, **params):
    if not KEY:
        raise RuntimeError('API_DATA_GOV_KEY secret is missing')
    params.update({'api_key': KEY, 'format': 'json'})
    return get(CG + path, params)


def cg_pages(path, key, limit=250, max_items=1000, **params):
    items, off = [], 0
    while off < max_items:
        d = cg(path, limit=limit, offset=off, **params)
        got = d.get(key) or []
        items += got
        if len(got) < limit:
            break
        off += limit
    return items


STAGES = ['introduced', 'committee', 'passed_one', 'passed_both', 'to_president', 'law', 'vetoed']


def stage_of(text):
    t = (text or '').lower()
    if t.startswith('rule ') or t.startswith('rules committee'):
        return 'committee'
    if 'became public law' in t or 'became private law' in t or 'signed by president' in t:
        return 'law'
    if 'vetoed' in t or 'veto message' in t:
        return 'vetoed'
    if 'presented to president' in t:
        return 'to_president'
    if ('resolving differences' in t or 'cleared for white house' in t or 'agreed to house amendment' in t
            or 'agreed to senate amendment' in t or 'conference report' in t and 'agreed to' in t):
        return 'passed_both'
    if ('passed senate' in t or 'passed house' in t or 'received in the senate' in t
            or 'received in the house' in t or 'passed/agreed to' in t or 'on passage passed' in t
            or 'held at the desk' in t and 'message on' in t):
        return 'passed_one'
    if ('reported by' in t or 'ordered to be reported' in t or 'placed on' in t and 'calendar' in t
            or 'discharged' in t or 'reported (amended)' in t or 'reported with' in t
            or 'motion to proceed' in t or 'cloture' in t or 'considered' in t or 'rule ' in t
            or 'rules committee' in t or 'markup' in t or 'subcommittee hearings' in t
            or 'committee hearings held' in t):
        return 'committee'
    return 'introduced'


LAW_TYPES = {'HR', 'S', 'HJRES', 'SJRES'}


def bill_ref(b):
    t = (b.get('type') or '').upper()
    return {'congress': b.get('congress'), 'type': t, 'number': str(b.get('number')),
            'id': f"{t}{b.get('number')}".lower()}


def strip_html(s):
    s = re.sub(r'<(br|/p|/li)\s*/?>', '\n', s or '', flags=re.I)
    s = re.sub(r'<[^>]+>', '', s)
    s = re.sub(r'&nbsp;', ' ', s)
    s = re.sub(r'&amp;', '&', s)
    s = re.sub(r'&quot;', '"', s)
    s = re.sub(r'&#39;|&apos;', "'", s)
    s = re.sub(r'\n\s*\n+', '\n\n', s)
    return s.strip()


def congress_data():
    recent = cg_pages(f'/bill/{CONGRESS}', 'bills', max_items=1000, sort='updateDate desc')
    bills = []
    for b in recent:
        ref = bill_ref(b)
        la = b.get('latestAction') or {}
        bills.append({**ref, 'title': b.get('title'), 'chamber': b.get('originChamber'),
                      'latest_action': la.get('text'), 'latest_date': la.get('actionDate'),
                      'updated': b.get('updateDate'), 'stage': stage_of(la.get('text'))})
    stage_counts = {}
    for b in bills:
        stage_counts[b['stage']] = stage_counts.get(b['stage'], 0) + 1
    cutoff = (TODAY - dt.timedelta(days=120)).isoformat()
    moving = [b for b in bills if b['type'] in LAW_TYPES and b['stage'] != 'introduced'
              and (b['latest_date'] or '') >= cutoff]
    moving.sort(key=lambda b: (b['latest_date'] or '', STAGES.index(b['stage'])), reverse=True)
    moving = moving[:90]

    def detail(b):
        path = f"/bill/{b['congress']}/{b['type'].lower()}/{b['number']}"
        try:
            d = cg(path).get('bill', {})
            sp = (d.get('sponsors') or [{}])[0]
            b.update({
                'introduced': d.get('introducedDate'),
                'sponsor': {'id': sp.get('bioguideId'), 'name': sp.get('fullName'),
                            'party': sp.get('party'), 'state': sp.get('state'),
                            'district': sp.get('district')} if sp else None,
                'cosponsors': (d.get('cosponsors') or {}).get('count'),
                'policy_area': (d.get('policyArea') or {}).get('name'),
                'cbo': [{'date': c.get('pubDate', '')[:10], 'title': c.get('title'), 'url': c.get('url')}
                        for c in (d.get('cboCostEstimates') or [])],
                'laws': [f"{l.get('type', '')} {l.get('number', '')}".strip() for l in (d.get('laws') or [])],
                'actions_count': (d.get('actions') or {}).get('count'),
            })
            if (d.get('summaries') or {}).get('count'):
                ss = cg(path + '/summaries').get('summaries') or []
                if ss:
                    s = sorted(ss, key=lambda x: (x.get('actionDate') or '', x.get('updateDate') or ''))[-1]
                    b['summary'] = {'text': strip_html(s.get('text'))[:6000], 'as_of': s.get('actionDate'),
                                    'version': s.get('actionDesc')}
        except Exception as e:
            b['detail_error'] = redact(e)
        return b

    with ThreadPoolExecutor(6) as ex:
        moving = list(ex.map(detail, moving))

    laws_raw = cg_pages(f'/law/{CONGRESS}', 'bills', max_items=1500)
    laws = []
    for b in laws_raw:
        la = b.get('latestAction') or {}
        laws.append({**bill_ref(b), 'title': b.get('title'), 'date': la.get('actionDate'),
                     'law': ', '.join(f"{l.get('type', '')} {l.get('number', '')}".strip()
                                      for l in (b.get('laws') or []))})
    laws.sort(key=lambda x: x['date'] or '', reverse=True)
    dbg('congress_checks', {'recent_count': len(bills), 'stage_counts': stage_counts,
                            'moving': len(moving), 'laws': len(laws),
                            'sample_actions': [b['latest_action'] for b in bills[:40]]})
    old = load('congress', {}) or {}
    write('congress', {'congress': CONGRESS, 'moving': moving, 'laws': laws,
                       'recent_counts': stage_counts, 'votes': old.get('votes')})
    return {'moving': len(moving), 'laws': len(laws)}


# ---------- Members: unitedstates/congress-legislators + Congress.gov ----------
LEG = 'https://raw.githubusercontent.com/unitedstates/congress-legislators/gh-pages/'
PIECES = {}


def members_base():
    leg = get(LEG + 'legislators-current.json')
    cm = get(LEG + 'committee-membership-current.json')
    cmt = get(LEG + 'committees-current.json')
    names = {c['thomas_id']: c['name'] for c in cmt}
    roles = {}
    for cid, people in cm.items():
        if cid not in names:
            continue  # subcommittees skipped for now
        for p in people:
            roles.setdefault(p.get('bioguide'), []).append(
                {'id': cid, 'name': names[cid], 'title': p.get('title'), 'rank': p.get('rank')})
    out = []
    for m in leg:
        t = m['terms'][-1]
        same = [x for x in m['terms'] if x['type'] == t['type']]
        years = sum((min(dt.date.fromisoformat(x['end']), TODAY) - dt.date.fromisoformat(x['start'])).days
                    for x in m['terms'] if dt.date.fromisoformat(x['start']) <= TODAY) / 365.25
        bid = m['id']['bioguide']
        out.append({
            'id': bid, 'name': m['name'].get('official_full') or f"{m['name']['first']} {m['name']['last']}",
            'first': m['name'].get('nickname') or m['name']['first'], 'last': m['name']['last'],
            'chamber': 'Senate' if t['type'] == 'sen' else 'House',
            'state': t['state'], 'district': t.get('district'), 'senate_class': t.get('class'),
            'state_rank': t.get('state_rank'), 'party': t.get('party'),
            'term_start': t['start'], 'term_end': t['end'],
            'chamber_since': same[0]['start'][:4], 'years_in_congress': round(years, 1),
            'url': t.get('url'), 'phone': t.get('phone'), 'office': t.get('office') or t.get('address'),
            'contact_form': t.get('contact_form'),
            'leadership': [r.get('title') for r in (m.get('leadership_roles') or []) if not r.get('end')],
            'committees': sorted(roles.get(bid, []), key=lambda r: (r['title'] is None, r['name'])),
            'fec_ids': m['id'].get('fec') or [], 'icpsr': m['id'].get('icpsr'),
            'photo': f'https://unitedstates.github.io/images/congress/225x275/{bid}.jpg',
        })
    PIECES['base'] = out
    return {'members': len(out)}


def members_congress():
    if 'base' not in PIECES:
        raise RuntimeError('base member list unavailable')
    imgs = {}
    for m in cg_pages('/member', 'members', max_items=1000, currentMember='true'):
        u = (m.get('depiction') or {}).get('imageUrl')
        if u:
            imgs[m.get('bioguideId')] = u
    PIECES['images'] = imgs

    def sponsored(m):
        try:
            items = cg(f"/member/{m['id']}/sponsored-legislation", limit=250).get('sponsoredLegislation') or []
        except Exception as e:
            return m['id'], {'error': redact(e)}
        cur = [i for i in items if i.get('congress') == CONGRESS and i.get('type')]
        law = [i for i in cur if 'became public law' in ((i.get('latestAction') or {}).get('text') or '').lower()]
        cur.sort(key=lambda i: i.get('introducedDate') or '', reverse=True)
        return m['id'], {
            'sponsored': len(cur), 'became_law': len(law),
            'advanced': sum(1 for i in cur if stage_of((i.get('latestAction') or {}).get('text')) != 'introduced'),
            'recent': [{**bill_ref(i), 'title': i.get('title'), 'introduced': i.get('introducedDate'),
                        'latest_action': (i.get('latestAction') or {}).get('text'),
                        'latest_date': (i.get('latestAction') or {}).get('actionDate'),
                        'stage': stage_of((i.get('latestAction') or {}).get('text')),
                        'policy_area': (i.get('policyArea') or {}).get('name')} for i in cur[:8]],
            'laws': [{**bill_ref(i), 'title': i.get('title')} for i in law[:10]],
        }

    with ThreadPoolExecutor(6) as ex:
        res = dict(ex.map(sponsored, PIECES['base']))
    PIECES['bills'] = res
    errs = sum(1 for v in res.values() if 'error' in v)
    return {'images': len(imgs), 'sponsor_lookups': len(res), 'sponsor_errors': errs}


# ---------- Votes: Voteview (UCLA), built from official House Clerk / Senate records ----------
VV = 'https://voteview.com/static/data/out/'
PARTY = {'100': 'Democrat', '200': 'Republican', '328': 'Independent'}


def votes():
    c = CONGRESS
    rc = list(csv.DictReader(io.StringIO(get(f'{VV}rollcalls/HS{c}_rollcalls.csv', as_json=False))))
    mem = list(csv.DictReader(io.StringIO(get(f'{VV}members/HS{c}_members.csv', as_json=False))))
    vt = csv.DictReader(io.StringIO(get(f'{VV}votes/HS{c}_votes.csv', as_json=False)))
    who = {}
    for m in mem:
        if m['chamber'] in ('House', 'Senate'):
            who[(m['chamber'], m['icpsr'])] = {'bioguide': m.get('bioguide_id'), 'party': m.get('party_code')}
    tally = {}   # (chamber, roll) -> party -> [yea, nay, other]
    casts = []
    for v in vt:
        if v['chamber'] not in ('House', 'Senate'):
            continue
        cc = int(v['cast_code'] or 0)
        if cc == 0:
            continue
        pos = 'Y' if cc <= 3 else 'N' if cc <= 6 else 'P' if cc <= 8 else 'X'
        w = who.get((v['chamber'], v['icpsr']), {})
        key = (v['chamber'], v['rollnumber'])
        t = tally.setdefault(key, {}).setdefault(w.get('party') or '?', [0, 0, 0])
        t[0 if pos == 'Y' else 1 if pos == 'N' else 2] += 1
        casts.append((key, w.get('bioguide'), w.get('party'), pos))
    stats = {}
    for key, bid, party, pos in casts:
        if not bid:
            continue
        s = stats.setdefault(bid, {'eligible': 0, 'yea': 0, 'nay': 0, 'present': 0, 'missed': 0,
                                   'with_party': 0, 'party_comparable': 0})
        s['eligible'] += 1
        s[{'Y': 'yea', 'N': 'nay', 'P': 'present', 'X': 'missed'}[pos]] += 1
        if pos in 'YN' and party in tally.get(key, {}):
            y, n, _ = tally[key][party]
            if y != n:
                s['party_comparable'] += 1
                if (pos == 'Y') == (y > n):
                    s['with_party'] += 1
    for s in stats.values():
        s['missed_pct'] = round(100 * s['missed'] / s['eligible'], 1) if s['eligible'] else None
        s['with_party_pct'] = round(100 * s['with_party'] / s['party_comparable'], 1) if s['party_comparable'] else None
    PIECES['votes'] = stats

    recent = []
    for chamber in ('House', 'Senate'):
        rows = [r for r in rc if r['chamber'] == chamber]
        rows.sort(key=lambda r: (r['date'], int(r['rollnumber'])))
        for r in rows[-60:]:
            yr = r['date'][:4]
            n = r.get('clerk_rollnumber') or r['rollnumber']
            sess = r.get('session') or ('1' if int(yr) % 2 else '2')
            if chamber == 'House':
                link = f'https://clerk.house.gov/Votes/{yr}{n}'
            else:
                link = (f'https://www.senate.gov/legislative/LIS/roll_call_votes/vote{c}{sess}/'
                        f'vote_{c}_{sess}_{int(n):05d}.htm')
            split = {PARTY.get(p, 'Other'): {'yea': t[0], 'nay': t[1], 'other': t[2]}
                     for p, t in tally.get((chamber, r['rollnumber']), {}).items()}
            recent.append({'chamber': chamber, 'date': r['date'], 'roll': n, 'session': sess,
                           'question': r.get('vote_question'), 'desc': r.get('vote_desc') or r.get('dtl_desc'),
                           'result': r.get('vote_result'), 'bill': r.get('bill_number'),
                           'yea': int(num(r.get('yea_count')) or 0), 'nay': int(num(r.get('nay_count')) or 0),
                           'party_split': split, 'link': link})
    recent.sort(key=lambda v: (v['date'], v['chamber']), reverse=True)
    cdata = load('congress', {}) or {}
    cdata['votes'] = {'recent': recent, 'source_date': max((r['date'] for r in rc), default=None),
                      'totals': {ch: sum(1 for r in rc if r['chamber'] == ch) for ch in ('House', 'Senate')}}
    write('congress', cdata)
    return {'rollcalls': len(rc), 'latest_vote': cdata['votes']['source_date'], 'members_with_stats': len(stats)}


# ---------- Campaign finance: FEC ----------
FEC = 'https://api.open.fec.gov/v1'


def fec_cycle(m):
    if m['chamber'] == 'House':
        return TODAY.year + (TODAY.year % 2)
    return int(m['term_end'][:4]) - 1


def finance():
    if 'base' not in PIECES:
        raise RuntimeError('base member list unavailable')
    if not KEY:
        raise RuntimeError('API_DATA_GOV_KEY secret is missing')
    want = {}
    for m in PIECES['base']:
        pre = 'H' if m['chamber'] == 'House' else 'S'
        ids = [i for i in m['fec_ids'] if i.startswith(pre)]
        if ids:
            want.setdefault(fec_cycle(m), []).append((m['id'], ids))
    found, probe = {}, {}
    for cycle, group in want.items():
        idmap = {i: bid for bid, ids in group for i in ids}
        allids = list(idmap)
        for k in range(0, len(allids), 50):
            chunk = allids[k:k + 50]
            d = get(FEC + '/candidates/totals/', {'api_key': KEY, 'candidate_id': chunk, 'cycle': cycle,
                                                  'election_full': 'true', 'per_page': 100})
            res = d.get('results') or []
            probe.setdefault(str(cycle), []).append({'asked': len(chunk), 'got': len(res),
                                                     'keys': sorted(res[0].keys()) if res else []})
            for r in res:
                bid = idmap.get(r.get('candidate_id'))
                if not bid:
                    continue
                rec = {'fec_id': r.get('candidate_id'), 'cycle': r.get('cycle') or cycle,
                       'receipts': num(r.get('receipts')), 'disbursements': num(r.get('disbursements')),
                       'cash_on_hand': num(r.get('cash_on_hand_end_period')),
                       'individual_itemized': num(r.get('individual_itemized_contributions')),
                       'pac': num(r.get('other_political_committee_contributions')),
                       'coverage_end': (r.get('coverage_end_date') or '')[:10]}
                if bid not in found or (rec['receipts'] or 0) > (found[bid]['receipts'] or 0):
                    found[bid] = rec
            time.sleep(0.5)
    dbg('fec_probe', probe)
    if not found:
        raise RuntimeError('FEC returned no totals (batch lookup may be unsupported); see debug/fec_probe.json')
    PIECES['finance'] = found
    return {'members_with_finance': len(found)}


def assemble():
    if 'base' not in PIECES:
        raise RuntimeError('base member list unavailable')
    old = {m['id']: m for m in (load('members', {}) or {}).get('members', [])}
    imgs = PIECES.get('images', {})
    out = []
    for m in PIECES['base']:
        o = old.get(m['id'], {})
        rec = {k: v for k, v in m.items() if k not in ('fec_ids', 'icpsr')}
        if imgs.get(m['id']):
            rec['photo_alt'], rec['photo'] = rec['photo'], imgs[m['id']]
        b = PIECES.get('bills', {}).get(m['id'])
        rec['bills'] = b if b and 'error' not in b else o.get('bills')
        rec['votes'] = PIECES['votes'].get(m['id']) if 'votes' in PIECES else o.get('votes')
        rec['finance'] = PIECES['finance'].get(m['id']) if 'finance' in PIECES else o.get('finance')
        out.append(rec)
    out.sort(key=lambda m: (m['last'], m['first']))
    write('members', {'congress': CONGRESS, 'members': out})
    return {'members': len(out)}


if __name__ == '__main__':
    only = set(sys.argv[1:])
    steps = [('money', money), ('congress', congress_data), ('members_base', members_base),
             ('members_congress', members_congress), ('votes', votes), ('finance', finance),
             ('members', assemble)]
    for name, fn in steps:
        if not only or name in only:
            run(name, fn)
    for name, v in (OLD_META.get('sources') or {}).items():
        META['sources'].setdefault(name, v)
    write('meta', META)
    ok = sum(1 for s in META['sources'].values() if s.get('ok'))
    print(f'{ok}/{len(META["sources"])} sources ok')
