// Proxy til Azure Retail Prices API.
// Browseren må ikke kalde prices.azure.com direkte (CORS), så siden kalder /api/prices,
// som videresender et OData-filter og samler alle sider af resultatet.
const { app } = require('@azure/functions');

const BASE = 'https://prices.azure.com/api/retail/prices';
const API_VERSION = '2023-01-01-preview';
const MAX_PAGES = 20;
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE = 5000;
const cache = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.status === 429 || res.status >= 500) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`Retail Prices API svarede ${res.status}`);
    return res.json();
  }
  throw new Error('Retail Prices API svarer ikke (for mange forsøg)');
}

app.http('prices', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'prices',
  handler: async (request, context) => {
    const filter = request.query.get('filter') || '';
    const currency = (request.query.get('currency') || 'USD').toUpperCase();

    if (!filter || filter.length > 4000) {
      return { status: 400, jsonBody: { error: 'Parameteren filter mangler eller er for lang.' } };
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      return { status: 400, jsonBody: { error: 'Ugyldig valutakode.' } };
    }

    const key = `${currency}|${filter}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < TTL_MS) {
      return { jsonBody: { items: hit.items, cached: true } };
    }

    try {
      let url = `${BASE}?api-version=${API_VERSION}&currencyCode='${currency}'&$filter=${encodeURIComponent(filter)}`;
      const items = [];
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const data = await getJson(url);
        items.push(...(data.Items || []));
        const next = data.NextPageLink;
        // Følg kun links tilbage til samme API
        url = next && next.startsWith(BASE) ? next : null;
      }
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, { t: Date.now(), items });
      return { jsonBody: { items } };
    } catch (err) {
      context.error(err);
      return { status: 502, jsonBody: { error: err.message } };
    }
  }
});
