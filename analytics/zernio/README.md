# Zernio post analytics

Standalone. Nothing here is imported by the rest of the repo.

- `fetch.ts` pulls every post, per-post analytics, daily snapshots, account insights,
  follower history, demographics and Zernio's aggregate models into `data/`.
- `data/raw/*.json` are the verbatim API responses. `data/dataset.json` is the
  normalised dataset; `data/dataset.js` is the same thing wrapped for the page.
- `index.html` is the dashboard. Open it directly (file://) or serve the folder.

Refresh the data:

```sh
ZERNIO_API_KEY=sk_... bun analytics/zernio/fetch.ts
```

Then reload `index.html`.
