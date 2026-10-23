# Contributing

Contributions are welcome, especially:

- **Price rule updates** in `app/rules.js` when Microsoft changes an announcement. Please link the source in the PR.
- **Export formats**: if your Cost Management export uses column names the parser does not recognise, add them to `COLS` in `app/app.js`.
- **Translations**: the UI is currently Danish.

## Development

```bash
npm install
npm test                 # jsdom end-to-end test with a mocked price API
npm install -g @azure/static-web-apps-cli
cd api && npm install && cd ..
npm start                # swa start app --api-location api
```

Never commit real cost exports. `*.csv` is ignored by default.
