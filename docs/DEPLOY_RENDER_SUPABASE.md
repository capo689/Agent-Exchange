# Render + Supabase Setup

Render is the secret store for this project. Do not put production Supabase passwords in local env files.

## Render Env Group

Create or update the `MAX` environment group with:

```bash
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=your_publishable_key
SUPABASE_SECRET_KEY=your_secret_key
SUPABASE_JWKS_URL=https://your-project-ref.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_PROJECT_REF=your-project-ref
DATABASE_URL=postgresql://postgres.your-project-ref:YOUR_DB_PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres
LOG_LEVEL=info
MAX_JSON_BODY_BYTES=1048576
ADMIN_TOKEN=generate_a_long_random_admin_token
```

`DATABASE_URL` should be the Supabase transaction pooler string for hosted Render runtime. It normally uses port `6543`.

## Attach Env Group To Web Service

In Render:

1. Open the Agent Exchange web service.
2. Go to **Environment**.
3. Attach the `MAX` environment group.
4. Save and redeploy.

Recommended service settings:

```bash
Build Command: npm install
Start Command: npm start
```

## Supabase Schema

Before the API uses Postgres persistence, run [db/schema.sql](../db/schema.sql) in the Supabase SQL Editor.

This creates the first launch tables and the `reserve_listing_inventory` function. That function locks the listing row while reserving inventory, which is the production fix for concurrent partial fills and oversell prevention.

When `DATABASE_URL` is present, the API starts with the Postgres store adapter. Without `DATABASE_URL`, local development uses memory or the optional JSON file store.

## Verify Wiring

After deploy, check:

```bash
curl -sS https://YOUR_RENDER_SERVICE.onrender.com/v1/health
```

The `runtime` object should report:

```json
{
  "storageBackend": "postgres",
  "databaseConfigured": true,
  "adminConfigured": true,
  "supabaseConfigured": true,
  "supabaseJwksConfigured": true,
  "maxJsonBodyBytes": 1048576
}
```

After the schema is installed and Render is redeployed, run the reference bot against the Render URL to confirm the hosted Postgres flow:

```bash
AGENT_EXCHANGE_URL=https://YOUR_RENDER_SERVICE.onrender.com npm run bots:reference
```
