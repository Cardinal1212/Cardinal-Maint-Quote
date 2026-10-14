# Cardinal Instant Quote

Static instant-quote page for Cardinal Landscape Associates. Hosted on GitHub Pages.

- `lawn/index.html` — the lawn quote page (root `index.html` redirects here). `/patio/` is reserved for a hardscape quote tool.
- `assets/` — logo and icon.
- `worker/` — Cloudflare Worker that pushes leads into Jobber. Pricing lives in the `PRICING` block at the top of the `<script>`.
- Lot size comes from Cook County Assessor open data, Will County GIS, and the Indiana statewide parcel layer, called from the browser.
