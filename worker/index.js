import { createClient } from '@supabase/supabase-js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const paymentMethods = new Set(['moncash', 'natcash', 'credit']);
const passwordMinLength = 12;
const catalog = new Map([
  ['Trousse En Cuir Noir', 12], ['Trousse En Cuir Marron', 12], ['Trousse En Cuir Gris', 12],
  ['Jacket 1', 50], ['Jacket en cuir', 65], ['Leather jacket displayed on a neutral background', 60],
  ['Style', 75], ['Combo', 35], ['Lunette 1', 15], ['Lunette 2', 18], ['Lunette 3', 20]
]);
const attempts = new Map();

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
function cors(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  const ok = !origin || allowed.includes(origin) || (!env.NODE_ENV || env.NODE_ENV !== 'production') && !allowed.length;
  return { 'access-control-allow-origin': ok && origin ? origin : '', 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type, Authorization, Stripe-Signature', 'vary': 'Origin' };
}
function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  return allowed.includes(origin) || ((!env.NODE_ENV || env.NODE_ENV !== 'production') && !allowed.length);
}
function response(body, request, env, status = 200) { return json(body, status, cors(request, env)); }
function fail(message, status, request, env) { return response({ success: false, message }, request, env, status); }
function db(env, key = env.SUPABASE_SERVICE_ROLE_KEY) {
  if (!env.SUPABASE_URL || !key) throw new Error('Supabase is not configured.');
  return createClient(env.SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
function text(value, max) { const v = String(value || '').trim(); return v && v.length <= max ? v : null; }
function userFromProfile(p) {
  const parts = String(p.full_name || '').trim().split(/\s+/).filter(Boolean);
  return { _id: p.id, firstName: parts.shift() || '', lastName: parts.join(' '), email: p.email || '', role: p.role || 'customer' };
}
async function findUser(env, id) {
  const { data, error } = await db(env).from('profiles').select('id,full_name,email,role').eq('id', id).maybeSingle();
  if (error) throw error; return data ? userFromProfile(data) : null;
}
async function userByEmail(env, email) {
  const { data, error } = await db(env).from('profiles').select('id,full_name,email,role').eq('email', email).maybeSingle();
  if (error) throw error; return data ? userFromProfile(data) : null;
}
function b64(value) { return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function ub64(value) { const s = value.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); }
async function key(secret, usage = ['sign', 'verify']) { return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage); }
async function token(user, secret) {
  const h = b64(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64(new TextEncoder().encode(JSON.stringify({ id: user._id, email: user.email, role: user.role, iss: 'levelup-api', aud: 'levelup-web', exp: Math.floor(Date.now() / 1000) + 900 })));
  return `${h}.${p}.${b64(await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(`${h}.${p}`)))}`;
}
async function auth(request, env) {
  const match = /^Bearer\s+(.+)$/.exec(request.headers.get('Authorization') || '');
  if (!match) return null;
  try {
    const [h, p, s] = match[1].split('.'); const payload = JSON.parse(new TextDecoder().decode(ub64(p)));
    if (payload.iss !== 'levelup-api' || payload.aud !== 'levelup-web' || payload.exp < Date.now() / 1000) return null;
    const valid = await crypto.subtle.verify('HMAC', await key(env.JWT_SECRET, ['verify']), ub64(s), new TextEncoder().encode(`${h}.${p}`));
    return valid ? payload : null;
  } catch (_) { return null; }
}
function limited(request, name) {
  const now = Date.now(), k = `${name}:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
  const old = attempts.get(k) || []; const fresh = old.filter(t => now - t < 900000); fresh.push(now); attempts.set(k, fresh);
  return fresh.length <= (name === 'auth' ? 10 : 300);
}
function items(cart) {
  if (!cart || typeof cart !== 'object' || Array.isArray(cart)) return null;
  const entries = Object.entries(cart); if (!entries.length || entries.length > 30) return null;
  const out = entries.map(([name, item]) => { const qty = Number(item && item.qty); const price = catalog.get(name); return Number.isInteger(qty) && qty > 0 && qty <= 20 && price !== undefined ? { name, qty, price } : null; });
  return out.includes(null) ? null : out;
}
async function createOrder(env, d) {
  const client = db(env);
  const { data: order, error } = await client.from('orders').insert({ user_id: d.userId || null, customer_name: `${d.firstName} ${d.lastName}`, customer_email: d.email || null, customer_phone: d.phone, shipping_address: d.address, status: 'pending', total: d.total, payment_method: d.paymentMethod }).select().single();
  if (error) throw error;
  try {
    for (const item of d.items) {
      const slug = item.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const { data: product, error: pe } = await client.from('products').upsert({ name: item.name, slug, price: item.price, is_active: true }, { onConflict: 'slug' }).select('id').single();
      if (pe) throw pe;
      const { error: ie } = await client.from('order_items').insert({ order_id: order.id, product_id: product.id, quantity: item.qty, unit_price: item.price });
      if (ie) throw ie;
    }
  } catch (e) { await client.from('orders').delete().eq('id', order.id); throw e; }
  return order;
}
async function stripe(env, path, params) {
  const body = new URLSearchParams(params);
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'Stripe request failed');
  return data;
}async function verifyStripe(raw, sig, secret) {
  const parts = Object.fromEntries(String(sig || '').split(',').map(x => x.split('=')));
  const data = `${parts.t}.${raw}`; const mac = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(data));
  return parts.t && Math.abs(Date.now() / 1000 - Number(parts.t)) < 300 && b64(mac) === parts.v1;
}

export default {
  async fetch(request, env) {
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!originAllowed(request, env)) return fail('Origin not allowed.', 403, request, env);
    const url = new URL(request.url); const path = url.pathname;
    if (!limited(request, 'api')) return fail('Too many requests. Please try again later.', 429, request, env);
    if (path === '/' && request.method === 'GET') return response({ success: true, message: 'Level-Up API is running' }, request, env);
    if (path === '/api/health' && request.method === 'GET') return response({ success: true, message: 'API OK', environment: env.NODE_ENV || 'production', database: 'supabase', stripe: env.STRIPE_SECRET_KEY ? 'configured' : 'disabled', stripeWebhook: env.STRIPE_WEBHOOK_SECRET ? 'configured' : 'disabled' }, request, env);
    if (path === '/api/stripe/webhook' && request.method === 'POST') {
      const raw = await request.text();
      if (!env.STRIPE_WEBHOOK_SECRET || !(await verifyStripe(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) return new Response('Invalid webhook signature.', { status: 400, headers });
      try { const event = JSON.parse(raw); const status = event.type === 'payment_intent.succeeded' ? 'paid' : event.type === 'payment_intent.payment_failed' ? 'cancelled' : null; if (status) await db(env).from('orders').update({ status, updated_at: new Date().toISOString() }).eq('stripe_payment_intent_id', event.data.object.id); return response({ received: true }, request, env); } catch (_) { return fail('Webhook processing failed.', 500, request, env); }
    }
    if (!limited(request, path.includes('/auth/') ? 'auth' : 'api')) return fail('Too many requests. Please try again later.', 429, request, env);
    let body = {}; if (request.method === 'POST') { try { body = await request.json(); } catch (_) { return fail('JSON request is invalid.', 400, request, env); } }
    try {
      if (path === '/api/auth/register' && request.method === 'POST') {
        const firstName = text(body.firstName, 80), lastName = text(body.lastName, 80), email = String(body.email || '').trim().toLowerCase(), password = String(body.password || '');
        if (!firstName || !lastName || !emailPattern.test(email) || email.length > 254 || password.length < passwordMinLength || password.length > 128) return fail('Informations personnelles invalides.', 400, request, env);
        const { data, error } = await db(env).auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `${firstName} ${lastName}` } });
        if (error) return fail(/already|exists/i.test(error.message) ? 'Un compte avec cet email existe déjà.' : 'Erreur serveur lors de l’inscription.', /already|exists/i.test(error.message) ? 409 : 500, request, env);
        const u = { _id: data.user.id, firstName, lastName, email, role: 'customer' };
        return response({ success: true, message: 'Compte créé avec succès.', token: await token(u, env.JWT_SECRET), user: { id: u._id, firstName, lastName, email, role: u.role } }, request, env, 201);
      }
      if (path === '/api/auth/login' && request.method === 'POST') {
        const email = String(body.email || '').trim().toLowerCase(), password = String(body.password || '');
        if (!emailPattern.test(email) || email.length > 254 || !password || password.length > 128) return fail('Email et mot de passe requis.', 400, request, env);
        const { data, error } = await db(env, env.SUPABASE_ANON_KEY).auth.signInWithPassword({ email, password }); if (error || !data.user) return fail('Email ou mot de passe incorrect.', 401, request, env);
        const u = await findUser(env, data.user.id) || { _id: data.user.id, firstName: '', lastName: '', email, role: 'customer' };
        return response({ success: true, message: 'Connexion réussie.', token: await token(u, env.JWT_SECRET), user: { id: u._id, firstName: u.firstName, lastName: u.lastName, email: u.email, role: u.role } }, request, env);
      }
      const a = await auth(request, env);
      if (path === '/api/auth/me' && request.method === 'GET') { if (!a) return fail('Invalid or expired session.', 401, request, env); const u = await findUser(env, a.id); return u ? response({ success: true, user: { id: u._id, firstName: u.firstName, lastName: u.lastName, email: u.email, role: u.role } }, request, env) : fail('Utilisateur introuvable.', 404, request, env); }
      if (path === '/api/process-payment' && request.method === 'POST') {
        const firstName = text(body.firstName, 80), lastName = text(body.lastName, 80), address = text(body.address, 240), phone = text(body.phone, 40), email = body.email ? String(body.email).trim().toLowerCase() : '';
        if (!firstName || !lastName || !address || !phone || !paymentMethods.has(body.paymentMethod) || (email && (!emailPattern.test(email) || email.length > 254))) return fail('Les informations de livraison sont incomplètes.', 400, request, env);
        const list = items(body.cart); if (!list) return fail('Le panier est vide ou invalide.', 400, request, env); const total = list.reduce((s, i) => s + i.qty * i.price, 0); const order = await createOrder(env, { firstName, lastName, address, phone, email, paymentMethod: body.paymentMethod, total, items: list, userId: a?.id });
        if (body.paymentMethod === 'credit') { if (!env.STRIPE_SECRET_KEY) return fail('Card payments are not configured.', 503, request, env); const pi = await stripe(env, 'payment_intents', { amount: String(Math.round(total * 100)), currency: 'usd', 'automatic_payment_methods[enabled]': 'true', ...(email ? { receipt_email: email } : {}), 'metadata[orderId]': order.id }); await db(env).from('orders').update({ stripe_payment_intent_id: pi.id, updated_at: new Date().toISOString() }).eq('id', order.id); return response({ success: true, message: 'Paiement accepté.', orderId: order.id, paymentIntent: { id: pi.id, clientSecret: pi.client_secret, status: pi.status } }, request, env); }
        return response({ success: true, message: 'Commande enregistrée avec succès. Le paiement sera confirmé selon le mode choisi.', orderId: order.id }, request, env);
      }
      if (path.startsWith('/api/orders/') && request.method === 'GET') { if (!a) return fail('Authentication required.', 401, request, env); const { data: order, error } = await db(env).from('orders').select('*, order_items(*)').eq('id', path.split('/').pop()).maybeSingle(); if (error) throw error; if (!order) return fail('Commande introuvable.', 404, request, env); const u = await findUser(env, a.id); if (u?.role !== 'admin' && String(order.user_id) !== String(a.id)) return fail('Access denied.', 403, request, env); return response({ success: true, order }, request, env); }
      if (path === '/api/orders' && request.method === 'GET') { if (!a) return fail('Authentication required.', 401, request, env); const u = await findUser(env, a.id); if (u?.role !== 'admin') return fail('Admin access required.', 403, request, env); const { data, error } = await db(env).from('orders').select('*, order_items(*)').order('created_at', { ascending: false }); if (error) throw error; return response({ success: true, orders: data }, request, env); }
      return fail('Not found.', 404, request, env);
    } catch (error) { console.error(error); return fail('Internal server error.', 500, request, env); }
  }
};
