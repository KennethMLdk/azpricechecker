// End-to-end test: loads the page in jsdom, mocks the price API and checks the calculation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const APP = path.join(__dirname, '..', 'app');
const read = f => fs.readFileSync(f, 'utf8');
const inline = code => () => `<script>${code}</script>`;

function buildHtml() {
  let html = read(path.join(APP, 'index.html'));
  html = html.replace(/<link[^>]*fonts[^>]*>/g, '');
  html = html.replace(/<script src="https:\/\/cdnjs[^>]*><\/script>/, inline(read(require.resolve('papaparse/papaparse.min.js'))));
  html = html.replace('<script src="rules.js"></script>', inline(read(path.join(APP, 'rules.js'))));
  html = html.replace('<script src="app.js"></script>', inline(read(path.join(APP, 'app.js'))));
  return html;
}

// Fake price catalogue: same meters in four regions with different multipliers.
const REGIONS = { westeurope: 1, northeurope: 0.95, swedencentral: 0.9, germanywestcentral: 1.05 };
const id = (m, r) => `${m}-${r}`.padEnd(36, '0');
const catalogue = [];
function add(m, svc, extra = {}) {
  for (const [r, mult] of Object.entries(REGIONS)) {
    if (extra.only && !extra.only.includes(r)) continue;
    catalogue.push({ meterId: id(m, r), armRegionName: r, location: r, retailPrice: mult, tierMinimumUnits: 0, type: 'Consumption',
      productId: 'P' + m, skuName: 'S' + m, meterName: 'N' + m, productName: extra.productName || 'Product ' + m, serviceName: svc, armSkuName: extra.sku || '' });
  }
}
add('vm5', 'Virtual Machines', { sku: 'Standard_D4s_v5' });
add('vm2', 'Virtual Machines', { sku: 'Standard_D2_v2' });
add('disk', 'Storage', { productName: 'Premium SSD Managed Disks' });
add('blob', 'Storage', { productName: 'General Block Blob' });
add('e8', 'Virtual Machines', { sku: 'Standard_E8s_v3', only: ['westeurope', 'northeurope', 'germanywestcentral'] });
catalogue.push({ meterId: 'global-def'.padEnd(36, '0'), armRegionName: '', location: 'Global', retailPrice: 1, tierMinimumUnits: 0, type: 'Consumption',
  productId: 'Pg', skuName: 'Sg', meterName: 'Ng', productName: 'Defender', serviceName: 'Microsoft Defender for Cloud' });

function mockFetch(url) {
  const f = new URL(url, 'http://x').searchParams.get('filter');
  let items;
  if (f.includes('meterId eq')) {
    const ids = [...f.matchAll(/meterId eq '([^']+)'/g)].map(m => m[1]);
    items = catalogue.filter(c => ids.includes(c.meterId));
  } else {
    const r = /armRegionName eq '([^']+)'/.exec(f)[1];
    const prods = [...f.matchAll(/productId eq '([^']+)'/g)].map(m => m[1]);
    items = catalogue.filter(c => c.armRegionName === r && prods.includes(c.productId));
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ items }) });
}

const csv = [
  '\uFEFFDate,MeterId,MeterCategory,MeterSubCategory,MeterName,ResourceLocation,ResourceId,Quantity,CostInBillingCurrency,BillingCurrencyCode,ChargeType,PricingModel',
  `10/01/2026,${id('vm5', 'westeurope')},Virtual Machines,Dsv5 Series,D4s v5,EU West,/sub/a/vm1,720,1000,DKK,Usage,OnDemand`,
  `10/31/2026,${id('vm2', 'northeurope')},Virtual Machines,Dv2 Series,D2 v2,EU North,/sub/a/vm2,720,500,DKK,Usage,OnDemand`,
  `10/15/2026,${id('disk', 'westeurope')},Storage,Premium SSD Managed Disks,P10 LRS Disk,EU West,/sub/a/disk1,1,200,DKK,Usage,OnDemand`,
  `10/15/2026,${id('blob', 'westeurope')},Storage,General Block Blob,LRS Data Stored,EU West,/sub/a/st1,100,100,DKK,Usage,OnDemand`,
  `10/15/2026,${'iaz'.padEnd(36, '0')},Bandwidth,Inter-Availability Zone,Inter-Availability Zone Data Transfer In,EU West,/sub/a/vm1,10,50,DKK,Usage,OnDemand`,
  `10/15/2026,${'global-def'.padEnd(36, '0')},Microsoft Defender for Cloud,Standard,Standard Node,Unassigned,/sub/a/vm1,1,80,DKK,Usage,OnDemand`,
  `10/15/2026,${'unknown'.padEnd(36, '0')},Foo,Bar,Baz,EU West,/sub/a/x,1,10,DKK,Usage,OnDemand`,
  `10/15/2026,,Reservations,,,,,1,3000,DKK,Purchase,Reservation`,
  `10/15/2026,${id('e8', 'westeurope')},Virtual Machines,Esv3 Series,E8s v3,EU West,/sub/a/vm3,720,300,DKK,Usage,Reservation`
].join('\n');

const wait = ms => new Promise(r => setTimeout(r, ms));

async function load() {
  const dom = new JSDOM(buildHtml(), {
    runScripts: 'dangerously', url: 'http://localhost/',
    beforeParse(w) { w.fetch = mockFetch; w.HTMLElement.prototype.scrollIntoView = () => {}; }
  });
  const w = dom.window;
  w.eval('parseFile')(new w.File([csv], 'test.csv', { type: 'text/csv' }));
  for (let i = 0; i < 50 && !w.eval('state.parsed'); i++) await wait(20);
  w.document.querySelector('#run').click();
  for (let i = 0; i < 100 && !w.eval('state.results'); i++) await wait(20);
  return w;
}

test('parses the export and excludes non-usage rows', async () => {
  const w = await load();
  const p = w.eval('state.parsed');
  assert.equal(p.currency, 'DKK');
  assert.equal(p.days, 31);
  assert.equal(p.excluded.cost, 3000);
});

test('applies regional, legacy and exemption rules in West Europe', async () => {
  const w = await load();
  const rows = w.eval('state.results').out.westeurope.rows;
  const by = name => rows.find(r => r.a.meterName === name);
  assert.equal(by('D4s v5').feb, 1090);                         // +9 % regional
  assert.ok(Math.abs(by('D2 v2').feb - 500 / 0.95 * 1.25) < 1e-9); // moved + 25 % legacy
  assert.equal(by('LRS Data Stored').feb, 100);                 // storage exemption
  assert.equal(by('E8s v3').up.rule, 'Reservation fritaget');
  assert.equal(by('Standard Node').feb, 80);                    // global meter
});

test('excludes inter-zone traffic and flags unavailable sizes', async () => {
  const w = await load();
  const r = w.eval('state.results');
  assert.equal(r.interzoneCost, 50);
  assert.equal(r.out.swedencentral.unavailableN, 1);
  assert.ok(!r.out.westeurope.rows.some(x => x.a.interzone));
});

test('Sweden Central has no regional increase', async () => {
  const w = await load();
  const vm = w.eval('state.results').out.swedencentral.rows.find(r => r.a.meterName === 'D4s v5');
  assert.equal(vm.up.pct, 0);
  assert.ok(Math.abs(vm.today - 900) < 1e-9);
});
