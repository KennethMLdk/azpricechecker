# Azure Region Price Calculator

Upload an Azure Cost Management export and see what the same usage would cost in other Azure regions, at today's prices and after the price increases Microsoft announced for **1 February 2027**.

- Compares any number of target regions side by side, plus "where everything runs today".
- Keeps your negotiated discount: new cost = your actual cost × (list price in target region ÷ list price in current region).
- Applies the announced increases: regional increases for VMs and storage in seven regions, and roughly 25 % for legacy v1/v2 VM series in all regions, with the published exemptions.
- Optionally excludes inter-availability-zone traffic and protects existing reservations.
- Flags meters that do not exist in a target region (for example a VM size not offered there).
- Drill down per service and per meter, and download the result as CSV.

The UI is in Danish. Translations are welcome.

## Privacy

The CSV is parsed entirely in the browser. The only data sent to the server are meter IDs and product/SKU/meter names, which the API forwards to Microsoft's public [Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices). The proxy is needed because that API cannot be called from a browser.

## Repository layout

```
app/index.html                 Page and styles
app/app.js                     Parsing, price lookups, calculation, rendering
app/rules.js                   Announced price increases and exemptions (edit here)
app/staticwebapp.config.json   Node runtime for the API and security headers
api/src/functions/prices.js    Azure Function proxy to the Retail Prices API
tests/e2e.test.js              End-to-end test with a mocked price API
```

## Deploy your own

1. Fork this repository.
2. Create a Static Web App (the Free plan is enough):
   ```bash
   az staticwebapp create -n azure-region-calc -g <resource-group> -l westeurope --sku Free
   az staticwebapp secrets list -n azure-region-calc --query properties.apiKey -o tsv
   ```
3. Add the token as the repository secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.
4. Push to `main`. The `Deploy` workflow publishes `app/` and `api/`.

To restrict access to signed-in users, add a route with `"allowedRoles": ["authenticated"]` to `app/staticwebapp.config.json`. Restricting to a single Entra ID tenant requires a custom identity provider on the Standard plan.

## Run locally

```bash
npm install -g @azure/static-web-apps-cli
cd api && npm install && cd ..
swa start app --api-location api
```

## Which export to use

In Cost Management, create an export of type **Cost and usage details (amortized)**, or download usage details from Cost analysis. One month is usually enough. Use the amortized variant if you have reservations or savings plans; otherwise reservation usage shows as 0. Column names from EA, MCA and (best effort) FOCUS exports are recognised.

## Price rules

As announced in October 2026, effective 1 February 2027:

| Region | Increase |
|---|---|
| North Europe (Dublin) | 17 % |
| France Central, France South | 11 % |
| West Europe (Amsterdam), Norway East, Norway West | 9 % |
| Southeast Asia (Singapore) | 8 % |

- Regional increases apply to virtual machines and most storage.
- Legacy series (Bv1, D, Ds, F, Fs, G, Gs, Ls, NP, HC, Av2, Amv2, Dv2, Dsv2, Fsv2, Lsv2) increase about 25 % in all regions, instead of the regional increase.
- Exempt from the regional increase: v7 VMs, Queues, Tables, General Block Blob, Standard Page Blob, Transaction Optimized and Azure Container Storage.

All of this lives in `app/rules.js`. If Microsoft changes the announcement, please open a "Price rule update" issue or a PR with a link to the source.

## Limitations

- Pay-as-you-go list prices are used as ratios. Negotiated EA/MCA prices may differ between regions in other ways.
- Tiered meters are calculated at the lowest paid tier.
- It is not confirmed how existing reservations are treated under the regional increase. The "exempt reservation usage" option assumes they are protected until expiry.
- This is an estimate, not a quote. Verify important decisions with the Azure pricing calculator or your Microsoft account team.

## License

[MIT](LICENSE)
