/* Cardinal instant-quote → Jobber lead bridge.
   Routes:
     GET  /oauth/start     one-time: sends you to Jobber to authorize this app
     GET  /oauth/callback  one-time: shows the refresh token to save as a secret
     POST /lead            site form → Jobber client (matched or created) + property + request + draft quote
     GET  /                health
   Vars: ALLOWED_ORIGINS, JOBBER_API_VERSION, QUOTE_MODE ("draft" | "off"), DEPOSIT ("first_mow" | a dollar amount | "none")
   Secrets: JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET, JOBBER_REFRESH_TOKEN
*/
const JOBBER = 'https://api.getjobber.com/api';
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extra } });

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const ok = allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  return { 'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Vary': 'Origin' };
}

/* ---------- Jobber auth ---------- */
let cached = { token: null, exp: 0 };
async function accessToken(env) {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.JOBBER_CLIENT_ID, client_secret: env.JOBBER_CLIENT_SECRET, refresh_token: env.JOBBER_REFRESH_TOKEN });
  const r = await fetch(JOBBER + '/oauth/token', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  if (!r.ok) throw new Error('Jobber token refresh failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return cached.token;
}
async function gql(env, query, variables) {
  const token = await accessToken(env);
  const r = await fetch(JOBBER + '/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token, 'X-JOBBER-GRAPHQL-VERSION': env.JOBBER_API_VERSION || '2025-04-16' },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json();
  if (d.errors && d.errors.length) throw new Error('Jobber: ' + d.errors.map(e => e.message).join('; '));
  return d.data;
}
const ue = (payload, name) => { const u = payload?.userErrors || []; if (u.length) throw new Error(name + ': ' + u.map(e => e.message).join('; ')); };

/* ---------- Jobber products (IDs from the Cardinal account) ---------- */
const PRODUCTS = {
  mow:    { id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvNjkwODkyMw==', name: 'Weekly Lawn Maintenance' },
  fert:   { id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvNjkwODkyNQ==', name: '5 Step Fertilizer Program' },
  aerS:   { id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvNjkwODkyNA==', name: 'Spring Lawn Aeration and Overseeding' },
  aerF:   { id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvNzk3NjYzMg==', name: 'Fall Lawn Aeration and Overseeding' },
  spring: { id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvNzA4MzQwMA==', name: 'Spring cleanup' },
  fall1:  { id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvODQ5MjQ1MQ==', name: 'Single Visit Fall Cleanup' },
  fall2:  { id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvMTg4ODMwMTU=', name: '2 Visit Fall Cleanup' },
  gutS:   { id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvMTg4ODE1NDM=', name: 'Spring Gutter Cleaning Special' },
  gutF:   { id: 'Z2lkOi8vSm9iYmVyL1Byb2R1Y3RPclNlcnZpY2UvNjk4MjczMA==', name: 'Fall Gutter Cleaning Special' },
};
const DESC = {
  mow: 'Professionally maintaining all lawn areas on a weekly basis. Included services are weekly mowing, line trimming and blowing with biweekly edging.\nMowing begins around the first of April through the end of November, depending on the weather.\nPricing is for weekly service.\n***FIRST MOW PRICING IS SUBJECT TO CHANGE BASED ON OVERGROWTH***',
  fert: 'Broadcast spread fertilizer throughout entire lawn. We offer a 5 step program. Pricing is per application. Application dates will vary depending on weather conditions.\nWe only offer fertilizer program if paired with our weekly maintenance services.',
  aer: 'Core aeration relieves soil compaction, reduces thatch buildup, promotes deep root growth, and lets nutrients reach the roots. Includes overseeding for a thicker, healthier lawn.',
  spring: 'Blowing out all leaves, sticks and twigs from mulch/stone beds and bushes. We then blow all of the yard debris to the curb and remove them from the property with our leaf vacuum, mounted onto our dump trailer.',
  fall1: '(Single visit in November or December depending on weather)\nBlowing out all leaves, sticks and twigs from mulch/stone beds and bushes. We then blow all of the yard debris to the curb and remove them from the property with our leaf vacuum, mounted onto our dump trailer.\nCutting back all perennials (as needed) and disposal.',
  fall2: '(Typically once in November and once in December)\nBlowing out all leaves, sticks and twigs from mulch/stone beds and bushes. We then blow all of the yard debris to the curb and remove them from the property with our leaf vacuum, mounted onto our dump trailer.\nCutting back all perennials (as needed) and disposal.',
  gut: 'Blowing out gutters and downspouts free of debris. Cleanup of any debris after cleaning gutters.\nMust be paired with a cleanup.',
};
const isFallSeason = () => { const m = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })).getMonth() + 1; return m >= 8 || m <= 1; };

/* ---------- helpers ---------- */
const money = n => '$' + Math.round(n).toLocaleString('en-US');
const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
const normStreet = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 2).join(' ');

/* ---------- find or create client + property ---------- */
async function findClient(env, lead) {
  const phone = digits(lead.phone), email = String(lead.email || '').trim().toLowerCase();
  for (const term of [phone, email].filter(Boolean)) {
    const d = await gql(env, `
      query ($q: String!) { clients(searchTerm: $q, first: 10) { nodes {
        id firstName lastName
        phones { number } emails { address }
        properties { id address { street1 city } }
      } } }`, { q: term });
    const nodes = d.clients?.nodes || [];
    const hit = nodes.find(c =>
      (phone && (c.phones || []).some(p => digits(p.number) === phone)) ||
      (email && (c.emails || []).some(e => String(e.address || '').toLowerCase() === email)));
    if (hit) return hit;
  }
  return null;
}

async function ensureClientAndProperty(env, lead) {
  const [firstName, ...rest] = String(lead.name || '').trim().split(/\s+/);
  const lastName = rest.join(' ') || '-';
  const a = lead.address || {};
  const addr = { street1: a.street || '', city: a.city || '', province: a.state || 'IL', postalCode: a.zip || '', country: 'US' };

  const existing = await findClient(env, lead).catch(e => { console.error('client search failed', e.message); return null; });
  if (existing) {
    const same = (existing.properties || []).find(p => normStreet(p.address?.street1) === normStreet(addr.street1));
    if (same) return { clientId: existing.id, propertyId: same.id, returning: true };
    const pr = await gql(env, `
      mutation ($clientId: EncodedId!, $input: PropertyCreateInput!) {
        propertyCreate(clientId: $clientId, input: $input) { properties { id } userErrors { message path } }
      }`, { clientId: existing.id, input: { properties: [{ address: addr }] } });
    ue(pr.propertyCreate, 'propertyCreate');
    return { clientId: existing.id, propertyId: pr.propertyCreate.properties[0]?.id, returning: true };
  }

  const cr = await gql(env, `
    mutation ($input: ClientCreateInput!) {
      clientCreate(input: $input) { client { id properties { id } } userErrors { message path } }
    }`, {
    input: {
      firstName, lastName,
      ...(lead.commercial && lead.company ? { companyName: String(lead.company).slice(0, 120), isCompany: true } : {}),
      emails: lead.email ? [{ address: lead.email, description: 'MAIN', primary: true }] : [],
      phones: lead.phone ? [{ number: lead.phone, description: 'MOBILE', primary: true }] : [],
      billingAddress: addr,
      properties: [{ address: addr }],
    },
  });
  ue(cr.clientCreate, 'clientCreate');
  const props = cr.clientCreate.client.properties;
  return { clientId: cr.clientCreate.client.id, propertyId: (Array.isArray(props) ? props[0] : (props?.nodes || [])[0])?.id, returning: false };
}

/* ---------- request ---------- */
function buildDetails(lead, addr, returning) {
  const lines = (lead.services || []).map(s => `• ${s.name}: ${s.price}`).join('\n');
  if (lead.commercial) return `INSTANT QUOTE SITE — COMMERCIAL LEAD${returning ? ' (existing client)' : ''}\n` +
    `Company/property: ${lead.company || '(not given)'}\nAddress: ${addr.street1}, ${addr.city}\nPriced after site visit.\n` +
    (lead.notes ? `\nCustomer notes: ${lead.notes}\n` : '') + `\nSubmitted ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}`;
  return `INSTANT QUOTE SITE LEAD${returning ? ' (existing client)' : ''}${lead.in_area === false ? ' — OUTSIDE SERVICE AREA' : ''}\n` +
    `Address: ${addr.street1}, ${addr.city}, ${addr.province} ${addr.postalCode}\n` +
    `Lot: ${Number(lead.lot_sf || 0).toLocaleString('en-US')} sq ft (${lead.lot_source || 'customer entered'})` + (lead.home ? ` · Home: ${lead.home}` : '') + `\n\n` +
    `Services selected:\n${lines || '(none)'}\n` + (lead.total ? `Selected today: ${money(lead.total)}\n` : '') +
    (lead.notes ? `\nCustomer notes: ${lead.notes}\n` : '') +
    `\nSubmitted ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}`;
}

/* ---------- quote ---------- */
function quoteLineItems(lead) {
  const q = lead.quote || {};           // exact prices from the site: {mow, fert, aer, spring, fall, fallVisits, gutter, stories}
  const sel = lead.selected || {};       // which ones the customer checked
  const fall = isFallSeason();
  const li = [];
  const push = (key, prod, price, desc, qty = 1) => {
    if (!price) return;
    li.push({ name: prod.name, description: desc, productOrServiceId: prod.id, unitPrice: Number(price), quantity: qty, taxable: true, saveToProductsAndServices: false, optional: true, recommended: !!sel[key] });
  };
  push('mow', PRODUCTS.mow, q.mow, DESC.mow);
  push('fert', PRODUCTS.fert, q.fert, DESC.fert);
  push('aer', fall ? PRODUCTS.aerF : PRODUCTS.aerS, q.aer, DESC.aer);
  if (fall) { push('fall', q.fallVisits === 2 ? PRODUCTS.fall2 : PRODUCTS.fall1, q.fall, q.fallVisits === 2 ? DESC.fall2 : DESC.fall1); }
  else { push('spring', PRODUCTS.spring, q.spring, DESC.spring); }
  if (sel.spring || sel.fall) push('gutter', fall ? PRODUCTS.gutF : PRODUCTS.gutS, q.gutter, DESC.gut);
  // Put the services the customer picked first.
  li.sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
  li.push({ name: 'CARD ON FILE IS REQUIRED. DEPOSIT MUST BE MADE TOWARDS FIRST MOW.', description: 'Overgrowth fee may apply if lawn is overgrown.', unitPrice: 0, quantity: 1, textOnly: true, saveToProductsAndServices: false });
  return li;
}

async function createQuote(env, lead, ids, requestId) {
  const lineItems = quoteLineItems(lead);
  if (lineItems.length <= 1) return null;
  const attrs = {
    clientId: ids.clientId, propertyId: ids.propertyId, requestId,
    title: `Property Maintenance ${new Date().getFullYear()}`,
    message: 'Here is your instant quote from Cardinal Landscape Associates. Prices are based on county lot size; the first mow may be adjusted for overgrowth. Pick the services you want and approve online to get on the schedule.',
    lineItems,
    allowClientHubCreditCardPayments: true,
    mandatoryPaymentMethodOnFile: true,
    notes: [{ message: 'Created automatically by the instant quote site.' }],
  };
  const dep = String(env.DEPOSIT || 'first_mow');
  const mow = Number(lead.quote?.mow || 0);
  if (dep === 'first_mow' && mow > 0) attrs.deposit = { rate: mow, type: 'Unit' };
  else if (/^\d+(\.\d+)?$/.test(dep) && Number(dep) > 0) attrs.deposit = { rate: Number(dep), type: 'Unit' };
  const d = await gql(env, `
    mutation ($attributes: QuoteCreateAttributes!) {
      quoteCreate(attributes: $attributes) { quote { id quoteNumber jobberWebUri clientHubUri } userErrors { message path } }
    }`, { attributes: attrs });
  ue(d.quoteCreate, 'quoteCreate');
  return d.quoteCreate.quote;
}

/* ---------- main flow ---------- */
async function createLead(env, lead) {
  const a = lead.address || {};
  const addr = { street1: a.street || '', city: a.city || '', province: a.state || 'IL', postalCode: a.zip || '', country: 'US' };
  const ids = await ensureClientAndProperty(env, lead);

  const rr = await gql(env, `
    mutation ($input: RequestCreateInput!) {
      requestCreate(input: $input) { request { id } userErrors { message path } }
    }`, { input: { clientId: ids.clientId, ...(ids.propertyId ? { propertyId: ids.propertyId } : {}), title: lead.commercial ? 'Instant Quote Site — Commercial' : (lead.in_area === false ? 'Instant Quote Site — Out of area' : 'Instant Quote Site') } });
  ue(rr.requestCreate, 'requestCreate');
  const requestId = rr.requestCreate.request.id;

  let quote = null, quoteError = null;
  if ((env.QUOTE_MODE || 'draft') !== 'off' && !lead.commercial && lead.in_area !== false) {
    try { quote = await createQuote(env, lead, ids, requestId); } catch (e) { quoteError = e.message; console.error('quote failed', e.message); }
  }

  let details = buildDetails(lead, addr, ids.returning);
  if (quote) details += `\n\nDraft quote #${quote.quoteNumber} created: ${quote.jobberWebUri}\nClient hub link: ${quote.clientHubUri}`;
  if (quoteError) details += `\n\nQuote could not be auto-created: ${quoteError}`;
  try {
    const nr = await gql(env, `
      mutation ($requestId: EncodedId!, $input: RequestCreateNoteInput!) {
        requestCreateNote(requestId: $requestId, input: $input) { userErrors { message path } }
      }`, { requestId, input: { message: details } });
    ue(nr.requestCreateNote, 'requestCreateNote');
  } catch (e) { console.error('note failed', e.message); }

  return { clientId: ids.clientId, propertyId: ids.propertyId, requestId, returning: ids.returning, quoteId: quote?.id || null, quoteNumber: quote?.quoteNumber || null, clientHubUri: quote?.clientHubUri || null, quoteError };
}

/* ---------- validation ---------- */
function validate(lead) {
  const errs = [];
  if (!lead || typeof lead !== 'object') return ['Bad payload'];
  if (!String(lead.name || '').trim()) errs.push('Name is required');
  if (!/\d{7,}/.test(String(lead.phone || '').replace(/\D/g, ''))) errs.push('Phone is required');
  if (lead.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email)) errs.push('Email looks wrong');
  if (!lead.address || !lead.address.street) errs.push('Address is required');
  if (String(lead.hp || '').length) errs.push('spam');
  return errs;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/') return json({ ok: true, service: 'cardinal-quote-leads', quoteMode: env.QUOTE_MODE || 'draft' }, 200, cors);

    if (url.pathname === '/oauth/start') {
      const u = new URL(JOBBER + '/oauth/authorize');
      u.searchParams.set('client_id', env.JOBBER_CLIENT_ID);
      u.searchParams.set('redirect_uri', url.origin + '/oauth/callback');
      u.searchParams.set('state', crypto.randomUUID());
      return Response.redirect(u.toString(), 302);
    }
    if (url.pathname === '/oauth/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('Missing code', { status: 400 });
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: env.JOBBER_CLIENT_ID, client_secret: env.JOBBER_CLIENT_SECRET, redirect_uri: url.origin + '/oauth/callback' });
      const r = await fetch(JOBBER + '/oauth/token', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      const d = await r.json();
      if (!d.refresh_token) return new Response('Token exchange failed: ' + JSON.stringify(d), { status: 500 });
      return new Response(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px">
        <h2>Jobber connected</h2><p>Copy this refresh token and save it in Cloudflare as a <b>Secret</b> named <b>JOBBER_REFRESH_TOKEN</b> (Worker → Settings → Variables and Secrets).</p>
        <textarea style="width:100%;height:90px;font:14px monospace">${d.refresh_token}</textarea></body>`, { headers: { 'content-type': 'text/html' } });
    }

    if (url.pathname === '/lead' && req.method === 'POST') {
      let lead; try { lead = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, cors); }
      const errs = validate(lead);
      if (errs.includes('spam')) return json({ ok: true }, 200, cors);
      if (errs.length) return json({ ok: false, error: errs.join('. ') }, 400, cors);
      if (!env.JOBBER_REFRESH_TOKEN) return json({ ok: false, error: 'Jobber not connected yet' }, 503, cors);
      try { return json({ ok: true, ...(await createLead(env, lead)) }, 200, cors); }
      catch (e) { console.error(e); return json({ ok: false, error: String(e.message || e).slice(0, 300) }, 502, cors); }
    }
    return json({ ok: false, error: 'Not found' }, 404, cors);
  },
};
