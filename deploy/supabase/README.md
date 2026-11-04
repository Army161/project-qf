# Supabase side of the Vercel deployment (devnet only)

The launchpad runs as one Vercel Function (`apps/launchpad/src/vercel.ts`, built by `deploy/vercel/build-output.mjs`).
Its records live in Postgres, schema `qf_launchpad` (`schema.sql`), reached through the `qf-db` Edge Function.

- `qf-db` accepts a call only when it carries a Vercel OIDC token for team `jeremy-gepharts-projects`, project
  `qf-launchpad-devnet`, environment `production`, verified against Vercel's published keys. No password or API key exists
  on either side.
- Every call runs in one transaction as `qf_launchpad_app`, a role that can use the `qf_launchpad` schema only.
- `qf_launchpad` is not exposed through the Supabase REST API, and `anon` / `authenticated` have no rights on it.
- The operator's throwaway devnet key is made by the function on first start and kept in `qf_launchpad.secrets`. Never read
  or copy it into chat, logs or Git; its public address is shown on `/api/lp/platform`.

Deploy: apply `schema.sql` once, then deploy `qf-db/index.ts` with JWT verification off (the function checks the Vercel
token itself).
