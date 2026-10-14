# cardinal-quote-leads (Cloudflare Worker)

Receives the quote page's booking form and creates the client, property and request in Jobber.

Deploy: Cloudflare dashboard → Workers & Pages → Create → connect this GitHub repo, root directory `worker`, deploy command `npx wrangler deploy`.
Secrets: JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET, then visit `/oauth/start` once and save the shown JOBBER_REFRESH_TOKEN.
Jobber app settings: redirect URI must be `https://<worker-url>/oauth/callback`; turn Refresh Token Rotation OFF.
