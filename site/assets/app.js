/* Gov Tracker — plain JS, no build step. Data lives in data/*.json (pulled by scripts/fetch_data.py)
   and content/*.json (written by hand). Party information carries the class "party" and stays hidden
   unless the reader turns it on. */
{
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('gt.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gt.' + k, JSON.stringify(v)); } catch {} }
};
const D = {};               // loaded data
const UI = {};              // per-view state that survives re-render

/* ---------- formatting ---------- */
function money(v, digits) {
  if (v == null || isNaN(v)) return '—';
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e12) return `${s}$${(a / 1e12).toFixed(digits ?? 2)}T`;
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(digits ?? (a >= 1e11 ? 0 : 1))}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(digits ?? 1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(digits ?? 0)}K`;
  return `${s}$${a.toFixed(0)}`;
}
const pct = (v, d = 1) => v == null || isNaN(v) ? '—' : `${v.toFixed(d)}%`;
const n0 = v => v == null ? '—' : Number(v).toLocaleString('en-US');
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function date(s, withYear = true) {
  if (!s) return '—';
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${withYear ? ', ' + y : ''}`;
}
const monthYr = s => { const [y, m] = s.split('-'); return `${MONTHS[+m - 1]} ${y}`; };
const daysAgo = s => s ? Math.floor((Date.now() - new Date(s.slice(0, 10) + 'T12:00:00').getTime()) / 864e5) : 1e9;
const plural = (n, w) => `${n0(n)} ${w}${n === 1 ? '' : 's'}`;
const BILL_PREFIX = {HR: 'H.R.', S: 'S.', HJRES: 'H.J.Res.', SJRES: 'S.J.Res.', HRES: 'H.Res.', SRES: 'S.Res.', HCONRES: 'H.Con.Res.', SCONRES: 'S.Con.Res.'};
const billName = b => `${BILL_PREFIX[b.type] || b.type} ${b.number}`;
const CG_TYPE = {HR: 'house-bill', S: 'senate-bill', HJRES: 'house-joint-resolution', SJRES: 'senate-joint-resolution', HRES: 'house-resolution', SRES: 'senate-resolution', HCONRES: 'house-concurrent-resolution', SCONRES: 'senate-concurrent-resolution'};
const ord = n => { const s = ['th','st','nd','rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const billUrl = b => `https://www.congress.gov/bill/${ord(+b.congress)}-congress/${CG_TYPE[b.type] || 'bill'}/${b.number}`;
const PARTY_ABBR = {Democrat: 'D', Republican: 'R', Independent: 'I', Libertarian: 'L'};
const partyChip = p => p ? `<span class="pchip party" title="${esc(p)}">${esc(PARTY_ABBR[p] || p[0] || '?')}</span>` : '';
const src = (label, url) => `<span class="src">Source: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a></span>`;

const ext = url => url.startsWith('#') ? '' : ' target="_blank" rel="noopener"';
const links = ls => (ls || []).length ? `<div class="links">${ls.map(l => `<a href="${esc(l.url)}"${ext(l.url)}>${esc(l.label)}</a>`).join('')}</div>` : '';
const FLAG = {accurate: 'Accurate', missing_context: 'Missing context', misleading: 'Misleading framing', contradicted: 'Contradicted by the record', unverified: 'Unverified'};
function noteCard(n) {
  return `<article class="card note" id="note-${esc(n.id)}"><div class="meta">${n.status === 'developing' ? '<span class="chip dev">Developing · confirmed facts only</span>' : '<span class="chip">Settled</span>'}</div>
    <h3>${esc(n.title)}</h3><p>${esc(n.text)}</p>${n.party_note ? `<p class="party blk pnote">${esc(n.party_note)}</p>` : ''}${links(n.links)}</article>`;
}
function devCard(d) {
  return `<article class="card dev-card"><div class="card-h" style="margin-bottom:6px"><h3 style="margin:0">${esc(d.title)}</h3><span class="chip ${d.status === 'developing' ? 'dev' : ''}">${d.status === 'developing' ? 'Developing' : 'Settled, follow-up below'}</span></div>
    <div class="src">Tracking since ${date(d.opened)} · last checked ${date(d.last_checked)}</div>
    <div class="grid g2" style="gap:16px;margin-top:10px"><div><div class="lbl small"><b>Confirmed</b></div><ul class="tight">${(d.confirmed || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
    <div><div class="lbl small"><b>Not yet known</b></div><ul class="tight">${(d.unknown || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></div>
    ${d.followup ? `<div class="notice"><b>Follow-up, ${date(d.followup.date)}:</b> ${esc(d.followup.text)}${(d.followup.early_errors || []).length ? `<br><b>What early reporting got wrong:</b> ${d.followup.early_errors.map(esc).join(' ')}` : ''}</div>` : ''}${links(d.links)}</article>`;
}
function checkCard(c) {
  return `<article class="card check"><div class="meta"><span class="flagtag f-${esc(c.label)}">${esc(FLAG[c.label] || c.label)}</span><span>${esc(c.outlet)} · ${esc(c.story)} · checked ${date(c.date)}</span></div>
    <p class="claim">${esc(c.claim)}</p><p>${esc(c.explanation)}</p>${links(c.evidence)}</article>`;
}
/* ---------- states ---------- */
const STATES = {AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',AS:'American Samoa',GU:'Guam',MP:'Northern Mariana Islands',PR:'Puerto Rico',VI:'U.S. Virgin Islands'};
// tile-grid map: [row, col]
const TILES = {AK:[0,0],ME:[0,10],WI:[1,5],VT:[1,9],NH:[1,10],WA:[2,0],ID:[2,1],MT:[2,2],ND:[2,3],MN:[2,4],IL:[2,5],MI:[2,6],NY:[2,8],MA:[2,9],
  OR:[3,0],NV:[3,1],WY:[3,2],SD:[3,3],IA:[3,4],IN:[3,5],OH:[3,6],PA:[3,7],NJ:[3,8],CT:[3,9],RI:[3,10],
  CA:[4,0],UT:[4,1],CO:[4,2],NE:[4,3],MO:[4,4],KY:[4,5],WV:[4,6],VA:[4,7],MD:[4,8],DE:[4,9],
  AZ:[5,1],NM:[5,2],KS:[5,3],AR:[5,4],TN:[5,5],NC:[5,6],SC:[5,7],DC:[5,8],OK:[6,3],LA:[6,4],MS:[6,5],AL:[6,6],GA:[6,7],
  HI:[7,0],TX:[7,3],FL:[7,8],AS:[8,6],GU:[8,7],MP:[8,8],PR:[8,9],VI:[8,10]};

/* ---------- plain-English notes on federal budget categories (OMB budget functions) ---------- */
const FUNC_NOTES = [
  ['social security', 'Retirement, survivor and disability checks paid from the Social Security trust funds.'],
  ['medicare', 'Health insurance for people 65 and older and some people with disabilities.'],
  ['health', 'Mostly Medicaid (shared with states), plus health research (NIH), public health and marketplace insurance subsidies.'],
  ['income security', 'Federal worker retirement and disability, unemployment insurance, food assistance (SNAP), housing aid, and the refundable parts of tax credits.'],
  ['net interest', 'Interest paid on the national debt held by the public, minus interest the government earns.'],
  ['national defense', 'The military: pay, operations, weapons and equipment, plus the Energy Department’s nuclear weapons programs.'],
  ['veterans', 'VA health care, disability compensation, pensions and education benefits for veterans.'],
  ['education', 'Grants to schools, student aid, job training and social services programs.'],
  ['transportation', 'Highways, transit, air traffic control and aviation safety, rail and maritime programs.'],
  ['international', 'Foreign aid, embassies and diplomacy, and international security assistance.'],
  ['justice', 'Federal law enforcement and border security, federal courts and prisons.'],
  ['agriculture', 'Farm income support, crop insurance and agricultural research.'],
  ['natural resources', 'Environmental protection, national parks and public lands, water projects and conservation.'],
  ['community', 'Disaster relief, community development grants and regional development programs.'],
  ['science', 'NASA, the National Science Foundation and other basic research.'],
  ['general government', 'Running the government itself: Congress, the White House, tax collection, federal buildings.'],
  ['energy', 'Energy research and programs, and federal power marketing.'],
  ['commerce', 'Housing and mortgage credit programs, the Postal Service, deposit insurance and business programs. Often small or negative because of fees and repayments.'],
  ['offsetting', 'Money the government collects that is subtracted from spending rather than counted as revenue, like federal agencies’ retirement contributions and oil and gas royalties. Usually negative.'],
];
const funcNote = name => (FUNC_NOTES.find(([k]) => name.toLowerCase().includes(k)) || [, ''])[1];
const PALETTE = ['#2f5d4e','#b5741a','#6f7f3a','#c99b45','#47786a','#8a6440','#9fb08b','#d6b26e','#5b6a4d','#b8834f','#3c4a42','#a0956c','#6e8f80','#e2c890','#7b5a37','#88a59a','#c4a77a','#55624f','#d9c5a0'];
const LITE = new Set(['#c99b45','#9fb08b','#d6b26e','#a0956c','#e2c890','#88a59a','#c4a77a','#d9c5a0']);

/* ---------- data loading ---------- */
async function getJSON(path) {
  try { const r = await fetch(path, {cache: 'no-cache'}); return r.ok ? r.json() : null; } catch { return null; }
}
async function loadAll() {
  const names = ['meta', 'money', 'congress', 'members'];
  const [meta, mon, cong, mem, content, changelog] = await Promise.all([
    ...names.map(n => getJSON(`data/${n}.json`)), getJSON('content/content.json'), getJSON('content/changelog.json')]);
  Object.assign(D, {meta, money: mon, congress: cong, members: mem?.members || [], content, changelog});
  D.byId = Object.fromEntries(D.members.map(m => [m.id, m]));
}

/* ---------- small chart helpers ---------- */
function squarify(items, W, H) {
  const total = items.reduce((a, b) => a + b.value, 0);
  let rest = items.map(i => ({...i, area: i.value / total * W * H})), row = [], r = {x: 0, y: 0, w: W, h: H};
  const out = [];
  const worst = (row, side) => {
    const s = row.reduce((a, b) => a + b.area, 0), mx = Math.max(...row.map(x => x.area)), mn = Math.min(...row.map(x => x.area));
    return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn));
  };
  const lay = () => {
    const s = row.reduce((a, b) => a + b.area, 0);
    if (r.w >= r.h) { const cw = s / r.h; let y = r.y; row.forEach(it => { const ch = it.area / cw; out.push({...it, x: r.x, y, w: cw, h: ch}); y += ch; }); r = {x: r.x + cw, y: r.y, w: r.w - cw, h: r.h}; }
    else { const ch = s / r.w; let x = r.x; row.forEach(it => { const cw = it.area / ch; out.push({...it, x, y: r.y, w: cw, h: ch}); x += cw; }); r = {x: r.x, y: r.y + ch, w: r.w, h: r.h - ch}; }
    row = [];
  };
  while (rest.length) {
    const side = Math.min(r.w, r.h);
    if (!row.length || worst([...row, rest[0]], side) <= worst(row, side)) row.push(rest.shift());
    else lay();
  }
  if (row.length) lay();
  return out;
}

const observers = [];
function chart(el, draw) {           // redraw on resize
  const ro = new ResizeObserver(() => draw(el.clientWidth, el.clientHeight));
  ro.observe(el); observers.push(ro);
}
function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); return Math.ceil(v / p / (v / p > 5 ? 1 : .5)) * p * (v / p > 5 ? 1 : .5); }

function barChart(el, data, {series, fmt = money, tipLabel}) {   // grouped bars
  const tip = document.createElement('div'); tip.className = 'tip'; el.appendChild(tip);
  chart(el, (W, H) => {
    const pad = {l: 56, r: 8, t: 10, b: 26}, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const mx = niceMax(Math.max(...data.flatMap(d => series.map(s => d[s.key])))) || 1;
    const bw = iw / data.length, gw = Math.max(2, bw * .8 / series.length);
    let g = '<g class="grid">';
    for (let i = 0; i <= 4; i++) { const y = pad.t + ih - ih * i / 4; g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/><text class="axis" x="${pad.l - 8}" y="${y + 4}" text-anchor="end">${fmt(mx * i / 4, 0)}</text>`; }
    g += '</g>';
    let bars = '';
    data.forEach((d, i) => {
      series.forEach((s, j) => {
        const h = ih * (d[s.key] || 0) / mx, x = pad.l + i * bw + bw * .1 + j * gw;
        bars += `<rect x="${x}" y="${pad.t + ih - h}" width="${gw - 1}" height="${Math.max(0, h)}" rx="2" fill="${s.color}" data-i="${i}"/>`;
      });
      const every = Math.ceil(data.length / Math.max(2, Math.floor(iw / 70)));
      if (i % every === 0) bars += `<text class="axis" x="${pad.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
    });
    el.querySelector('svg')?.remove();
    el.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 ${W} ${H}">${g}${bars}</svg>`);
    el.querySelectorAll('rect[data-i]').forEach(r => {
      r.addEventListener('mousemove', e => { const d = data[+r.dataset.i]; tip.innerHTML = tipLabel(d); const b = el.getBoundingClientRect(); tip.style.left = (e.clientX - b.left) + 'px'; tip.style.top = (e.clientY - b.top) + 'px'; tip.style.opacity = 1; });
      r.addEventListener('mouseleave', () => tip.style.opacity = 0);
    });
  });
}

function lineChart(el, pts, {fmt = money, color = 'var(--ochre)', label = d => d.label}) {
  const tip = document.createElement('div'); tip.className = 'tip'; el.appendChild(tip);
  chart(el, (W, H) => {
    const pad = {l: 60, r: 10, t: 10, b: 26}, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const mx = niceMax(Math.max(...pts.map(p => p.v)));
    const X = i => pad.l + iw * i / (pts.length - 1), Y = v => pad.t + ih - ih * v / mx;
    let g = '<g class="grid">';
    for (let i = 0; i <= 4; i++) { const y = Y(mx * i / 4); g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/><text class="axis" x="${pad.l - 8}" y="${y + 4}" text-anchor="end">${fmt(mx * i / 4, 0)}</text>`; }
    g += '</g>';
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    let ticks = '', lastYr = '';
    pts.forEach((p, i) => { const yr = p.date.slice(0, 4); if (yr !== lastYr && +yr % 2 === 0 && X(i) > pad.l + 10) ticks += `<text class="axis" x="${X(i)}" y="${H - 6}" text-anchor="middle">${yr}</text>`; lastYr = yr; });
    el.querySelector('svg')?.remove();
    el.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 ${W} ${H}">${g}<path d="${d}L${X(pts.length - 1)},${pad.t + ih}L${pad.l},${pad.t + ih}Z" fill="${color}" opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2.5"/>${ticks}<circle r="5" fill="${color}" opacity="0"/><rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`);
    const svg = el.querySelector('svg'), dot = svg.querySelector('circle');
    svg.querySelector('rect').addEventListener('mousemove', e => {
      const b = svg.getBoundingClientRect(), i = Math.max(0, Math.min(pts.length - 1, Math.round((e.clientX - b.left - pad.l) / iw * (pts.length - 1))));
      dot.setAttribute('cx', X(i)); dot.setAttribute('cy', Y(pts[i].v)); dot.setAttribute('opacity', 1);
      tip.innerHTML = `${label(pts[i])}: <b>${fmt(pts[i].v)}</b>`; tip.style.left = X(i) + 'px'; tip.style.top = Y(pts[i].v) + 'px'; tip.style.opacity = 1;
    });
    svg.querySelector('rect').addEventListener('mouseleave', () => { tip.style.opacity = 0; dot.setAttribute('opacity', 0); });
  });
}

/* ---------- shared pieces ---------- */
const STEP = [['introduced','Introduced'],['committee','Committee / floor action'],['passed_one','Passed one chamber'],['passed_both','Passed both'],['law','Law']];
const STAGE_LABEL = {introduced: 'Introduced', committee: 'Committee or floor action', passed_one: 'Passed one chamber', passed_both: 'Passed both chambers', to_president: 'Sent to the President', law: 'Became law', vetoed: 'Vetoed'};
function stages(stage) {
  const map = {introduced: 0, committee: 1, passed_one: 2, passed_both: 3, to_president: 3, law: 4, vetoed: 3};
  const at = map[stage] ?? 0;
  return `<div class="stages" aria-label="Progress: ${esc(STAGE_LABEL[stage] || stage)}">${STEP.map(([, l], i) =>
    `<div class="st ${i < at ? 'done' : ''} ${i === at ? 'now done' : ''}"><span class="dot"></span>${i === 3 && stage === 'to_president' ? 'Sent to President' : i === 3 && stage === 'vetoed' ? 'Vetoed' : l}</div>`).join('')}</div>`;
}
function billCard(b, {summary = true} = {}) {
  const sp = b.sponsor, m = sp && D.byId[sp.id];
  return `<article class="card bill">
    <div class="bill-top"><div>
      <div class="meta"><span class="bid">${esc(billName(b))}</span>${b.policy_area ? `<span class="chip">Topic: ${esc(b.policy_area)}</span>` : ''}${b.stage === 'law' ? '<span class="chip law">Enacted</span>' : ''}${(b.cbo || []).length ? `<a class="chip cbo" href="${esc(b.cbo[0].url)}" target="_blank" rel="noopener">CBO cost estimate</a>` : ''}</div>
      <h3><a href="${billUrl(b)}" target="_blank" rel="noopener">${esc(b.title)}</a></h3>
      ${sp ? `<div class="meta">Sponsor: ${m ? `<a href="#member-${esc(sp.id)}">${esc(m.name)}</a>` : esc((sp.name || '').replace(/\s*\[.*\]$/, ''))} ${partyChip(m?.party || ({D:'Democrat',R:'Republican',I:'Independent'})[sp.party])} · ${esc(sp.state || '')}${b.cosponsors ? ` · ${plural(b.cosponsors, 'cosponsor')}` : ''}${b.introduced ? ` · introduced ${date(b.introduced)}` : ''}</div>` : ''}
    </div></div>
    ${stages(b.stage)}
    <div class="latest"><b>${date(b.latest_date)}:</b> ${esc(b.latest_action)}</div>
    ${summary && b.summary ? `<details class="sum"><summary>Official summary (Congressional Research Service, ${esc(b.summary.version || 'latest version')})</summary><div class="txt">${esc(b.summary.text)}</div></details>` : ''}
  </article>`;
}
function voteRow(v) {
  const tot = (v.yea + v.nay) || 1;
  const split = Object.entries(v.party_split || {}).filter(([p]) => p !== 'Other' || true)
    .map(([p, s]) => `<span>${esc(p)}: ${s.yea} yea, ${s.nay} nay${s.other ? `, ${s.other} not voting/present` : ''}</span>`).join('');
  return `<article class="card vote">
    <div class="when"><b>${date(v.date, false)}</b>${esc(v.chamber)}<br>Roll call ${esc(v.roll)}</div>
    <div><div class="q">${esc(v.question || 'Vote')}${v.bill ? ` · <span class="bid">${esc(v.bill)}</span>` : ''}</div><div class="d">${esc(v.desc || '')}</div>
      <div class="split party blk">${split}</div></div>
    <div><div class="yn"><span class="y" style="width:${v.yea / tot * 100}%"></span><span class="n" style="width:${v.nay / tot * 100}%"></span></div>
      <div class="ynl"><span>${v.yea} yea</span><span>${v.nay} nay</span></div>
      <div class="res">${esc(v.result || '')} · <a href="${esc(v.link)}" target="_blank" rel="noopener">official record</a></div></div>
  </article>`;
}
function photo(m, cls = 'ph') {
  const ini = esc((m.first || '?')[0] + (m.last || '?')[0]);
  return `<span class="${cls}"><img src="${esc(m.photo)}" alt="" loading="lazy" onerror="if(this.dataset.alt!=='1'&&'${esc(m.photo_alt || '')}'){this.dataset.alt='1';this.src='${esc(m.photo_alt || '')}'}else{this.replaceWith(document.createTextNode('${ini}'))}"></span>`;
}
const seat = m => m.chamber === 'Senate' ? `Senator, ${STATES[m.state] || m.state}` : `Representative, ${m.state}${m.district === 0 ? ' at-large' : '-' + m.district}`;
function memberCard(m) {
  return `<a class="card mcard" href="#member-${esc(m.id)}">${photo(m)}<div><div class="nm">${esc(m.name)} ${partyChip(m.party)}</div><div class="ds">${esc(seat(m))}</div>${m.leadership?.length ? `<div class="ds">${esc(m.leadership[0])}</div>` : ''}</div></a>`;
}
function delegation() {
  const h = store.get('home', null);
  if (!h?.state) return null;
  return D.members.filter(m => m.state === h.state && (m.chamber === 'Senate' || h.district == null || m.district === h.district))
    .sort((a, b) => a.chamber.localeCompare(b.chamber) * -1);
}
function fyLatest() {
  const ys = D.money?.years || [];
  return {done: [...ys].reverse().find(y => y.complete), cur: ys[ys.length - 1]};
}

/* ---------- views ---------- */
const V = {};

V.week = () => {
  const {done, cur} = fyLatest(), prev = done && D.money.years.find(y => y.fy === done.fy - 1);
  const debt = D.money?.debt?.latest;
  const moving = (D.congress?.moving || []).filter(b => daysAgo(b.latest_date) <= 14);
  const votes = (D.congress?.votes?.recent || []).slice(0, 6);
  const dl = delegation();
  const notes = D.content?.this_week;
  const chg = (a, b) => b ? ((a - b) / Math.abs(b) * 100) : null;
  return `
  <section class="hero"><div>
    <div class="kicker">${date(new Date().toISOString())}</div>
    <h1>What the federal government is doing, in plain English</h1>
    <p class="lede">Spending, laws, votes and the people casting them, pulled from official records. Party labels are hidden until you ask for them, so you can judge what was done before who did it.</p>
  </div>
  ${done ? `<div class="grid g2">
    <div class="card kpi accent"><div class="lbl">Federal spending, FY${done.fy}</div><div class="val">${money(done.outlays)}</div><div class="sub">${chg(done.outlays, prev?.outlays) != null ? `${chg(done.outlays, prev.outlays) > 0 ? 'Up' : 'Down'} ${pct(Math.abs(chg(done.outlays, prev.outlays)))} from FY${prev.fy}` : ''}</div></div>
    <div class="card kpi"><div class="lbl">Deficit, FY${done.fy}</div><div class="val">${money(Math.abs(done.deficit ?? done.receipts - done.outlays))}</div><div class="sub">Revenue was ${money(done.receipts)}</div></div>
    <div class="card kpi"><div class="lbl">Total national debt</div><div class="val">${money(debt?.total)}</div><div class="sub">As of ${date(debt?.date)}</div></div>
    <div class="card kpi"><div class="lbl">${cur && !cur.complete ? `FY${cur.fy} so far` : 'Laws enacted this Congress'}</div><div class="val">${cur && !cur.complete ? money(cur.outlays) : n0(D.congress?.laws?.length)}</div><div class="sub">${cur && !cur.complete ? `Spent through ${date(cur.as_of)}` : `${ord(D.congress?.congress || 119)} Congress`}</div></div>
  </div>` : '<div class="empty">Spending data appears after the first data refresh.</div>'}
  </section>

  ${notes?.items?.length ? `<section class="section"><div class="card-h"><div><h2>This week, explained</h2><div class="muted">${esc(notes.period || '')} · written ${date(notes.updated)}. Each item links to its sources.</div></div></div>
    <div class="grid g2">${notes.items.map(noteCard).join('')}</div></section>` : ''}

  <section class="section">
    <div class="card-h"><div><h2>Bills that moved in the last two weeks</h2><div class="muted">Bills and joint resolutions (the kinds that can become law) with action past introduction.</div></div><a href="#congress">All moving bills →</a></div>
    <div class="list">${moving.length ? moving.slice(0, 5).map(b => billCard(b, {summary: false})).join('') : '<div class="empty">No bills advanced in the last two weeks.</div>'}</div>
  </section>

  <div class="grid g2 section">
    <section><div class="card-h"><h2>Latest roll-call votes</h2><a href="#congress-votes">More votes →</a></div>
      <div class="list">${votes.length ? votes.map(voteRow).join('') : '<div class="empty">Vote data appears after the first data refresh.</div>'}</div></section>
    <section><div class="card-h"><h2>Your delegation</h2>${dl ? `<button class="more" style="margin:0" data-act="home">Change</button>` : ''}</div>
      ${dl ? `<div class="list">${dl.map(memberCard).join('')}</div>` : `<div class="card"><p>Pick your state (and House district, if you know it) to pin your senators and representative here.</p><button class="solid" data-act="home">Set your state</button></div>`}
    </section>
  </div>
  ${D.content?.developing?.length ? `<section class="section"><h2>Developing stories</h2><p class="muted">Still unfolding. Only confirmed facts are listed. Each one gets a full follow-up when it settles, including anything early reporting got wrong.</p>
    <div class="list">${D.content.developing.map(devCard).join('')}</div></section>` : ''}
  ${D.content?.media_checks?.length ? `<section class="section"><h2>Coverage checks</h2><p class="muted">News coverage and public statements checked against the record. Every outlet and official gets the same labels. <a href="#about">How the labels work</a>.</p>
    <div class="list">${D.content.media_checks.map(checkCard).join('')}</div></section>` : ''}`;
};

V.money = () => {
  const ys = D.money?.years || [];
  if (!ys.length) return '<div class="empty">Spending data appears after the first data refresh.</div>';
  UI.fy ??= fyLatest().done?.fy || ys[ys.length - 1].fy;
  UI.mode ??= 'function';
  const y = ys.find(x => x.fy === UI.fy) || ys[ys.length - 1], prev = ys.find(x => x.fy === y.fy - 1);
  const ag = D.money.agencies;
  const recv = [...(y.sources || [])].sort((a, b) => b.amount - a.amount);
  const rmax = Math.max(...recv.map(r => r.amount));
  const neg = (y.functions || []).filter(f => f.amount < 0);
  return `
  <section class="hero"><div>
    <div class="kicker">Money</div>
    <h1>Where ${money(y.outlays)} went in FY${y.fy}${y.complete ? '' : ' so far'}</h1>
    <p class="lede">Each box is sized by spending. Click one to see what it pays for and how it has changed. The federal fiscal year runs October 1 to September 30.</p>
  </div>
  <div class="grid g3">
    <div class="card kpi"><div class="lbl">Spent</div><div class="val">${money(y.outlays)}</div><div class="sub">${prev ? `FY${prev.fy}: ${money(prev.outlays)}` : ''}</div></div>
    <div class="card kpi"><div class="lbl">Collected</div><div class="val">${money(y.receipts)}</div><div class="sub">${prev ? `FY${prev.fy}: ${money(prev.receipts)}` : ''}</div></div>
    <div class="card kpi"><div class="lbl">Borrowed (deficit)</div><div class="val">${money(Math.abs(y.deficit ?? y.receipts - y.outlays))}</div><div class="sub">${pct(Math.abs((y.deficit ?? y.receipts - y.outlays) / y.outlays * 100), 0)} of spending</div></div>
  </div></section>

  <div class="filters">
    <select id="fySel" aria-label="Fiscal year">${[...ys].reverse().map(x => `<option value="${x.fy}" ${x.fy === y.fy ? 'selected' : ''}>FY${x.fy}${x.complete ? '' : ' (to date)'}</option>`).join('')}</select>
    <div class="tabs" style="margin:0"><button class="tab ${UI.mode === 'function' ? 'on' : ''}" data-mode="function">By purpose</button><button class="tab ${UI.mode === 'agency' ? 'on' : ''}" data-mode="agency" ${ag ? '' : 'disabled'}>By agency${ag?.fy ? ` (FY${ag.fy})` : ''}</button></div>
  </div>
  <div class="tmwrap"><div><div class="tm" id="tm"></div>
    <p class="src" style="margin-top:8px">${UI.mode === 'function'
      ? `Source: <a href="https://fiscaldata.treasury.gov/datasets/monthly-treasury-statement/" target="_blank" rel="noopener">U.S. Treasury, Monthly Treasury Statement, table 9</a> (as of ${date(y.as_of)}).${neg.length ? ` Not shown: ${neg.map(f => `${esc(f.name)} (${money(f.amount)})`).join(', ')}, which are subtracted from the total.` : ''}`
      : `Source: <a href="https://www.usaspending.gov/agency" target="_blank" rel="noopener">USAspending.gov agency profiles</a>, FY${ag?.fy} through quarter ${ag?.fq}. Agency totals and purpose totals come from different reports and won't match exactly.`}</p></div>
    <aside class="card detail" id="tmDetail"></aside></div>

  <section class="section"><h2>Where the money comes from</h2><p class="muted">FY${y.fy}${y.complete ? '' : ' to date'} revenue by source.</p>
    <div class="card bars">${recv.map(r => `<div class="row"><span>${esc(r.name)}</span><span class="bar"><i style="width:${Math.max(0, r.amount / rmax * 100)}%"></i></span><span class="amt">${money(r.amount)}</span></div>`).join('')}
    <p class="src" style="margin-top:10px">Source: <a href="https://fiscaldata.treasury.gov/datasets/monthly-treasury-statement/" target="_blank" rel="noopener">Monthly Treasury Statement, table 9</a></p></div></section>

  <section class="section"><h2>Month by month</h2><p class="muted">What came in and what went out each month over the last three years. Hover for exact amounts.</p>
    <div class="card"><div class="fig" id="monthly"></div><div class="legend"><span><i style="background:var(--pine)"></i>Revenue</span><span><i style="background:var(--ochre)"></i>Spending</span></div></div></section>

  <section class="section"><h2>The national debt</h2><p class="muted">Total public debt outstanding at the end of each month.</p>
    <div class="card"><div class="fig" id="debt"></div><p class="src" style="margin-top:8px">${D.money.debt ? `Latest: ${money(D.money.debt.latest.total)} on ${date(D.money.debt.latest.date)}, of which ${money(D.money.debt.latest.public)} is held by the public and ${money(D.money.debt.latest.intragov)} is owed to federal trust funds. ` : ''}Source: <a href="https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/" target="_blank" rel="noopener">Treasury, Debt to the Penny</a></p></div></section>`;
};
V.money.after = () => {
  $('#fySel')?.addEventListener('change', e => { UI.fy = +e.target.value; UI.sel = null; render(); });
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { UI.mode = b.dataset.mode; UI.sel = null; render(); }));
  const y = D.money.years.find(x => x.fy === UI.fy), ys = D.money.years;
  let items;
  if (UI.mode === 'agency' && D.money.agencies) {
    const all = D.money.agencies.items.filter(a => a.outlays > 0);
    const top = all.slice(0, 18), other = all.slice(18).reduce((s, a) => s + a.outlays, 0);
    items = top.map(a => ({name: a.name, value: a.outlays, abbr: a.abbr, slug: a.slug}));
    if (other > 0) items.push({name: `${all.length - 18} other agencies`, value: other});
  } else items = (y.functions || []).filter(f => f.amount > 0).map(f => ({name: f.name, value: f.amount}));
  items.sort((a, b) => b.value - a.value);
  items.forEach((it, i) => it.color = PALETTE[i % PALETTE.length]);
  const total = items.reduce((s, i) => s + i.value, 0);
  const tm = $('#tm'), det = $('#tmDetail');
  const showDetail = it => {
    document.querySelectorAll('.tm .cell').forEach(c => c.classList.toggle('sel', c.dataset.n === it.name));
    UI.sel = it.name;
    if (UI.mode === 'agency') {
      det.innerHTML = `<div class="kicker">Agency</div><h2>${esc(it.name)}</h2><div class="big">${money(it.value)}</div><p class="muted">${pct(it.value / total * 100)} of agency spending shown</p>${it.slug ? src('USAspending agency profile', `https://www.usaspending.gov/agency/${it.slug}`) : ''}`;
      return;
    }
    const hist = ys.filter(x => x.complete || x.fy === y.fy).map(x => ({fy: x.fy, v: (x.functions.find(f => f.name === it.name) || {}).amount})).filter(h => h.v != null);
    const p = hist.find(h => h.fy === y.fy - 1);
    const hmax = Math.max(...hist.map(h => h.v));
    det.innerHTML = `<div class="kicker">${pct(it.value / (y.outlays || total) * 100)} of all spending</div><h2>${esc(it.name)}</h2><div class="big">${money(it.value)}</div>
      ${p && y.complete ? `<p class="${it.value >= p.v ? 'up' : 'down'}">${it.value >= p.v ? '▲' : '▼'} ${money(Math.abs(it.value - p.v))} (${pct(Math.abs((it.value - p.v) / p.v * 100))}) vs FY${p.fy}</p>` : ''}
      <p>${esc(funcNote(it.name))}</p>
      <div class="lbl muted small" style="margin-top:10px">Each fiscal year since FY${hist[0]?.fy}</div>
      <div class="bars" style="margin-top:4px">${hist.slice(-10).map(h => `<div class="row" style="grid-template-columns:52px minmax(0,1fr) 70px;padding:2px 0;font-size:13px"><span>FY${String(h.fy).slice(2)}</span><span class="bar" style="height:9px"><i style="width:${h.v / hmax * 100}%;background:${h.fy === y.fy ? 'var(--ochre)' : 'var(--pine)'}"></i></span><span class="amt">${money(h.v)}</span></div>`).join('')}</div>`;
  };
  chart(tm, (W, H) => {
    tm.innerHTML = squarify(items, W, H).map(c => `<div class="cell ${LITE.has(c.color) ? 'lite' : ''}" data-n="${esc(c.name)}" tabindex="0" role="button" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;background:${c.color}">${c.w > 70 && c.h > 38 ? `<div class="n">${esc(c.w < 130 && c.abbr ? c.abbr : c.name)}</div><div class="v">${money(c.value)} · ${pct(c.value / total * 100, 0)}</div>` : ''}</div>`).join('');
    tm.querySelectorAll('.cell').forEach(c => {
      const it = items.find(i => i.name === c.dataset.n);
      c.title = `${it.name}: ${money(it.value)}`;
      c.addEventListener('click', () => showDetail(it));
      c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(it); } });
    });
    showDetail(items.find(i => i.name === UI.sel) || items[0]);
  });
  const mo = (D.money.monthly || []).slice(-36).map(m => ({...m, label: monthYr(m.date).replace(' 20', " '")}));
  barChart($('#monthly'), mo, {series: [{key: 'receipts', color: 'var(--pine)'}, {key: 'outlays', color: 'var(--ochre)'}],
    tipLabel: d => `${monthYr(d.date)}<br>Revenue ${money(d.receipts)} · Spending ${money(d.outlays)}<br>${d.receipts >= d.outlays ? 'Surplus' : 'Deficit'} ${money(Math.abs(d.receipts - d.outlays))}`});
  const dh = (D.money.debt?.history || []).map(h => ({date: h.date, v: h.total}));
  if (dh.length > 2) lineChart($('#debt'), dh, {label: p => monthYr(p.date)});
};

V.congress = (sub) => {
  UI.ctab = sub || UI.ctab || 'bills';
  const c = D.congress || {};
  const tabs = [['bills', `Moving bills (${(c.moving || []).length})`], ['votes', 'Recent votes'], ['laws', `Laws enacted (${(c.laws || []).length})`]];
  let body = '';
  if (UI.ctab === 'bills') {
    UI.bq ??= ''; UI.bstage ??= ''; UI.bch ??= '';
    const list = (c.moving || []).filter(b => (!UI.bstage || b.stage === UI.bstage || (UI.bstage === 'passed_both' && b.stage === 'to_president'))
      && (!UI.bch || b.type.startsWith(UI.bch === 'House' ? 'H' : 'S'))
      && (!UI.bq || `${b.title} ${billName(b)} ${b.policy_area} ${b.sponsor?.name}`.toLowerCase().includes(UI.bq.toLowerCase())));
    body = `<div class="filters"><input id="bq" type="search" placeholder="Search bills by title, number or topic" value="${esc(UI.bq)}">
      <select id="bstage"><option value="">Every stage</option>${['committee','passed_one','passed_both','law','vetoed'].map(s => `<option value="${s}" ${UI.bstage === s ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}</select>
      <select id="bch"><option value="">Both chambers</option><option ${UI.bch === 'House' ? 'selected' : ''}>House</option><option ${UI.bch === 'Senate' ? 'selected' : ''}>Senate</option></select>
      <span class="muted small">${plural(list.length, 'bill')}</span></div>
      <p class="muted small">Bills and joint resolutions with official action in the last 120 days beyond introduction, newest first. Stage is read from the latest official action. Summaries are written by the nonpartisan Congressional Research Service.</p>
      <div class="list">${list.slice(0, UI.blimit || 25).map(b => billCard(b)).join('') || '<div class="empty">No bills match.</div>'}</div>
      ${list.length > (UI.blimit || 25) ? '<button class="more" data-act="bmore">Show more</button>' : ''}`;
  } else if (UI.ctab === 'votes') {
    UI.vch ??= '';
    const vs = (c.votes?.recent || []).filter(v => !UI.vch || v.chamber === UI.vch);
    body = `<div class="filters"><select id="vch"><option value="">Both chambers</option><option ${UI.vch === 'House' ? 'selected' : ''}>House</option><option ${UI.vch === 'Senate' ? 'selected' : ''}>Senate</option></select>
      <span class="muted small">${c.votes ? `${n0(c.votes.totals?.House)} House and ${n0(c.votes.totals?.Senate)} Senate roll calls so far this Congress · latest ${date(c.votes.source_date)}` : ''}</span></div>
      <p class="muted small">Turn on "Show party" to see how each party's members voted. ${src('Voteview (UCLA), compiled from House Clerk and Senate records', 'https://voteview.com')}</p>
      <div class="list">${vs.slice(0, UI.vlimit || 30).map(voteRow).join('') || '<div class="empty">Vote data appears after the first data refresh.</div>'}</div>
      ${vs.length > (UI.vlimit || 30) ? '<button class="more" data-act="vmore">Show more</button>' : ''}`;
  } else {
    const ls = c.laws || [];
    body = `<p class="muted small">Every bill signed into law (or enacted over a veto) in the ${ord(c.congress || 119)} Congress, newest first. ${src('Congress.gov', 'https://www.congress.gov/public-laws/' + ord(c.congress || 119) + '-congress')}</p>
      <div class="card"><table class="tbl"><thead><tr><th>Law</th><th>Bill</th><th>Title</th><th class="r">Date</th></tr></thead><tbody>
      ${ls.slice(0, UI.llimit || 60).map(l => `<tr><td style="white-space:nowrap">${esc(l.law)}</td><td style="white-space:nowrap"><a href="${billUrl(l)}" target="_blank" rel="noopener">${esc(billName(l))}</a></td><td>${esc(l.title)}</td><td class="r" style="white-space:nowrap">${date(l.date)}</td></tr>`).join('')}
      </tbody></table></div>${ls.length > (UI.llimit || 60) ? '<button class="more" data-act="lmore">Show more</button>' : ''}`;
  }
  return `<section class="hero" style="grid-template-columns:1fr"><div><div class="kicker">Congress</div><h1>What Congress is actually moving</h1>
    <p class="lede">Most bills never get past introduction. These are the ones with real action, the votes taken on them, and the laws that resulted.</p></div></section>
    <div class="tabs">${tabs.map(([k, l]) => `<a class="tab ${UI.ctab === k ? 'on' : ''}" href="#congress-${k}" style="text-decoration:none">${l}</a>`).join('')}</div>${body}`;
};
V.congress.after = () => {
  const re = () => { const p = $('#bq')?.selectionStart; render(); const q = $('#bq'); if (q && p != null) { q.focus(); q.setSelectionRange(p, p); } };
  $('#bq')?.addEventListener('input', e => { UI.bq = e.target.value; UI.blimit = 25; re(); });
  $('#bstage')?.addEventListener('change', e => { UI.bstage = e.target.value; render(); });
  $('#bch')?.addEventListener('change', e => { UI.bch = e.target.value; render(); });
  $('#vch')?.addEventListener('change', e => { UI.vch = e.target.value; render(); });
};

V.members = () => {
  UI.mq ??= ''; UI.mch ??= ''; UI.mst ??= ''; UI.msort ??= 'name';
  const home = store.get('home', null);
  let ms = D.members.filter(m => (!UI.mch || m.chamber === UI.mch) && (!UI.mst || m.state === UI.mst)
    && (!UI.mq || `${m.name} ${STATES[m.state]} ${m.state}`.toLowerCase().includes(UI.mq.toLowerCase())));
  const key = {name: m => m.last + m.first, bills: m => -(m.bills?.sponsored ?? -1), law: m => -(m.bills?.became_law ?? -1), missed: m => -(m.votes?.missed_pct ?? -1), years: m => -m.years_in_congress}[UI.msort];
  ms = [...ms].sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; });
  const counts = {}; D.members.forEach(m => counts[m.state] = (counts[m.state] || 0) + 1);
  let rows = 0; Object.values(TILES).forEach(([r]) => rows = Math.max(rows, r + 1));
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < 11; c++) {
    const st = Object.keys(TILES).find(k => TILES[k][0] === r && TILES[k][1] === c);
    cells.push(st ? `<button data-st="${st}" class="${UI.mst === st ? 'on' : ''} ${home?.state === st ? 'home' : ''}" title="${STATES[st]}: ${counts[st] || 0} members">${st}</button>` : '<span class="gap"></span>');
  }
  return `<section class="hero"><div><div class="kicker">Members</div><h1>All ${D.members.length} members of Congress</h1>
    <p class="lede">Click a state on the map, or search. Each profile shows what the member has done: bills, votes, committee roles and campaign money. No scores or grades.</p></div>
    <div class="statemap" aria-label="Pick a state">${cells.join('')}</div></section>
    <div class="filters"><input id="mq" type="search" placeholder="Search by name or state" value="${esc(UI.mq)}">
      <select id="mch"><option value="">Both chambers</option><option ${UI.mch === 'Senate' ? 'selected' : ''}>Senate</option><option ${UI.mch === 'House' ? 'selected' : ''}>House</option></select>
      <select id="msort">${[['name','Sort: name'],['bills','Most bills sponsored'],['law','Most sponsored bills enacted'],['missed','Most votes missed'],['years','Longest serving']].map(([k, l]) => `<option value="${k}" ${UI.msort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${UI.mst ? `<button class="ghost" data-act="clearstate">${esc(STATES[UI.mst])} ✕</button>` : ''}
      <span class="muted small">${plural(ms.length, 'member')}</span></div>
    <div class="mgrid">${ms.map(m => memberCard(m).replace('</div></a>', `${UI.msort === 'bills' ? `<div class="ds">${plural(m.bills?.sponsored ?? 0, 'bill')} sponsored</div>` : UI.msort === 'law' ? `<div class="ds">${plural(m.bills?.became_law ?? 0, 'bill')} enacted</div>` : UI.msort === 'missed' ? `<div class="ds">${pct(m.votes?.missed_pct)} of votes missed</div>` : UI.msort === 'years' ? `<div class="ds">${m.years_in_congress} years in Congress</div>` : ''}</div></a>`)).join('')}</div>`;
};
V.members.after = () => {
  const re = () => { const p = $('#mq')?.selectionStart; render(); const q = $('#mq'); if (q && p != null) { q.focus(); q.setSelectionRange(p, p); } };
  $('#mq')?.addEventListener('input', e => { UI.mq = e.target.value; re(); });
  $('#mch')?.addEventListener('change', e => { UI.mch = e.target.value; render(); });
  $('#msort')?.addEventListener('change', e => { UI.msort = e.target.value; render(); });
  document.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => { UI.mst = UI.mst === b.dataset.st ? '' : b.dataset.st; render(); }));
};

V.member = id => {
  const m = D.byId[id];
  if (!m) return '<div class="empty">Member not found. <a href="#members">Back to all members</a></div>';
  const v = m.votes, b = m.bills, f = m.finance;
  const chamberAvg = (() => { const xs = D.members.filter(x => x.chamber === m.chamber && x.votes?.missed_pct != null).map(x => x.votes.missed_pct).sort((a, b) => a - b); return xs.length ? xs[Math.floor(xs.length / 2)] : null; })();
  const billsMed = (() => { const xs = D.members.filter(x => x.chamber === m.chamber && x.bills).map(x => x.bills.sponsored).sort((a, b) => a - b); return xs.length ? xs[Math.floor(xs.length / 2)] : null; })();
  const ft = f ? [['Individuals (gifts over $200)', f.individual_itemized], ['PACs and other committees', f.pac]] : [];
  if (f) ft.push(['Everything else (small gifts, transfers, loans)', Math.max(0, (f.receipts || 0) - ft.reduce((s, x) => s + (x[1] || 0), 0))]);
  const ftot = f?.receipts || 1;
  return `<p><a href="#members">← All members</a></p>
  <section class="card prof">${photo(m)}<div>
    <div class="kicker">${esc(seat(m))}</div><h1 style="margin-bottom:6px">${esc(m.name)} ${partyChip(m.party)}</h1>
    <div class="facts">${m.leadership?.map(l => `<span class="chip">${esc(l)}</span>`).join('') || ''}<span class="chip">In the ${m.chamber} since ${esc(m.chamber_since)}</span><span class="chip">${m.years_in_congress} years in Congress</span><span class="chip">Term ends ${date(m.term_end)}</span></div>
    <p class="small muted" style="margin-top:10px">${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">Official website</a> · ` : ''}${m.phone ? `${esc(m.phone)} · ` : ''}<a href="https://www.congress.gov/member/${esc(m.name.toLowerCase().replace(/[^a-z]+/g, '-'))}/${esc(m.id)}" target="_blank" rel="noopener">Congress.gov profile</a>${f?.fec_id ? ` · <a href="https://www.fec.gov/data/candidate/${esc(f.fec_id)}/" target="_blank" rel="noopener">FEC filings</a>` : ''}</p>
  </div></section>

  <div class="grid g4 section">
    <div class="card stat"><div class="lbl">Bills and resolutions sponsored</div><div class="val">${b ? n0(b.sponsored) : '—'}</div><div class="src">${billsMed != null ? `${m.chamber} median: ${billsMed}` : ''}</div></div>
    <div class="card stat"><div class="lbl">Sponsored bills that advanced</div><div class="val">${b ? n0(b.advanced) : '—'}</div><div class="src">Past introduction</div></div>
    <div class="card stat"><div class="lbl">Sponsored bills enacted</div><div class="val">${b ? n0(b.became_law) : '—'}</div><div class="src">Became law</div></div>
    <div class="card stat"><div class="lbl">Roll-call votes missed</div><div class="val">${v ? pct(v.missed_pct) : '—'}</div><div class="src">${v ? `${n0(v.missed)} of ${n0(v.eligible)}${chamberAvg != null ? ` · ${m.chamber} median ${pct(chamberAvg)}` : ''}` : ''}</div></div>
  </div>

  <div class="grid g2 section">
    <section class="card"><h2>Recently sponsored</h2>
      ${b?.recent?.length ? `<table class="tbl"><tbody>${b.recent.map(x => `<tr><td style="white-space:nowrap"><a class="bid" href="${billUrl(x)}" target="_blank" rel="noopener">${esc(billName(x))}</a></td><td>${esc(x.title)}<div class="src">${esc(STAGE_LABEL[x.stage])} · ${date(x.latest_date)}</div></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No bills sponsored this Congress yet, or data not loaded.</p>'}
      ${b?.laws?.length ? `<h3 style="margin-top:16px">Enacted</h3><ul>${b.laws.map(x => `<li><a href="${billUrl(x)}" target="_blank" rel="noopener">${esc(billName(x))}</a>: ${esc(x.title)}</li>`).join('')}</ul>` : ''}
      ${src('Congress.gov', `https://www.congress.gov/member/${m.id}`)}</section>
    <section class="card"><h2>How they vote</h2>
      ${v ? `<table class="tbl"><tbody>
        <tr><td>Votes cast (yea or nay)</td><td class="r">${n0(v.yea + v.nay)}</td></tr>
        <tr><td>Voted "present"</td><td class="r">${n0(v.present)}</td></tr>
        <tr><td>Did not vote</td><td class="r">${n0(v.missed)}</td></tr>
        <tr><td>Yea / nay split</td><td class="r">${n0(v.yea)} / ${n0(v.nay)}</td></tr>
      </tbody></table>
      <div class="party blk" style="margin-top:14px"><div class="lbl small muted">Voted with the majority of their own party</div><div class="stat" style="padding:0"><div class="val">${pct(v.with_party_pct)}</div></div><div class="meter"><i style="width:${v.with_party_pct || 0}%"></i></div><p class="src">Counted on votes where the member voted yea or nay and their party wasn't evenly split.</p></div>
      ${src('Voteview (UCLA)', 'https://voteview.com')}` : '<p class="muted">Vote data not loaded yet.</p>'}
    </section>
  </div>

  <div class="grid g2 section">
    <section class="card"><h2>Committees</h2>
      ${m.committees?.length ? `<ul class="cmte">${m.committees.map(c => `<li>${esc(c.name)}${c.title ? ` <span class="chip">${esc(c.title)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No committee assignments listed.</p>'}
      ${src('congress-legislators (public domain)', 'https://github.com/unitedstates/congress-legislators')}</section>
    <section class="card"><h2>Campaign money</h2>
      ${f ? `<p class="muted small">${m.chamber === 'Senate' ? 'Six-year' : 'Two-year'} election cycle ending ${f.cycle}, through ${date(f.coverage_end)}.</p>
        <div class="grid g2" style="gap:10px"><div><div class="lbl small muted">Raised</div><div class="stat" style="padding:0"><div class="val">${money(f.receipts)}</div></div></div><div><div class="lbl small muted">Cash on hand</div><div class="stat" style="padding:0"><div class="val">${money(f.cash_on_hand)}</div></div></div></div>
        <div class="bars" style="margin-top:12px">${ft.map(([l, x]) => `<div class="row" style="grid-template-columns:minmax(0,190px) minmax(0,1fr) 70px"><span class="small">${l}</span><span class="bar"><i style="width:${x / ftot * 100}%"></i></span><span class="amt small">${money(x)}</span></div>`).join('')}</div>
        ${src('Federal Election Commission', `https://www.fec.gov/data/candidate/${f.fec_id}/`)}` : '<p class="muted">No campaign finance totals found for this member yet.</p>'}</section>
  </div>`;
};

V.results = () => {
  const items = D.content?.did_it_work || [];
  return `<section class="hero" style="grid-template-columns:1fr"><div><div class="kicker">Did it work?</div><h1>What was promised, and what actually happened</h1>
    <p class="lede">Big laws and programs, followed up after the headlines fade. What supporters said each one would do, set beside official data and independent evaluations. No verdicts: you decide.</p></div></section>
    <div class="filters">${items.map(it => `<a class="tab" href="#results-${esc(it.id)}" style="text-decoration:none">${esc(it.name)}</a>`).join('')}</div>
    <div class="list">${items.map(it => `<article class="card dw" id="dw-${esc(it.id)}">
      <div class="card-h"><div><div class="kicker">${esc(it.type)} · ${esc(it.dates)}</div><h2 style="font-size:26px">${esc(it.name)}</h2></div><span class="chip">${esc(it.status)}</span></div>
      <p class="muted">${esc(it.goal)}</p>
      <div class="grid g2 dwcols"><div><h3>What was promised</h3><ul class="ev">${it.promised.map(p => `<li>${esc(p.text)} <a class="src" href="${esc(p.source.url)}" target="_blank" rel="noopener">${esc(p.source.label)}</a></li>`).join('')}</ul></div>
      <div><h3>What happened</h3><ul class="ev">${it.happened.map(p => `<li>${esc(p.text)} <a class="src" href="${esc(p.source.url)}" target="_blank" rel="noopener">${esc(p.source.label)}</a></li>`).join('')}</ul></div></div>
      ${it.chart ? `<div class="dwchart"><div class="lbl small muted">${esc(it.chart.label)}</div><div class="bars" data-chart="${esc(it.id)}"></div></div>` : ''}
      ${it.open?.length ? `<div class="notice" style="margin-top:14px"><b>Still open:</b><ul class="tight" style="margin:4px 0 0">${it.open.map(o => `<li>${esc(o)}</li>`).join('')}</ul></div>` : ''}
    </article>`).join('') || '<div class="empty">No entries yet.</div>'}</div>`;
};
V.results.after = arg => {
  (D.content?.did_it_work || []).forEach(it => {
    const el = document.querySelector(`[data-chart="${it.id}"]`);
    if (!el || !D.money) return;
    const ys = D.money.years.filter(y => y.complete && y.fy >= (it.chart.from || 0));
    const val = y => it.chart.series === 'outlays' ? y.outlays : it.chart.series === 'receipts' ? y.receipts
      : (y.sources.find(s => s.name.toLowerCase().includes(it.chart.series)) || {}).amount;
    const rows = ys.map(y => ({fy: y.fy, v: val(y)})).filter(r => r.v != null), mx = Math.max(...rows.map(r => r.v));
    el.innerHTML = rows.map(r => `<div class="row" style="grid-template-columns:64px minmax(0,1fr) 84px"><span>FY${r.fy}</span><span class="bar"><i style="width:${r.v / mx * 100}%"></i></span><span class="amt">${money(r.v)}</span></div>`).join('');
  });
  if (arg) document.getElementById('dw-' + arg)?.scrollIntoView({block: 'start'});
};

V.about = () => `<div class="prose">
  <div class="kicker">How this works</div><h1>Rules this site follows</h1>
  <p class="lede">The goal is simple: show what the government is actually doing, with sources, so you can draw your own conclusions.</p>
  <h2>Facts first, parties second</h2>
  <p>Party labels, party-colored anything, and party-based numbers (like how often someone votes with their party) are hidden until you turn on <b>Show party</b> in the top bar. The site uses no red, blue or purple anywhere.</p>
  <h2>No scores, no grades</h2>
  <p>Members are described with countable, sourced facts: bills sponsored and enacted, votes cast and missed, committee roles, and campaign money. Combining those into a single score would mean choosing what matters most, and that choice is a political judgment. You make it.</p>
  <h2>Where the numbers come from</h2>
  <ul>
    <li><b>Spending, revenue and deficits:</b> <a href="https://fiscaldata.treasury.gov/datasets/monthly-treasury-statement/" target="_blank" rel="noopener">U.S. Treasury Monthly Treasury Statement</a></li>
    <li><b>National debt:</b> <a href="https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/" target="_blank" rel="noopener">Treasury, Debt to the Penny</a></li>
    <li><b>Spending by agency:</b> <a href="https://www.usaspending.gov" target="_blank" rel="noopener">USAspending.gov</a></li>
    <li><b>Bills, summaries, cost estimates and laws:</b> <a href="https://api.congress.gov" target="_blank" rel="noopener">Congress.gov API</a> (Library of Congress), with summaries by the Congressional Research Service and cost estimates by the Congressional Budget Office</li>
    <li><b>Roll-call votes:</b> <a href="https://voteview.com" target="_blank" rel="noopener">Voteview</a> (UCLA), compiled from House Clerk and Senate records; each vote links to its official record</li>
    <li><b>Members, terms and committees:</b> the public-domain <a href="https://github.com/unitedstates/congress-legislators" target="_blank" rel="noopener">congress-legislators</a> dataset</li>
    <li><b>Campaign money:</b> <a href="https://api.open.fec.gov/developers/" target="_blank" rel="noopener">Federal Election Commission</a></li>
  </ul>
  <h2>How it updates</h2>
  <p>Data is refreshed by hand: pressing "Run workflow" on the project's GitHub page pulls fresh numbers from every source above. Each section shows when its data was last pulled. If a source fails, the previous data stays up and the failure is noted at the bottom of the page.</p>
  <h2>Developing stories</h2>
  <p>While a story is still unfolding, written notes stick to confirmed facts and are labeled <b>Developing</b>. Once it settles, it gets a full follow-up that also notes what early reporting got wrong.</p>
  <h2>Checking claims and coverage</h2>
  <p>Media coverage and politicians' public statements are checked against the record using the same five labels for everyone, each linked to its evidence:</p>
  <div class="flags">
    <div class="flag"><b>Accurate</b>Matches the record.</div>
    <div class="flag"><b>Missing context</b>True, but leaves out something that changes the picture.</div>
    <div class="flag"><b>Misleading framing</b>Facts are presented in a way that points to a wrong conclusion.</div>
    <div class="flag"><b>Contradicted by the record</b>The official record says otherwise. We say "false," not "lie": intent usually can't be proven.</div>
    <div class="flag"><b>Unverified</b>Can't be confirmed or ruled out yet.</div>
  </div>
  ${D.content?.media_list ? `<p><b>Outlets checked:</b> ${D.content.media_list.outlets.map(esc).join(', ')}. ${esc(D.content.media_list.note)}</p>` : ''}
  <h2>Contested issues</h2>
  <p>Where people disagree, the site lays out tradeoffs (what a policy does, who benefits, who pays, what the evidence shows, what's unknown) instead of sides. Arguments are credited by expertise, not team.</p>
  <h2>Mistakes</h2>
  <p>Every change is logged on the <a href="#changes">Changes</a> page, and corrections are marked separately from routine updates.</p>
</div>`;

V.changes = () => {
  const log = D.changelog?.entries || [];
  return `<div class="prose"><div class="kicker">Changes</div><h1>What changed, and when</h1><p class="lede">Every update to this site, newest first. Corrections are marked.</p></div>
  <div class="list log" style="max-width:820px">${log.map(e => `<article class="card entry"><div class="card-h" style="margin:0"><h3 style="margin:0">${date(e.date)}</h3><span class="tag ${e.type === 'correction' ? 'correction' : ''}">${esc(e.type === 'correction' ? 'Correction' : e.type === 'feature' ? 'New feature' : 'Update')}</span></div>
    ${e.summary ? `<p style="margin:6px 0 0">${esc(e.summary)}</p>` : ''}<ul>${(e.items || []).map(i => `<li>${esc(i)}</li>`).join('')}</ul></article>`).join('') || '<div class="empty">No changes logged yet.</div>'}</div>`;
};

/* ---------- router ---------- */
const view = $('#view');
function render() {
  observers.splice(0).forEach(o => o.disconnect());
  const h = location.hash.slice(1) || 'week';
  let [r, ...rest] = h.split('-'); const arg = rest.join('-');
  if (!V[r]) r = 'week';
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.r === r || (r === 'member' && a.dataset.r === 'members')));
  view.innerHTML = V[r](arg);
  V[r].after?.(arg);
  view.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));
}
function act(a) {
  if (a === 'home') return openHome();
  if (a === 'bmore') UI.blimit = (UI.blimit || 25) + 25;
  if (a === 'vmore') UI.vlimit = (UI.vlimit || 30) + 30;
  if (a === 'lmore') UI.llimit = (UI.llimit || 60) + 60;
  if (a === 'clearstate') UI.mst = '';
  render();
}
let lastRoute = '';
window.addEventListener('hashchange', () => {
  const r = location.hash.split('-')[0];
  render();
  if (r !== lastRoute) { window.scrollTo(0, 0); lastRoute = r; }
});

/* ---------- party toggle + home state ---------- */
const pt = $('#partyToggle');
pt.checked = store.get('party', false);
document.body.classList.toggle('show-party', pt.checked);
pt.addEventListener('change', () => { store.set('party', pt.checked); document.body.classList.toggle('show-party', pt.checked); });

const dlg = $('#homeDlg'), sSel = $('#homeState'), dSel = $('#homeDist');
function fillDistricts(st, cur) {
  const ds = [...new Set(D.members.filter(m => m.state === st && m.chamber === 'House').map(m => m.district))].sort((a, b) => a - b);
  dSel.innerHTML = `<option value="">Not sure / show all</option>` + ds.map(d => `<option value="${d}" ${cur === d ? 'selected' : ''}>${d === 0 ? 'At-large' : 'District ' + d}</option>`).join('');
}
function openHome() {
  const h = store.get('home', {});
  sSel.innerHTML = '<option value="">Choose a state</option>' + Object.entries(STATES).sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => `<option value="${k}" ${h.state === k ? 'selected' : ''}>${v}</option>`).join('');
  fillDistricts(h.state, h.district);
  dlg.showModal();
}
sSel.addEventListener('change', () => fillDistricts(sSel.value));
dlg.addEventListener('close', () => {
  if (dlg.returnValue === 'save' && sSel.value) store.set('home', {state: sSel.value, district: dSel.value === '' ? null : +dSel.value});
  if (dlg.returnValue === 'clear') store.set('home', null);
  homeLabel(); render();
});
function homeLabel() { const h = store.get('home', null); $('#homeBtn').textContent = h?.state ? `${h.state}${h.district != null ? '-' + (h.district || 'AL') : ''}` : 'Set your state'; }
$('#homeBtn').addEventListener('click', openHome);

function freshness() {
  const s = D.meta?.sources || {};
  const label = {money: 'Spending', congress: 'Bills', votes: 'Votes', members_base: 'Members', members_congress: 'Member bills', finance: 'Campaign money'};
  const parts = Object.entries(label).filter(([k]) => s[k]).map(([k, l]) => `${l}: ${s[k].ok ? date(s[k].fetched_at) : `<b>failed on ${date(s[k].fetched_at)}</b>${s[k].last_ok ? `, showing data from ${date(s[k].last_ok)}` : ''}`}`);
  $('#freshness').innerHTML = parts.length ? `Data last pulled · ${parts.join(' · ')}` : '';
}

loadAll().then(() => { homeLabel(); freshness(); lastRoute = location.hash.split('-')[0]; render(); });
}
