const REGIONS = [
  ['swedencentral', 'Sweden Central'], ['northeurope', 'North Europe'], ['westeurope', 'West Europe'],
  ['germanywestcentral', 'Germany West Central'], ['norwayeast', 'Norway East'], ['francecentral', 'France Central'],
  ['polandcentral', 'Poland Central'], ['italynorth', 'Italy North'], ['spaincentral', 'Spain Central'],
  ['switzerlandnorth', 'Switzerland North'], ['uksouth', 'UK South'], ['eastus', 'East US'],
  ['eastus2', 'East US 2'], ['westus3', 'West US 3'], ['southeastasia', 'Southeast Asia']
];
const DEFAULT_REGIONS = ['swedencentral', 'northeurope', 'westeurope', 'germanywestcentral'];
const API = '/api/prices';

const COLS = {
  meterId: ['meterid', 'xskumeterid'],
  cost: ['costinbillingcurrency', 'effectivecost', 'pretaxcost', 'cost', 'extendedcost', 'billedcost', 'costinusd'],
  currency: ['billingcurrencycode', 'billingcurrency', 'currency', 'currencycode'],
  quantity: ['quantity', 'consumedquantity', 'pricingquantity'],
  category: ['metercategory', 'xskumetercategory', 'servicename'],
  subcat: ['metersubcategory', 'xskumetersubcategory'],
  meterName: ['metername', 'xskumetername'],
  location: ['resourcelocation', 'regionid', 'location'],
  resourceId: ['resourceid', 'instanceid'],
  pricingModel: ['pricingmodel', 'pricingcategory'],
  chargeType: ['chargetype', 'chargecategory'],
  date: ['date', 'usagedate', 'chargeperiodstart', 'usagedatetime'],
  product: ['productname', 'product']
};

const $ = s => document.querySelector(s);
const state = {
  file: null, parsed: null,
  regions: new Map(REGIONS), selected: new Set(DEFAULT_REGIONS),
  src: new Map(),   // meterId -> retail item | null
  tgt: new Map(),   // region|combo -> retail item | null
  results: null, active: 'current'
};

// ---------------------------------------------------------------------------
// Hjælpere
// ---------------------------------------------------------------------------
const normHeader = h => String(h).replace(/^\uFEFF/, '').replace(/[\s_"]/g, '').toLowerCase();
function num(v) {
  if (v == null || v === '') return 0;
  let n = Number(v);
  if (Number.isNaN(n) && typeof v === 'string') n = Number(v.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); // MM/DD/YYYY (EA)
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2]);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
const odata = s => String(s).replace(/'/g, "''");
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const regionLabel = r => state.regions.get(r) || r;
let fmtMoney = new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK', maximumFractionDigits: 0 });
const fmtPct = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v * 100).toLocaleString('da-DK', { maximumFractionDigits: 1 }) + ' %';
const fmtNum = (v, d = 0) => v.toLocaleString('da-DK', { maximumFractionDigits: d });
function setStatus(msg, error = false) { const el = $('#status'); el.textContent = msg; el.classList.toggle('error', error); }

// ---------------------------------------------------------------------------
// Klassificering af VM-størrelser og prisregler
// ---------------------------------------------------------------------------
function parseVmSize(armSkuName) {
  if (!armSkuName) return null;
  const name = armSkuName.replace(/_Promo$/i, '');
  const m = /^(?:Standard|Basic)_([A-Z]+)(\d+)(?:-\d+)?([a-z]*)(?:_v(\d+))?/.exec(name);
  if (!m) return null;
  return { family: m[1], suffix: m[3], version: m[4] ? +m[4] : 1 };
}
function upliftFor(item, region, isReservation, opts) {
  if (!item) return { pct: 0, rule: 'Ukendt meter', cls: 'warn' };
  if (opts.riProtect && isReservation) return { pct: 0, rule: 'Reservation fritaget', cls: 'none' };
  const svc = item.serviceName || '';
  if (svc === 'Virtual Machines') {
    const vm = parseVmSize(item.armSkuName);
    if (vm && (RULES.legacy[vm.version] || []).includes(vm.family)) {
      return { pct: RULES.legacyPct, rule: `Ældre serie (v${vm.version}) +${RULES.legacyPct} %`, cls: 'up' };
    }
    if (vm && RULES.exemptVmVersions.includes(vm.version)) return { pct: 0, rule: `v${vm.version} undtaget`, cls: 'none' };
    const p = RULES.regional[region] || 0;
    return p ? { pct: p, rule: `Regional +${p} %`, cls: 'up' } : { pct: 0, rule: 'Ingen stigning', cls: 'none' };
  }
  if (svc === 'Storage') {
    const text = `${item.productName} ${item.skuName} ${item.meterName}`;
    const p = RULES.regional[region] || 0;
    if (!p) return { pct: 0, rule: 'Ingen stigning', cls: 'none' };
    if (RULES.storageExempt.test(text)) return { pct: 0, rule: 'Storage undtaget', cls: 'none' };
    return { pct: p, rule: `Regional +${p} %`, cls: 'up' };
  }
  return { pct: 0, rule: 'Ingen stigning', cls: 'none' };
}
const isGlobal = item => !item.armRegionName || /^(global|zone|intercontinental|unknown)/i.test(item.armRegionName) || /^(global|zone)/i.test(item.location || '');
const comboKey = item => `${item.productId}|${item.skuName}|${item.meterName}`;
function pickTier(items, preferTier) {
  if (!items || !items.length) return null;
  if (preferTier != null) {
    const same = items.find(i => i.tierMinimumUnits === preferTier && i.retailPrice > 0);
    if (same) return same;
  }
  const paid = items.filter(i => i.retailPrice > 0).sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  return paid[0] || items[0];
}

// ---------------------------------------------------------------------------
// Indlæsning af CSV
// ---------------------------------------------------------------------------
function parseFile(file) {
  state.file = file; state.parsed = null; state.results = null;
  $('#results').hidden = true; $('#run').disabled = true;
  const prog = $('#parseprog'); prog.hidden = false; prog.value = 0;
  setStatus('Læser filen …');

  const agg = new Map();
  const excluded = { cost: 0, rows: 0, types: new Map() };
  let col = null, rows = 0, currency = '', minD = Infinity, maxD = -Infinity, hasRes = false, resZeroCost = 0;

  Papa.parse(file, {
    header: true, skipEmptyLines: true, transformHeader: normHeader,
    chunk(res, parser) {
      if (!col) {
        const fields = new Set(res.meta.fields);
        col = {};
        for (const [k, cands] of Object.entries(COLS)) col[k] = cands.find(c => fields.has(c)) || null;
        if (!col.meterId || !col.cost) {
          parser.abort();
          setStatus('Filen ligner ikke en cost details-eksport: kolonnerne MeterId og CostInBillingCurrency (eller tilsvarende) mangler.', true);
          prog.hidden = true;
          col = { failed: true };
          return;
        }
      }
      if (col.failed) return;
      for (const r of res.data) {
        rows++;
        const cost = num(r[col.cost]);
        if (!currency && col.currency && r[col.currency]) currency = String(r[col.currency]).trim().toUpperCase();
        if (col.date) { const d = parseDate(r[col.date]); if (d != null) { if (d < minD) minD = d; if (d > maxD) maxD = d; } }
        const charge = col.chargeType ? String(r[col.chargeType] || '').trim() : 'Usage';
        if (charge && !/^usage$/i.test(charge)) {
          excluded.cost += cost; excluded.rows++;
          excluded.types.set(charge, (excluded.types.get(charge) || 0) + cost);
          continue;
        }
        const meterId = String(r[col.meterId] || '').trim().toLowerCase();
        const isRes = col.pricingModel ? /reservation|committed/i.test(r[col.pricingModel] || '') : false;
        if (isRes) { hasRes = true; if (cost === 0) resZeroCost++; }
        const key = (meterId || `none:${r[col.category] || ''}`) + (isRes ? '|R' : '');
        let a = agg.get(key);
        if (!a) {
          const category = col.category ? r[col.category] || '' : '';
          const subcat = col.subcat ? r[col.subcat] || '' : '';
          const meterName = col.meterName ? r[col.meterName] || '' : '';
          const product = col.product ? r[col.product] || '' : '';
          a = { meterId, isRes, category, subcat, meterName, product, cost: 0, qty: 0, resources: new Set(), locations: new Set(),
                interzone: RULES.interzone.test(`${category} ${subcat} ${meterName} ${product}`) };
          agg.set(key, a);
        }
        a.cost += cost;
        a.qty += col.quantity ? num(r[col.quantity]) : 0;
        if (col.resourceId && r[col.resourceId]) a.resources.add(String(r[col.resourceId]).toLowerCase());
        if (col.location && r[col.location]) a.locations.add(String(r[col.location]));
      }
      prog.value = file.size ? Math.min(1, res.meta.cursor / file.size) : 0;
    },
    complete() {
      prog.hidden = true;
      if (!col || col.failed) return;
      const days = Number.isFinite(minD) ? Math.round((maxD - minD) / 864e5) + 1 : null;
      state.parsed = { agg: [...agg.values()], excluded, rows, currency: currency || 'USD', minD, maxD, days, hasRes, resZeroCost };
      try { fmtMoney = new Intl.NumberFormat('da-DK', { style: 'currency', currency: state.parsed.currency, maximumFractionDigits: 0 }); }
      catch { fmtMoney = new Intl.NumberFormat('da-DK', { maximumFractionDigits: 0 }); }
      $('#optMonthly').disabled = !days;
      renderFileMeta();
      $('#run').disabled = false;
      setStatus(`Filen er læst. ${fmtNum(state.parsed.agg.length)} unikke meters er klar til prisopslag.`);
    },
    error(err) { prog.hidden = true; setStatus(`Filen kunne ikke læses: ${err.message}`, true); }
  });
}

function renderFileMeta() {
  const p = state.parsed, el = $('#filemeta');
  const total = p.agg.reduce((s, a) => s + a.cost, 0);
  const period = p.days ? `${new Date(p.minD).toLocaleDateString('da-DK')} til ${new Date(p.maxD).toLocaleDateString('da-DK')} (${p.days} dage)` : 'Ukendt';
  let html = `<dl>
    <dt>Fil</dt><dd>${esc(state.file.name)}</dd>
    <dt>Periode</dt><dd>${period}</dd>
    <dt>Rækker</dt><dd>${fmtNum(p.rows)}</dd>
    <dt>Forbrug</dt><dd>${fmtMoney.format(total)} ${esc(p.currency)}</dd>`;
  if (p.excluded.rows) html += `<dt>Ikke medregnet</dt><dd>${fmtMoney.format(p.excluded.cost)} (${[...p.excluded.types.keys()].map(esc).join(', ')})</dd>`;
  html += '</dl>';
  if (p.hasRes && p.resZeroCost > 0) html += `<p class="small" style="margin-top:8px;color:var(--warn)">Filen indeholder reservationsforbrug til 0 kr. Brug en amortiseret eksport for at få reservationer med i beregningen.</p>`;
  el.innerHTML = html; el.hidden = false;
}

// ---------------------------------------------------------------------------
// Prisopslag
// ---------------------------------------------------------------------------
async function api(filter) {
  const res = await fetch(`${API}?currency=USD&filter=${encodeURIComponent(filter)}`);
  if (!res.ok) {
    let msg = `Prisopslag fejlede (${res.status})`;
    try { const j = await res.json(); if (j.error) msg += `: ${j.error}`; } catch {}
    throw new Error(msg);
  }
  return (await res.json()).items || [];
}
async function pool(tasks, size, onDone) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (i < tasks.length) { const t = tasks[i++]; await t(); onDone(); }
  });
  await Promise.all(workers);
}
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function lookupPrices() {
  const prog = $('#lookprog'); prog.hidden = false; prog.value = 0;

  // 1) Kildemeters
  const ids = [...new Set(state.parsed.agg.map(a => a.meterId).filter(id => id && !state.src.has(id)))];
  const srcTasks = chunk(ids, 10).map(batch => async () => {
    const f = `type eq 'Consumption' and (${batch.map(id => `meterId eq '${odata(id)}'`).join(' or ')})`;
    const items = await api(f);
    const by = new Map();
    for (const it of items) { const k = String(it.meterId).toLowerCase(); (by.get(k) || by.set(k, []).get(k)).push(it); }
    for (const id of batch) {
      const list = by.get(id) || [];
      state.src.set(id, list.length ? { ref: pickTier(list), tiers: list } : null);
    }
  });

  // 2) Samme meter i hver målregion (efter kilderne er kendt)
  let done = 0, total = srcTasks.length;
  const tick = () => { done++; prog.value = total ? done / total : 1; setStatus(`Slår priser op … ${done} af ${total}`); };
  await pool(srcTasks, 4, tick);

  const tgtTasks = [];
  for (const region of state.selected) {
    const combos = new Map();
    for (const a of state.parsed.agg) {
      const s = a.meterId && state.src.get(a.meterId);
      if (!s || isGlobal(s.ref) || s.ref.armRegionName === region) continue;
      const k = comboKey(s.ref);
      if (!state.tgt.has(`${region}|${k}`)) combos.set(k, s.ref);
    }
    for (const batch of chunk([...combos.values()], 5)) {
      tgtTasks.push(async () => {
        const parts = batch.map(it => `(productId eq '${odata(it.productId)}' and skuName eq '${odata(it.skuName)}' and meterName eq '${odata(it.meterName)}')`);
        const items = await api(`armRegionName eq '${odata(region)}' and type eq 'Consumption' and (${parts.join(' or ')})`);
        const by = new Map();
        for (const it of items) { const k = comboKey(it); (by.get(k) || by.set(k, []).get(k)).push(it); }
        for (const it of batch) {
          const k = comboKey(it);
          state.tgt.set(`${region}|${k}`, by.has(k) ? by.get(k) : null);
        }
      });
    }
  }
  total += tgtTasks.length;
  await pool(tgtTasks, 4, tick);
  prog.hidden = true;
}

// ---------------------------------------------------------------------------
// Beregning
// ---------------------------------------------------------------------------
function compute() {
  const p = state.parsed;
  const opts = { interzone: $('#optInterzone').checked, riProtect: $('#optRI').checked };
  const factor = $('#optMonthly').checked && p.days ? 30.4375 / p.days : 1;
  const scenarios = ['current', ...state.selected];
  const out = {};
  let interzoneCost = 0;

  for (const sc of scenarios) out[sc] = { today: 0, feb: 0, unpriced: 0, unpricedN: 0, unavailable: 0, unavailableN: 0, cats: new Map(), rows: [] };

  for (const a of p.agg) {
    if (opts.interzone && a.interzone) { interzoneCost += a.cost * factor; continue; }
    const cost = a.cost * factor;
    const s = a.meterId ? state.src.get(a.meterId) : null;

    for (const sc of scenarios) {
      const o = out[sc];
      let ratio = 1, up = { pct: 0, rule: '', cls: 'none' }, flag = '';
      if (!s) {
        flag = 'Ukendt meter'; o.unpriced += cost; o.unpricedN++;
        up = { pct: 0, rule: 'Ukendt meter, uændret', cls: 'warn' };
      } else if (isGlobal(s.ref)) {
        up = upliftFor(s.ref, '', a.isRes, opts);
        up = up.pct ? up : { pct: 0, rule: 'Global meter', cls: 'none' };
      } else {
        const srcRegion = s.ref.armRegionName;
        const region = sc === 'current' ? srcRegion : sc;
        let item = s.ref;
        if (region !== srcRegion) {
          const tiers = state.tgt.get(`${region}|${comboKey(s.ref)}`);
          const t = tiers ? pickTier(tiers, s.ref.tierMinimumUnits) : null;
          if (!t) {
            flag = 'Ikke tilgængelig'; o.unavailable += cost; o.unavailableN++;
          } else {
            item = t;
            ratio = s.ref.retailPrice > 0 ? t.retailPrice / s.ref.retailPrice : 1;
          }
        }
        up = flag ? { pct: 0, rule: 'Ikke tilgængelig, uændret', cls: 'warn' } : upliftFor(item, region, a.isRes, opts);
      }
      const today = cost * ratio, feb = today * (1 + up.pct / 100);
      o.today += today; o.feb += feb;
      const cat = a.category || s?.ref?.serviceName || 'Ukendt';
      const c = o.cats.get(cat) || { base: 0, today: 0, feb: 0 };
      c.base += cost; c.today += today; c.feb += feb; o.cats.set(cat, c);
      o.rows.push({ a, s, base: cost, ratio, today, feb, up, flag });
    }
  }
  state.results = { out, scenarios, interzoneCost, factor };
}

// ---------------------------------------------------------------------------
// Visning
// ---------------------------------------------------------------------------
function renderResults() {
  const { out, scenarios, interzoneCost, factor } = state.results;
  const cur = out.current;
  const max = Math.max(...scenarios.map(s => out[s].feb), cur.today) || 1;
  const order = ['current', ...scenarios.filter(s => s !== 'current').sort((x, y) => out[x].feb - out[y].feb)];

  const sum = [];
  sum.push(`<span>Grundlag: <b>${fmtMoney.format(cur.today)}</b>${factor !== 1 ? ' pr. måned' : ' for perioden'}</span>`);
  if (interzoneCost) sum.push(`<span>Udeladt inter-zone trafik: <b>${fmtMoney.format(interzoneCost)}</b></span>`);
  if (cur.unpricedN) sum.push(`<span>Ukendte meters: <b>${fmtMoney.format(cur.unpriced)}</b> medtaget uændret</span>`);
  $('#summary').innerHTML = sum.join('');

  let html = `<thead><tr><th scope="col">Region</th><th scope="col">I dag</th><th scope="col">Fra ${RULES.effective}</th><th scope="col">Ændring mod nu</th><th scope="col" class="barcell"><span class="sr-only">Udvikling</span></th></tr></thead><tbody>`;
  for (const sc of order) {
    const o = out[sc];
    const delta = cur.today ? (o.feb - cur.today) / cur.today : 0;
    const dcls = Math.abs(delta) < 0.0005 ? 'flat' : delta > 0 ? 'up' : 'down';
    const name = sc === 'current' ? 'Nuværende placering' : regionLabel(sc);
    const code = sc === 'current' ? 'Hver ressource i sin nuværende region' : sc;
    const wT = (o.today / max) * 100, wF = (o.feb / max) * 100, wR = (cur.today / max) * 100;
    const warn = o.unavailableN ? `<span class="badge" title="${fmtMoney.format(o.unavailable)} kunne ikke prissættes i regionen">${o.unavailableN} ikke tilgængelige</span>` : '';
    html += `<tr class="row ${sc === 'current' ? 'current' : ''} ${state.active === sc ? 'active' : ''}" data-sc="${esc(sc)}" tabindex="0">
      <td><span class="region-name">${esc(name)}</span>${warn}<span class="region-code">${esc(code)}</span></td>
      <td class="num-big">${fmtMoney.format(o.today)}</td>
      <td class="num-big">${fmtMoney.format(o.feb)}</td>
      <td><span class="delta ${dcls}">${fmtPct(delta)}</span></td>
      <td class="barcell"><div class="bar" aria-hidden="true"><span class="today" style="width:${wT}%"></span><span class="rise" style="left:${wT}%;width:${Math.max(0, wF - wT)}%"></span><span class="ref" style="left:calc(${wR}% - 1px)"></span></div></td>
    </tr>`;
  }
  html += '</tbody>';
  $('#matrix').innerHTML = html;
  $('#matrix').querySelectorAll('tr.row').forEach(tr => {
    const pick = () => { state.active = tr.dataset.sc; renderResults(); $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });
  renderDetail();
  $('#results').hidden = false;
}

function renderDetail() {
  const { out } = state.results;
  const sc = out[state.active] ? state.active : 'current';
  const o = out[sc];
  const name = sc === 'current' ? 'Nuværende placering' : regionLabel(sc);
  const cats = [...o.cats.entries()].sort((x, y) => y[1].feb - x[1].feb);

  let html = `<div class="detail-head"><h2>${esc(name)}</h2><button class="btn ghost" id="dl" type="button">Download som CSV</button></div>
  <h3>Fordeling på tjenester</h3><div class="tablewrap"><table class="data"><thead><tr>
    <th scope="col">Tjeneste</th><th scope="col">Nuværende pris</th><th scope="col">I dag her</th><th scope="col">Fra ${RULES.effective}</th><th scope="col">Ændring</th></tr></thead><tbody>`;
  for (const [cat, c] of cats) {
    const d = c.base ? (c.feb - c.base) / c.base : 0;
    html += `<tr><td>${esc(cat)}</td><td>${fmtMoney.format(c.base)}</td><td>${fmtMoney.format(c.today)}</td><td>${fmtMoney.format(c.feb)}</td><td><span class="delta ${Math.abs(d) < 0.0005 ? 'flat' : d > 0 ? 'up' : 'down'}">${fmtPct(d)}</span></td></tr>`;
  }
  html += '</tbody></table></div>';

  const top = [...o.rows].sort((x, y) => y.feb - x.feb).slice(0, 30);
  html += `<h3>Største meters</h3><div class="tablewrap"><table class="data"><thead><tr>
    <th scope="col">Meter</th><th scope="col">Kører i dag i</th><th scope="col">Prisforhold</th><th scope="col">I dag her</th><th scope="col">Fra ${RULES.effective}</th><th scope="col">Regel</th></tr></thead><tbody>`;
  for (const r of top) {
    const srcRegion = r.s ? (r.s.ref.armRegionName || 'global') : [...r.a.locations].join(', ') || 'ukendt';
    const size = r.s?.ref?.armSkuName ? ` (${esc(r.s.ref.armSkuName)})` : '';
    html += `<tr>
      <td class="meter">${esc(r.a.meterName || r.s?.ref?.meterName || '(uden meter)')}${size}<span class="sub">${esc(r.a.category)}${r.a.subcat ? ', ' + esc(r.a.subcat) : ''}${r.a.isRes ? ', reservation' : ''}${r.a.resources.size ? `, ${r.a.resources.size} ressourcer` : ''}</span></td>
      <td>${esc(srcRegion)}</td>
      <td>${r.flag ? '–' : fmtNum(r.ratio, 3)}</td>
      <td>${fmtMoney.format(r.today)}</td>
      <td>${fmtMoney.format(r.feb)}</td>
      <td><span class="rule ${r.up.cls}">${esc(r.up.rule)}</span></td></tr>`;
  }
  html += '</tbody></table></div>';
  if (o.unavailableN) html += `<p class="small" style="margin-top:10px;color:var(--warn)">${o.unavailableN} meters (${fmtMoney.format(o.unavailable)}) findes ikke i ${esc(name)}. Typisk en VM-størrelse eller tjeneste, der ikke udbydes i regionen. De er medtaget med nuværende pris.</p>`;
  $('#detail').innerHTML = html;
  $('#dl').addEventListener('click', () => downloadCsv(sc));
}

function downloadCsv(sc) {
  const o = state.results.out[sc];
  const head = ['MeterId', 'MeterCategory', 'MeterSubCategory', 'MeterName', 'ArmSkuName', 'Reservation', 'SourceRegion', 'TargetRegion', 'PriceRatio', 'CostNow', 'CostToday', 'CostFeb2027', 'UpliftPct', 'Rule', 'Resources'];
  const lines = [head.join(';')];
  for (const r of o.rows) {
    const src = r.s ? r.s.ref.armRegionName : '';
    const vals = [r.a.meterId, r.a.category, r.a.subcat, r.a.meterName, r.s?.ref?.armSkuName || '', r.a.isRes ? 'ja' : 'nej',
      src, sc === 'current' ? src : sc, r.ratio.toFixed(4), r.base.toFixed(2), r.today.toFixed(2), r.feb.toFixed(2), r.up.pct, r.up.rule, r.a.resources.size];
    lines.push(vals.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `azure-regionspriser-${sc}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function renderChips() {
  $('#chips').innerHTML = [...state.regions.entries()].map(([code, label]) => {
    const r = RULES.regional[code];
    return `<label class="chip"><input type="checkbox" value="${esc(code)}" ${state.selected.has(code) ? 'checked' : ''}><span>${esc(label)}${r ? `<span class="flag">+${r} %</span>` : ''}</span></label>`;
  }).join('');
  $('#chips').querySelectorAll('input').forEach(i => i.addEventListener('change', () => {
    i.checked ? state.selected.add(i.value) : state.selected.delete(i.value);
    if (state.results) setStatus('Regionsvalget er ændret. Beregn igen for at opdatere.');
  }));
}
function renderRateTable() {
  $('#ratetable').innerHTML = Object.entries(RULES.regional).sort((a, b) => b[1] - a[1])
    .map(([r, p]) => `<tr><td>${esc(regionLabel(r))}</td><td>+${p} %</td></tr>`).join('');
}

$('#addregion').addEventListener('click', () => {
  const v = $('#customregion').value.trim().toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z0-9]+$/.test(v)) { setStatus('Skriv regionens armRegionName, f.eks. italynorth.', true); return; }
  if (!state.regions.has(v)) state.regions.set(v, v);
  state.selected.add(v); $('#customregion').value = ''; renderChips();
});
$('#customregion').addEventListener('keydown', e => { if (e.key === 'Enter') $('#addregion').click(); });

const fileInput = $('#file'), drop = $('#drop');
fileInput.addEventListener('change', () => fileInput.files[0] && parseFile(fileInput.files[0]));
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) parseFile(f); });

$('#run').addEventListener('click', async () => {
  if (!state.parsed) return;
  $('#run').disabled = true;
  try {
    await lookupPrices();
    compute(); renderResults();
    const unknown = state.parsed.agg.filter(a => a.meterId && !a.interzone && state.src.get(a.meterId) === null).length;
    setStatus(`Færdig. ${unknown ? `${unknown} meters fandtes ikke i prislisten og er medtaget uændret.` : 'Alle meters blev fundet i prislisten.'}`);
  } catch (err) {
    setStatus(err.message + '. Kører API\'et? Lokalt skal siden startes med swa start.', true);
  } finally { $('#run').disabled = false; }
});
['#optInterzone', '#optRI', '#optMonthly'].forEach(id => $(id).addEventListener('change', () => { if (state.results) { compute(); renderResults(); } }));

renderChips(); renderRateTable();
