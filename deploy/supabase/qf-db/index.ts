// qf-db: the launchpad's database gateway (Supabase Edge Function, Deno). It accepts calls only from the launchpad's own
// production functions on Vercel, proven by the Vercel OIDC token each function invocation carries (signed by Vercel,
// checked here against Vercel's published keys), so no password or API key is stored on either side. Each call's
// statements run in one transaction as qf_launchpad_app, which can reach the qf_launchpad schema and nothing else.
import postgres from 'npm:postgres@3.4.5';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'npm:jose@5.9.6';

const TEAM = 'jeremy-gepharts-projects';
const TEAM_ID = 'team_jyck86vLRB9EjYteV05GheRR';
const PROJECT = 'qf-launchpad-devnet';
const ISSUERS: Record<string, string> = {
  [`https://oidc.vercel.com/${TEAM}`]: `https://oidc.vercel.com/${TEAM}/.well-known/jwks`,
  'https://oidc.vercel.com': 'https://oidc.vercel.com/.well-known/jwks',
};
const AUDIENCE = `https://vercel.com/${TEAM}`;
const keys = Object.fromEntries(Object.entries(ISSUERS).map(([iss, url]) => [iss, createRemoteJWKSet(new URL(url))]));
const BODY_LIMIT = 1_000_000, MAX_STATEMENTS = 200;

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 3, prepare: false, idle_timeout: 20 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function caller(req: Request): Promise<string | null> {
  const token = req.headers.get('x-vercel-oidc-token') ?? '';
  try {
    const iss = String(decodeJwt(token).iss ?? '');
    if (!keys[iss]) return null;
    const { payload } = await jwtVerify(token, keys[iss]!, { issuer: iss, audience: AUDIENCE });
    if (payload.owner_id !== TEAM_ID || payload.project !== PROJECT || payload.environment !== 'production') return null;
    return String(payload.sub);
  } catch { return null; }
}

const decode = (v: unknown): unknown => {
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { $b64?: unknown }).$b64 === 'string') {
    return Uint8Array.from(atob((v as { $b64: string }).$b64), (c) => c.charCodeAt(0));
  }
  return v;
};
const encode = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => {
  if (v instanceof Uint8Array) { let s = ''; for (const b of v) s += String.fromCharCode(b); return [k, { $b64: btoa(s) }]; }
  if (typeof v === 'bigint') return [k, v.toString()];
  return [k, v];
}));

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!(await caller(req))) return json(401, { error: 'not the launchpad' });
  const text = await req.text();
  if (text.length > BODY_LIMIT) return json(413, { error: 'body too large' });
  let q: { sql: string; params: unknown[] }[];
  try {
    q = (JSON.parse(text) as { q: typeof q }).q;
    if (!Array.isArray(q) || !q.length || q.length > MAX_STATEMENTS || q.some((s) => typeof s?.sql !== 'string' || !Array.isArray(s.params))) throw new Error('bad shape');
  } catch { return json(400, { error: 'body must be { q: [{ sql, params }] }' }); }
  try {
    const results = await sql.begin(async (t) => {
      await t.unsafe('SET LOCAL ROLE qf_launchpad_app');
      const out: Record<string, unknown>[][] = [];
      for (const s of q) out.push([...(await t.unsafe(s.sql, s.params.map(decode) as never[]))].map((r) => encode(r as Record<string, unknown>)));
      return out;
    });
    return json(200, { results });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return json(409, { error: { code: err.code ?? 'DB_ERROR', message: String(err.message ?? e).slice(0, 300) } });
  }
});
