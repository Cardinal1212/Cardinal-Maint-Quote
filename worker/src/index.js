/* Cardinal instant-quote → Jobber lead bridge.
   Routes:
     GET  /oauth/start     one-time: sends you to Jobber to authorize this app
     GET  /oauth/callback  one-time: shows the refresh token to save as a secret
     POST /lead            site form → Jobber client + property + request
     GET  /                health
*/
const JOBBER = 'https://api.getjobber.com/api';
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extra } });

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const ok = allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  };
}

/* ---------- Jobber auth ---------- */
let cached = { token: null, exp: 0 };
async function accessToken(env) {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.JOBBER_CLIENT_ID,
    client_secret: env.JOBBER_CLIENT_SECRET,
    refresh_token: env.JOBBER_REFRESH_TOKEN,
  });
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

/* ---------- lead → Jobber ---------- */
const money = n => '$' + Math.round(n).toLocaleString('en-US');

async function createLead(env, lead) {
  const [firstName, ...rest] = String(lead.name || '').trim().split(/\s+/);
  const lastName = rest.join(' ') || '-';
  const a = lead.address || {};
  const addr = { street1: a.street || '', city: a.city || '', province: a.state || 'IL', postalCode: a.zip || '', country: 'US' };

  const clientRes = await gql(env, `
    mutation ($input: ClientCreateInput!) {
      clientCreate(input: $input) {
        client { id properties { id } }
        userErrors { message path }
      }
    }`, {
    input: {
      firstName, lastName,
      emails: lead.email ? [{ address: lead.email, description: 'MAIN', primary: true }] : [],
      phones: lead.phone ? [{ number: lead.phone, description: 'MOBILE', primary: true }] : [],
      billingAddress: addr,
      properties: [{ address: addr }],
    },
  });
  const cc = clientRes.clientCreate;
  if (cc.userErrors && cc.userErrors.length) throw new Error('clientCreate: ' + cc.userErrors.map(e => e.message).join('; '));
  const clientId = cc.client.id;
  const props = cc.client.properties; const propertyId = (Array.isArray(props) ? props[0] : (props?.nodes || [])[0])?.id;

  const lines = (lead.services || []).map(s => `• ${s.name}: ${s.price}`).join('\n');
  const details =
    `INSTANT QUOTE SITE LEAD\n` +
    `Address: ${addr.street1}, ${addr.city}, ${addr.province} ${addr.postalCode}\n` +
    `Lot: ${Number(lead.lot_sf || 0).toLocaleString('en-US')} sq ft (${lead.lot_source || 'customer entered'})` +
    (lead.home ? ` · Home: ${lead.home}` : '') + `\n\n` +
    `Services selected:\n${lines || '(none)'}\n` +
    (lead.total ? `Selected today: ${money(lead.total)}\n` : '') +
    (lead.notes ? `\nCustomer notes: ${lead.notes}\n` : '') +
    `\nSubmitted ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}`;

  const svcShort = (lead.services || []).map(s => s.name).join(', ') || 'Quote request';
  const reqRes = await gql(env, `
    mutation ($input: RequestCreateInput!) {
      requestCreate(input: $input) {
        request { id title }
        userErrors { message path }
      }
    }`, {
    input: { clientId, ...(propertyId ? { propertyId } : {}), title: `Instant quote: ${svcShort}`, details },
  });
  const rc = reqRes.requestCreate;
  if (rc.userErrors && rc.userErrors.length) throw new Error('requestCreate: ' + rc.userErrors.map(e => e.message).join('; '));
  return { clientId, propertyId, requestId: rc.request.id };
}

/* ---------- validation ---------- */
function validate(lead) {
  const errs = [];
  if (!lead || typeof lead !== 'object') return ['Bad payload'];
  if (!String(lead.name || '').trim()) errs.push('Name is required');
  if (!/\d{7,}/.test(String(lead.phone || '').replace(/\D/g, ''))) errs.push('Phone is required');
  if (lead.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email)) errs.push('Email looks wrong');
  if (!lead.address || !lead.address.street) errs.push('Address is required');
  if (String(lead.hp || '').length) errs.push('spam');           // honeypot field
  return errs;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/') return json({ ok: true, service: 'cardinal-quote-leads' }, 200, cors);

    if (url.pathname === '/oauth/start') {
      const redirect = url.origin + '/oauth/callback';
      const u = new URL(JOBBER + '/oauth/authorize');
      u.searchParams.set('client_id', env.JOBBER_CLIENT_ID);
      u.searchParams.set('redirect_uri', redirect);
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
      return new Response(
        `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px">
         <h2>Jobber connected</h2><p>Copy this refresh token and save it in Cloudflare as a secret named <b>JOBBER_REFRESH_TOKEN</b> (Worker → Settings → Variables and Secrets). Then this page can be closed.</p>
         <textarea style="width:100%;height:90px;font:14px monospace">${d.refresh_token}</textarea></body>`,
        { headers: { 'content-type': 'text/html' } });
    }

    if (url.pathname === '/lead' && req.method === 'POST') {
      let lead; try { lead = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, cors); }
      const errs = validate(lead);
      if (errs.includes('spam')) return json({ ok: true }, 200, cors);
      if (errs.length) return json({ ok: false, error: errs.join('. ') }, 400, cors);
      if (!env.JOBBER_REFRESH_TOKEN) return json({ ok: false, error: 'Jobber not connected yet' }, 503, cors);
      try {
        const out = await createLead(env, lead);
        return json({ ok: true, ...out }, 200, cors);
      } catch (e) {
        console.error(e);
        return json({ ok: false, error: String(e.message || e).slice(0, 300) }, 502, cors);
      }
    }
    return json({ ok: false, error: 'Not found' }, 404, cors);
  },
};
