require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const passwordMinLength = 12;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const paymentMethods = new Set(['moncash', 'natcash', 'credit']);

if (!jwtSecret || jwtSecret.length < 64 || jwtSecret.includes('replace-with')) {
  throw new Error('JWT_SECRET must contain at least 64 random characters.');
}

const stripe = process.env.STRIPE_SECRET_KEY && /^(sk_test_|sk_live_)/.test(process.env.STRIPE_SECRET_KEY)
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripePublicKey = process.env.STRIPE_PUBLIC_KEY || '';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  : null;
const supabaseAuth = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  : null;

if (!supabase) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (isProduction && allowedOrigins.length === 0) {
  throw new Error('ALLOWED_ORIGINS is required in production.');
}

if (isProduction) {
  if (!stripe || !stripeWebhookSecret) {
    throw new Error('Stripe secret key and webhook secret are required in production.');
  }
  if (!stripePublicKey || stripePublicKey.replace(/^pk_/, 'sk_') !== stripeSecretKey) {
    throw new Error('STRIPE_PUBLIC_KEY and STRIPE_SECRET_KEY must use the same mode in production.');
  }
  if (allowedOrigins.some((origin) => /localhost|127\.0\.0\.1/.test(origin))) {
    throw new Error('ALLOWED_ORIGINS cannot contain localhost in production.');
  }
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || (!isProduction && allowedOrigins.length === 0)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !stripeWebhookSecret) {
    return res.status(503).json({ success: false, message: 'Stripe webhook is not configured.' });
  }

  let event;
  try {
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
  } catch (error) {
    console.error('Stripe webhook signature error:', error.message);
    return res.status(400).send('Invalid webhook signature.');
  }

  try {
    const paymentIntent = event.data.object;
    const status = event.type === 'payment_intent.succeeded'
      ? 'paid'
      : event.type === 'payment_intent.payment_failed'
        ? 'cancelled'
        : null;

    if (status) {
      const { error } = await supabase
        .from('orders')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('stripe_payment_intent_id', paymentIntent.id);
      if (error) throw error;
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook processing error:', error);
    return res.status(500).json({ success: false, message: 'Webhook processing failed.' });
  }
});
app.use(express.json({ limit: '50kb' }));
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' }
}));
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again later.' }
});

function requireDatabase(req, res, next) {
  return next();
}

app.use('/api', requireDatabase);

function profileToUser(profile) {
  const [firstName = '', ...lastNameParts] = String(profile.full_name || '').trim().split(/\s+/).filter(Boolean);
  return {
    _id: profile.id,
    firstName,
    lastName: lastNameParts.join(' '),
    email: profile.email || '',
    role: profile.role || 'customer'
  };
}

async function findUserByEmail(email) {
  const normalized = String(email || '').toLowerCase();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email, role')
    .eq('email', normalized)
    .maybeSingle();
  if (error) throw error;
  return data ? profileToUser(data) : null;
}

async function findUserById(id) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email, role')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? profileToUser(data) : null;
}

function productSlug(name) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function createOrderRecord(data) {
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({
      user_id: data.userId || null,
      customer_name: `${data.firstName} ${data.lastName}`,
      customer_email: data.email || null,
      customer_phone: data.phone,
      shipping_address: data.address,
      status: 'pending',
      total: data.total,
      payment_method: data.paymentMethod
    })
    .select()
    .single();
  if (orderError) throw orderError;

  try {
    for (const item of data.items) {
      const { data: product, error: productError } = await supabase
        .from('products')
        .upsert({
          name: item.name,
          slug: productSlug(item.name),
          price: item.price,
          is_active: true
        }, { onConflict: 'slug' })
        .select('id')
        .single();
      if (productError) throw productError;

      const { error: itemError } = await supabase
        .from('order_items')
        .insert({
          order_id: order.id,
          product_id: product.id,
          quantity: item.qty,
          unit_price: item.price
        });
      if (itemError) throw itemError;
    }
  } catch (error) {
    await supabase.from('orders').delete().eq('id', order.id);
    throw error;
  }

  return { ...order, _id: order.id, paymentStatus: order.status, items: data.items };
}

async function updateOrderPaymentIntent(orderId, paymentIntentId) {
  const { error } = await supabase
    .from('orders')
    .update({ stripe_payment_intent_id: paymentIntentId, updated_at: new Date().toISOString() })
    .eq('id', orderId);
  if (error) throw error;
}

async function findOrderById(id) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function listOrders() {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

function createToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email, role: user.role },
    jwtSecret,
    { expiresIn: '15m', issuer: 'levelup-api', audience: 'levelup-web' }
  );
}

function requireAuth(req, res, next) {
  const match = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ success: false, message: 'Authentication required.' });
  try {
    req.auth = jwt.verify(match[1], jwtSecret, { issuer: 'levelup-api', audience: 'levelup-web' });
    return next();
  } catch (_) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session.' });
  }
}

function optionalAuth(req, res, next) {
  return req.headers.authorization ? requireAuth(req, res, next) : next();
}

async function requireAdmin(req, res, next) {
  try {
    const user = await findUserById(req.auth.id);
    if (user && user.role === 'admin') return next();
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  } catch (error) {
    console.error('Admin authorization error:', error);
    return res.status(503).json({ success: false, message: 'Authorization service unavailable.' });
  }
}

function cleanText(value, maxLength) {
  const text = String(value || '').trim();
  return text && text.length <= maxLength ? text : null;
}

function validateRegistration(body) {
  const firstName = cleanText(body.firstName, 80);
  const lastName = cleanText(body.lastName, 80);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!firstName || !lastName || !emailPattern.test(email) || email.length > 254) {
    return { error: 'Informations personnelles invalides.' };
  }
  if (password.length < passwordMinLength || password.length > 128) {
    return { error: `Le mot de passe doit contenir entre ${passwordMinLength} et 128 caractères.` };
  }
  return { firstName, lastName, email, password };
}

// Prices always come from the server, never from the browser.
const productCatalog = new Map([
  ['Trousse En Cuir Noir', 12], ['Trousse En Cuir Marron', 12], ['Trousse En Cuir Gris', 12],
  ['Jacket 1', 50], ['Jacket en cuir', 65], ['Leather jacket displayed on a neutral background', 60],
  ['Style', 75], ['Combo', 35], ['Lunette 1', 15], ['Lunette 2', 18], ['Lunette 3', 20]
]);

function createOrderItems(cart) {
  if (!cart || typeof cart !== 'object' || Array.isArray(cart)) return null;
  const entries = Object.entries(cart);
  if (!entries.length || entries.length > 30) return null;
  const items = entries.map(([name, item]) => {
    const qty = Number(item && item.qty);
    const price = productCatalog.get(name);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20 || price === undefined) return null;
    return { name, qty, price };
  });
  return items.includes(null) ? null : items;
}

function sanitizeUser(user) {
  return {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role
  };
}

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Level-Up API is running',
    routes: [
      'POST /api/auth/register',
      'POST /api/auth/login',
      'POST /api/process-payment',
      'GET /api/health'
    ]
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API OK',
    environment: process.env.NODE_ENV || 'development',
    database: 'supabase',
    stripe: stripe ? 'configured' : 'disabled',
    stripeWebhook: stripe && stripeWebhookSecret ? 'configured' : 'disabled',
    supabase: supabase ? 'configured' : 'disabled',
    supabaseAuth: supabaseAuth ? 'configured' : 'disabled'
  });
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const registration = validateRegistration(req.body || {});
    if (registration.error) {
      return res.status(400).json({ success: false, message: registration.error });
    }

    const { firstName, lastName, email: normalizedEmail, password } = registration;

    const { data, error } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name: `${firstName} ${lastName}` }
    });

    if (error) {
      if (error.code === 'email_exists' || /already registered|already exists/i.test(error.message || '')) {
        return res.status(409).json({ success: false, message: 'Un compte avec cet email existe déjà.' });
      }
      console.error('Supabase register error:', error.message);
      return res.status(500).json({ success: false, message: 'Erreur serveur lors de l’inscription.' });
    }

    const user = {
      _id: data.user.id,
      firstName,
      lastName,
      email: normalizedEmail,
      role: 'customer'
    };

    const token = createToken(user);

    return res.status(201).json({
      success: true,
      message: 'Compte créé avec succès.',
      token,
      user: sanitizeUser(user)
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ success: false, message: 'Un compte avec cet email existe déjà.' });
    }
    console.error('Register error:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur lors de l’inscription.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const email = String(req.body && req.body.email || '').trim().toLowerCase();
    const password = String(req.body && req.body.password || '');

    if (!emailPattern.test(email) || email.length > 254 || !password || password.length > 128) {
      return res.status(400).json({ success: false, message: 'Email et mot de passe requis.' });
    }

    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect.' });
    }
    const user = await findUserById(data.user.id) || {
      _id: data.user.id,
      firstName: '',
      lastName: '',
      email: data.user.email,
      role: 'customer'
    };
    const token = createToken(user);

    return res.json({
      success: true,
      message: 'Connexion réussie.',
      token,
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur lors de la connexion.' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await findUserById(req.auth.id);

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
    }

    return res.json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Token invalide ou expiré.' });
  }
});

app.post('/api/process-payment', optionalAuth, async (req, res) => {
  try {
    const { firstName, lastName, address, phone, paymentMethod, cart, email } = req.body || {};
    const safeFirstName = cleanText(firstName, 80);
    const safeLastName = cleanText(lastName, 80);
    const safeAddress = cleanText(address, 240);
    const safePhone = cleanText(phone, 40);
    const safeEmail = email ? String(email).trim().toLowerCase() : '';

    if (!safeFirstName || !safeLastName || !safeAddress || !safePhone || !paymentMethods.has(paymentMethod) || (safeEmail && (!emailPattern.test(safeEmail) || safeEmail.length > 254))) {
      return res.status(400).json({ success: false, message: 'Les informations de livraison sont incomplètes.' });
    }

    const items = createOrderItems(cart);
    if (!items) {
      return res.status(400).json({ success: false, message: 'Le panier est vide ou invalide.' });
    }

    const total = items.reduce((sum, item) => sum + item.qty * item.price, 0);
    const orderData = {
      firstName: safeFirstName, lastName: safeLastName, email: safeEmail, phone: safePhone, address: safeAddress, paymentMethod, total, items,
      userId: req.auth ? req.auth.id : null
    };

    if (paymentMethod === 'credit') {
      if (!stripe) {
        return res.status(503).json({ success: false, message: 'Card payments are not configured.' });
      }

      const order = await createOrderRecord(orderData);
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(total * 100),
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        ...(safeEmail ? { receipt_email: safeEmail } : {}),
        metadata: { orderId: order.id }
      });
      await updateOrderPaymentIntent(order.id, paymentIntent.id);

      return res.json({
        success: true,
        message: 'Paiement accepté.',
        orderId: order._id,
        paymentIntent: {
          id: paymentIntent.id,
          clientSecret: paymentIntent.client_secret,
          status: paymentIntent.status
        }
      });
    }

    const order = await createOrderRecord(orderData);

    return res.json({
      success: true,
      message: 'Commande enregistrée avec succès. Le paiement sera confirmé selon le mode choisi.',
      orderId: order._id
    });
  } catch (error) {
    console.error('Payment error:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur lors du traitement du paiement.' });
  }
});

app.get('/api/orders/:id', requireAuth, async (req, res) => {
  try {
    const order = await findOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Commande introuvable.' });
    }
    const currentUser = await findUserById(req.auth.id);
    const isAdmin = currentUser && currentUser.role === 'admin';
    if (!isAdmin && String(order.user_id) !== String(req.auth.id)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    return res.json({ success: true, order });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Erreur de récupération de la commande.' });
  }
});

app.get('/api/orders', requireAuth, requireAdmin, async (req, res) => {
  try {
    const orders = await listOrders();
    return res.json({ success: true, orders });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Erreur lors du chargement des commandes.' });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && error.status === 400 && error.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'JSON request is invalid.' });
  }
  if (error && error.message === 'Origin not allowed by CORS') {
    return res.status(403).json({ success: false, message: 'Origin not allowed.' });
  }
  console.error('Unhandled server error:', error);
  return res.status(500).json({ success: false, message: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
