# Deployment: Cloudflare Pages + Workers

The static site is deployed to Cloudflare Pages and the API is deployed as the
native-fetch Worker in `worker/index.js`. Supabase remains the database/auth
provider and Stripe remains the payment provider.

## Setup

1. Run `supabase/schema.sql` in the Supabase SQL editor.
2. Install and authenticate Wrangler:

   ```powershell
   npm install
   npx wrangler login
   ```

3. Create Worker secrets. Enter each value when prompted; never commit them:

   ```powershell
   npx wrangler secret put JWT_SECRET
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_ANON_KEY
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   npx wrangler secret put ALLOWED_ORIGINS
   ```

   `JWT_SECRET` must be at least 64 random characters. Generate one with
   `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`.
   `ALLOWED_ORIGINS` is a comma-separated list of exact Pages/custom domains.
   `STRIPE_PUBLIC_KEY` is only a browser value and must never be a Worker
   secret or be confused with `STRIPE_SECRET_KEY`.

4. Deploy the API:

   ```powershell
   npm run deploy:worker
   ```

5. Create a Cloudflare Pages project from this repository. Use an empty build
   command and `.` as the publish directory.
6. Before `assets/js/api-config.js` loads, define
   `window.LEVELUP_API_BASE_URL` as the deployed Worker URL (or call
   `LEVELUP_API.setBaseUrl` during local setup). Local development defaults to
   `http://localhost:8787`.
7. Configure Stripe to send events to
   `<worker-url>/api/stripe/webhook`. Use matching test/live key modes.

## Verification

- `npm run check`
- `https://<worker-url>/api/health`
- Register, login, `/api/auth/me`, order creation, admin order access, and a
  Stripe test payment/webhook.
- Confirm Supabase RLS is enabled and `.env` is not tracked.

The Worker preserves the Express API paths and uses Web Crypto for JWT signing
and Stripe webhook HMAC verification. The service-role key is used only
server-side.
