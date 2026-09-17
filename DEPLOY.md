# Deployment: GitHub + Netlify + Render

The production setup uses:

- GitHub (`hansepierre577-creator/level-up-bootstap`) for source control.
- Netlify for the static frontend.
- Render for the Express API in `server.js`.
- Supabase for the database and authentication.
- Stripe for card payments.

## One-time setup

1. Push this repository to the `main` branch on GitHub.
2. In Supabase SQL Editor, run [supabase/schema.sql](./supabase/schema.sql)
   before accepting production traffic. It enables RLS and blocks customers
   from changing roles, orders, payment state, or order items directly.
3. In Render, choose **New > Blueprint**, select this GitHub repository, and
   deploy the `render.yaml` service.
4. Add every `sync: false` value requested by Render. Generate a unique
   `JWT_SECRET` with:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

5. In Netlify, choose **Add new site > Import an existing project**, select
   the same GitHub repository, and set:
   - Build command: empty
   - Publish directory: `.`
   - Production branch: `main`
6. Keep the Render URL in `netlify.toml` as
   `https://level-up-api.onrender.com`, or replace it with the actual Render
   URL if Render assigns a different hostname.
7. In Render, set `ALLOWED_ORIGINS` to the exact Netlify URL, for example
   `https://your-site.netlify.app`. Include the custom domain too if you add
   one.
8. Configure the Stripe webhook at
   `<render-url>/api/stripe/webhook` and save its signing secret in Render.
9. Use matching Stripe modes: `pk_test` with `sk_test`, or `pk_live` with
   `sk_live`. Never put a secret key in frontend files or GitHub.

## Automatic deployments

After Netlify and Render are connected to GitHub, every push to `main` will:

- run the GitHub Actions validation workflow;
- redeploy the frontend on Netlify;
- redeploy the API on Render.

Use:

```powershell
git add .
git commit -m "Describe the change"
git push origin main
```

Netlify and Render may take a few minutes to finish each deployment.

## Pre-launch checks

- Open `https://<netlify-site>/` and confirm the Level-Up homepage loads.
- Open `https://<render-service>/api/health` and confirm the API responds.
- Confirm `/api/auth/login` is routed through the Netlify site.
- Test registration, login, order creation, and Stripe test payment.
- Confirm the Supabase RLS policies were applied successfully.
- Confirm `.env` is not tracked. The repository `.gitignore` already excludes it.
