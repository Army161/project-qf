// Project QF — READ-ONLY program verification library (PROGRAM-VERIFICATION.md, amended 2026-09-27).
// JSON-RPC reads (getGenesisHash, getVersion, getAccountInfo) and one HTTPS GET to verify.osec.io.
// It never signs, never sends or simulates a transaction, never loads a key and never publishes an
// on-chain verification attestation. Dependencies: @solana/addresses (MIT) only; no web3.js v1, so no
// LGPL rpc-websockets (exception QF-LIC-EX-001 covers the Meteora adapter only).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, createAddressWithSeed } from '@solana/addresses';

export const VERIFIER_VERSION = '0.4.0';
/** Report schema (0.3.0): per-check contextSlot/commitment, independent expected inventory, CROSS_CHECK UNAVAILABLE vs DISAGREEMENT. */
/** 0.4.0 (schema /3): route-specific CONFIG_COMPATIBILITY value and the NOT_ASSESSED status; streaming per-operation response limits. */
export const REPORT_SCHEMA_VERSION = 'qf-program-verify-report/3';
export const COMMITMENT = 'finalized';

/** Genesis hashes for cluster identity: anza-xyz/solana-sdk cluster-type/src/lib.rs ClusterType::get_genesis_hash
 *  (read 2026-09-27; solana.com cluster docs list endpoints only). A hostname is never proof of cluster. */
export const GENESIS = Object.freeze({
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
});

export const PROGRAMS = Object.freeze([
  { name: 'Meteora DBC', id: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', required: true, interfaceIndicator: 'create_config2' },
  { name: 'Meteora DAMM v2', id: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', required: true },
  { name: 'SF Rewards (candidate)', id: 'REWArDioXgQJ2fZKkfu9LCLjQfRwYWVVfsvcsR5hoXi', required: false },
]);
const DAMM_V2 = PROGRAMS[1].id;

// DAMM v2 configs used by DBC migration (SDK 1.5.13 DAMM_V2_MIGRATION_FEE_ADDRESS). Only the one the
// V0_TEST template uses (Customizable) is required; the rest are recorded.
export const DAMM_V2_MIGRATION_CONFIGS = Object.freeze([
  ['FixedBps25', '7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd'],
  ['FixedBps30', '2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k'],
  ['FixedBps100', 'Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp'],
  ['FixedBps200', '2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq'],
  ['FixedBps400', 'AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD'],
  ['FixedBps600', 'DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u'],
  ['Customizable', 'A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck'],
]);
const REQUIRED_CONFIGS = new Set(['Customizable']);
/** DAMM v2 `ConfigType` (cp-amm-sdk 1.4.10 IDL / pinned DAMM a85c926): 0 Static, 1 Dynamic. */
export const DAMM_V2_CONFIG_TYPES = Object.freeze({ 0: 'Static', 1: 'Dynamic' });
/**
 * CFG-TYPE (2026-09-27 decision review): route-specific compatibility. The Customizable DBC migration calls DAMM
 * `initialize_pool_with_dynamic_config`, which requires a Dynamic config, and DBC requires the config's
 * pool_creator_authority to be DBC's `pool_authority` PDA. Both rules are confirmed against the pinned sources (read,
 * not copied) and the PDA was derived offline (seed "pool_authority", bump 255). Live values stay UNVERIFIED until read.
 * Fixed-fee routes are not assessed in V0.
 */
export const CONFIG_ROUTES = Object.freeze({
  Customizable: Object.freeze({ poolCreatorAuthority: 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM', configType: 1,
    evidence: Object.freeze({ authorityRule: 'CONFIRMED_FOR_PINNED_SOURCE', configTypeRule: 'CONFIRMED_FOR_PINNED_SOURCE', pdaDerivation: 'CONFIRMED_OFFLINE', liveValues: 'THIS_ROW' }) }),
});
/**
 * Pinned DAMM v2 `Config` layout, extracted from the IDL bundled in @meteora-ag/cp-amm-sdk@1.4.10 (MIT package;
 * provenance inside the file). Not derived from Meteora's separately licensed program source.
 */
export const DAMM_V2_CONFIG_LAYOUT = JSON.parse(readFileSync(new URL('./layouts/damm-v2-config-layout.json', import.meta.url), 'utf8'));
export const DAMM_V2_CONFIG_LAYOUT_SHA256 = 'cf446496b9991546f515cb6e12f00fef4911e800915858ccbad8e17e1131caf4';
const DAMM_V2_CONFIG_DISCRIMINATOR = Uint8Array.from(DAMM_V2_CONFIG_LAYOUT.account.discriminator);
/** DBC pool authority PDA (SDK 1.5.13 constant). */
export const DBC_POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';

export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const PROGRAMDATA_HEADER = 45; // u32 enum + u64 slot + u8 option + 32-byte authority
const PROGRAM_ACCOUNT_LEN = 36; // u32 enum (2) + 32-byte ProgramData address

const FLAGS = new Set(['mainnet', 'mainnet2', 'devnet', 'out']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Parses the original CLI contract (--mainnet, --mainnet2, --devnet, --out). No other flags, no env vars. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(a)}`);
    const k = a.slice(2);
    if (!FLAGS.has(k)) throw new Error(`unknown flag --${k} (accepted: --mainnet, --mainnet2, --devnet, --out)`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`--${k} requires a value`);
    if (k !== 'out') {
      let u;
      try { u = new URL(v); } catch { throw new Error(`--${k} is not a URL`); }
      if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)))) throw new Error(`--${k} must use https (http only for localhost)`);
    }
    out[k] = v;
    i++;
  }
  return out;
}

/**
 * Safe display form of an RPC URL: scheme, host and port only. Path, userinfo, query and fragment can all carry
 * credentials (QF-SEC-03), so each is replaced by a marker, never echoed.
 */
export function redactUrl(s) {
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`
      + (u.pathname && u.pathname !== '/' ? '/<redacted-path>' : '')
      + (u.search ? '?<redacted>' : '') + (u.hash ? '#<redacted>' : '');
  } catch { return '<unparseable url>'; }
}

const scrub = (t) => String(t)
  .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]]+/gi, (m) => redactUrl(m))
  .replace(/(api[-_]?key|token|secret|key|auth|password)=[^&\s]+/gi, '$1=<redacted>')
  .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>');

/** Error text with nested causes and AggregateError members kept for diagnosis, every part redacted. */
export function sanitizeError(e) {
  const parts = [];
  const seen = new Set();
  const walk = (x, depth) => {
    if (x == null || depth > 4 || seen.has(x)) return;
    if (typeof x === 'object') seen.add(x);
    const name = x?.name && x.name !== 'Error' ? `${x.name}: ` : '';
    const code = typeof x?.code === 'string' ? `${x.code} ` : '';
    parts.push(`${name}${code}${x?.message ?? x}`);
    if (Array.isArray(x?.errors)) x.errors.slice(0, 5).forEach((m) => walk(m, depth + 1));
    if (x?.cause !== undefined) walk(x.cause, depth + 1);
  };
  walk(e, 0);
  return scrub(parts.join(' <- ')).slice(0, 800);
}

export const ALLOWED_RPC_METHODS = Object.freeze(['getGenesisHash', 'getVersion', 'getAccountInfo']);

/**
 * BODY-LIMIT (2026-09-27 decision review): per-operation response bounds. Bytes are counted while the body streams and
 * the body is cancelled on overflow; the deadline covers headers and body. Encoded (HTTP/base64) and decoded account
 * bytes, and the compressed IDL's inflated output, are bounded separately. `getAccountInfoLarge` fits the largest
 * possible account (10 MiB, the Solana MAX_PERMITTED_DATA_LENGTH) as base64 inside JSON, so legitimate ProgramData
 * reads are not rejected; small reads (program accounts, configs) get a small cap.
 */
export const RESPONSE_LIMITS = Object.freeze({
  getGenesisHash: 64 * 1024, getVersion: 64 * 1024,
  getAccountInfoSmall: 64 * 1024, getAccountInfoLarge: 15 * 1024 * 1024,
  accountBytesSmall: 16 * 1024, accountBytesLarge: 10 * 1024 * 1024,
  idlInflated: 8 * 1024 * 1024, osecStatus: 64 * 1024, timeoutMs: 30_000,
});

/** Reads at most `maxBytes` from a fetch Response, cancelling the stream on overflow or abort. */
export async function readBodyBounded(res, maxBytes, signal) {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) { await res.body?.cancel().catch(() => {}); throw new Error(`RPC_RESPONSE_TOO_LARGE declared ${declared} > ${maxBytes}`); }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new Error(`RPC_RESPONSE_TOO_LARGE ${total}+ > ${maxBytes} (stopped while streaming)`); }
      chunks.push(value);
    }
  } finally { signal?.removeEventListener('abort', onAbort); }
  return Buffer.concat(chunks, total);
}

/** Runs `fn(signal)` under one deadline that covers the request and the whole body. */
async function withDeadline(timeoutMs, fn) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`RPC_RESPONSE_TIMEOUT after ${timeoutMs} ms`)), timeoutMs);
  try { return await fn(ac.signal); }
  catch (e) { if (ac.signal.aborted) throw ac.signal.reason; throw e; }
  finally { clearTimeout(timer); }
}

/** Inflates the Anchor IDL with a cap on the decompressed output (independent of the compressed size). */
export function inflateIdlBounded(compressed, { maxOutputBytes = RESPONSE_LIMITS.idlInflated } = {}) {
  try { return inflateSync(compressed, { maxOutputLength: maxOutputBytes }); }
  catch (e) { if (e?.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw new Error(`IDL_TOO_LARGE inflated output > ${maxOutputBytes}`); throw e; }
}

/** Minimal JSON-RPC over fetch with a read-only method allowlist. TLS is never relaxed. */
export function createJsonRpc(url, { fetchImpl = fetch, timeoutMs = RESPONSE_LIMITS.timeoutMs, limits = {} } = {}) {
  const L = { ...RESPONSE_LIMITS, ...limits };
  let id = 0;
  const call = async (method, params, maxBytes = L[method]) => {
    if (!ALLOWED_RPC_METHODS.includes(method)) throw new Error(`RPC method ${method} is not in the read-only allowlist`);
    return withDeadline(timeoutMs, async (signal) => {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal });
      const text = (await readBodyBounded(res, maxBytes, signal)).toString('utf8');
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
      const j = JSON.parse(text);
      if (j.error) throw new Error(`RPC error ${j.error.code}: ${j.error.message}`);
      return j.result;
    });
  };
  return {
    label: 'LIVE_RPC',
    endpoint: redactUrl(url),
    call,
    getGenesisHash: () => call('getGenesisHash', []),
    getVersion: () => call('getVersion', []),
    /**
     * Account read with the RPC context slot kept (finalized). `minContextSlot` pins a consistent re-read.
     * `size` is 'small' (program accounts, configs) or 'large' (ProgramData, IDL); it picks both the HTTP body cap and
     * the decoded-bytes cap.
     */
    async getAccountInfoWithContext(address, { minContextSlot, size = 'small' } = {}) {
      const large = size === 'large';
      const cfg = { encoding: 'base64', commitment: COMMITMENT, ...(minContextSlot ? { minContextSlot } : {}) };
      const r = await call('getAccountInfo', [address, cfg], large ? L.getAccountInfoLarge : L.getAccountInfoSmall);
      const v = r?.value;
      const maxData = large ? L.accountBytesLarge : L.accountBytesSmall;
      if (v && Math.floor(String(v.data?.[0] ?? '').length * 3 / 4) > maxData + 2) throw new Error(`ACCOUNT_DATA_TOO_LARGE encoded for ${size} read (> ${maxData} bytes)`);
      const data = v ? Uint8Array.from(Buffer.from(v.data[0], 'base64')) : null;
      if (data && data.length > maxData) throw new Error(`ACCOUNT_DATA_TOO_LARGE ${data.length} > ${maxData} (${size} read)`);
      return { contextSlot: r?.context?.slot ?? null, value: v ? { owner: v.owner, executable: v.executable, data } : null };
    },
    async getAccountInfo(address, opts) { return (await this.getAccountInfoWithContext(address, opts)).value; },
  };
}

export async function fetchOsecStatus(programId, { fetchImpl = fetch, timeoutMs = RESPONSE_LIMITS.timeoutMs, maxBytes = RESPONSE_LIMITS.osecStatus } = {}) {
  try {
    return await withDeadline(timeoutMs, async (signal) => {
      const r = await fetchImpl(`https://verify.osec.io/status/${programId}`, { signal });
      const body = await readBodyBounded(r, maxBytes, signal);
      return r.ok ? JSON.parse(body.toString('utf8')) : { error: `HTTP ${r.status}` };
    });
  } catch (e) { return { error: sanitizeError(e) }; }
}

const addrDec = getAddressDecoder();
const addrEnc = getAddressEncoder();
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64le = (b, o) => Buffer.from(b.buffer, b.byteOffset + o, 8).readBigUInt64LE(0);

export function executableHash(programData) {
  let end = programData.length;
  while (end > PROGRAMDATA_HEADER && programData[end - 1] === 0) end--;
  return createHash('sha256').update(programData.subarray(PROGRAMDATA_HEADER, end)).digest('hex');
}

/** Strict struct decoder for the pinned layout (u8..u128, pubkey, fixed arrays, nested structs). */
function decodeStruct(data, typeName, types) {
  let o = 0;
  const need = (n) => { if (o + n > data.length) throw new Error(`short read at ${o}`); };
  const read = (t) => {
    if (typeof t === 'string') {
      const m = /^u(8|16|32|64|128)$/.exec(t);
      if (m) { const n = Number(m[1]) / 8; need(n); let v = 0n; for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(data[o + k]); o += n; return n <= 4 ? Number(v) : v.toString(); }
      if (t === 'pubkey') { need(32); const a = addrDec.decode(data.subarray(o, o + 32)); o += 32; return a; }
      throw new Error(`unsupported type ${t}`);
    }
    if (t.array) return Array.from({ length: t.array[1] }, () => read(t.array[0]));
    if (t.defined) return fields(types[t.defined.name]);
    throw new Error(`unsupported type ${JSON.stringify(t)}`);
  };
  const fields = (def) => { if (!def || def.kind !== 'struct') throw new Error('unsupported definition'); return Object.fromEntries(def.fields.map((f) => [f.name, read(f.type)])); };
  const value = fields(types[typeName]);
  return { value, consumed: o };
}
/** Decodes a DAMM v2 Config account: exact discriminator, exact length, full field decode. Throws on any mismatch. */
export function decodeDammV2Config(data) {
  if (data.length < 8 || !DAMM_V2_CONFIG_DISCRIMINATOR.every((b, i) => data[i] === b)) throw new Error('discriminator is not DAMM v2 Config');
  const { value, consumed } = decodeStruct(data.subarray(8), 'Config', DAMM_V2_CONFIG_LAYOUT.types);
  if (8 + consumed !== data.length) throw new Error(`length ${data.length} != ${8 + consumed} (Config layout)`);
  return value;
}

async function readAccount(rpc, address, opts) {
  const r = await rpc.getAccountInfoWithContext(address, opts);
  return { contextSlot: r.contextSlot ?? null, acc: r.value };
}

async function anchorIdl(rpc, programId) {
  const [base] = await getProgramDerivedAddress({ programAddress: programId, seeds: [] });
  const idlAddr = await createAddressWithSeed({ baseAddress: base, programAddress: programId, seed: 'anchor:idl' });
  const { acc } = await readAccount(rpc, idlAddr, { size: 'large' });
  if (!acc) return { address: idlAddr, present: false };
  const len = u32le(acc.data, 40);
  const json = JSON.parse(inflateIdlBounded(acc.data.subarray(44, 44 + len)).toString('utf8'));
  return { address: idlAddr, present: true, version: json.metadata?.version ?? json.version ?? null, instructions: (json.instructions ?? []).map((i) => i.name) };
}

const UNKNOWN = (id, subject, why) => ({ id, subject, status: 'UNKNOWN', note: why });
const PROGRAM_CHECK_IDS = ['PROGRAM_PRESENCE', 'LOADER_STATE', 'PROGRAMDATA', 'UPGRADE_AUTHORITY', 'DEPLOY_SLOT', 'EXECUTABLE_HASH', 'INTERFACE', 'SOURCE_BUILD', 'AUDIT_COVERAGE'];

async function inspectProgram(rpc, p, osec, { skipExternal = false } = {}) {
  const checks = [];
  const ctx = (slot) => ({ contextSlot: slot, commitment: COMMITMENT });
  const add = (c) => { checks.push({ program: p.name, required: p.required, ...c, subject: p.id }); return c; };
  const unknownRest = (why) => { for (const id of PROGRAM_CHECK_IDS) if (!checks.some((c) => c.id === id)) add(UNKNOWN(id, p.id, why)); };
  let read;
  try { read = await readAccount(rpc, p.id); }
  catch (e) { add({ id: 'PROGRAM_PRESENCE', status: 'ERROR', error: sanitizeError(e), note: 'RPC read failed; not a finding about the program' }); unknownRest('program account read failed'); return checks; }
  const { acc, contextSlot } = read;
  if (!acc) {
    add({ id: 'PROGRAM_PRESENCE', status: 'FAIL', note: 'account not found at finalized commitment', ...ctx(contextSlot) });
    unknownRest('program account missing');
    return checks;
  }
  add({ id: 'PROGRAM_PRESENCE', status: 'PASS', value: { owner: acc.owner, executable: acc.executable }, ...ctx(contextSlot) });
  const loaderOk = acc.owner === UPGRADEABLE_LOADER && acc.executable === true;
  add({ id: 'LOADER_STATE', status: loaderOk ? 'PASS' : 'FAIL', value: { owner: acc.owner, executable: acc.executable }, ...ctx(contextSlot),
    note: loaderOk ? 'owned by BPFLoaderUpgradeable and executable' : 'expected executable account owned by BPFLoaderUpgradeable' });
  let pd = null, pdSlot = null;
  if (!loaderOk) add({ id: 'PROGRAMDATA', status: 'UNKNOWN', note: 'loader state failed' });
  else if (acc.data.length !== PROGRAM_ACCOUNT_LEN || u32le(acc.data, 0) !== 2) {
    add({ id: 'PROGRAMDATA', status: 'FAIL', value: { programAccountLength: acc.data.length }, ...ctx(contextSlot),
      note: `program account is not a ${PROGRAM_ACCOUNT_LEN}-byte UpgradeableLoaderState::Program` });
  } else {
    const pdAddr = addrDec.decode(acc.data.subarray(4, 36));
    try {
      const r = await readAccount(rpc, pdAddr, { size: 'large' });
      pdSlot = r.contextSlot;
      const ok = r.acc && r.acc.owner === UPGRADEABLE_LOADER && r.acc.data.length >= PROGRAMDATA_HEADER && u32le(r.acc.data, 0) === 3;
      if (ok) pd = r.acc.data;
      add({ id: 'PROGRAMDATA', status: ok ? 'PASS' : 'FAIL', value: { address: pdAddr, length: r.acc?.data.length ?? null }, ...ctx(pdSlot),
        note: ok ? 'ProgramData decoded (UpgradeableLoaderState::ProgramData)' : r.acc ? 'ProgramData account present but not decodable as ProgramData' : 'ProgramData account missing' });
    } catch (e) { add({ id: 'PROGRAMDATA', status: 'ERROR', value: { address: pdAddr }, error: sanitizeError(e), note: 'RPC read failed' }); }
  }
  if (pd) {
    const tag = pd[12];
    const authBytes = pd.subarray(13, 45);
    if (tag === 1) add({ id: 'UPGRADE_AUTHORITY', status: 'RECORDED', value: addrDec.decode(authBytes), ...ctx(pdSlot), note: 'upgradeable; identity of the holder is not established by this read' });
    // bincode writes None as one byte and leaves the old 32 authority bytes in place, so only the tag is meaningful.
    else if (tag === 0) add({ id: 'UPGRADE_AUTHORITY', status: 'RECORDED', value: null, ...ctx(pdSlot), note: 'no upgrade authority (immutable)' });
    else add({ id: 'UPGRADE_AUTHORITY', status: 'FAIL', value: { optionTag: tag }, ...ctx(pdSlot), note: `invalid option tag ${tag}; never read as immutable` });
    add({ id: 'DEPLOY_SLOT', status: 'RECORDED', value: u64le(pd, 4).toString(), ...ctx(pdSlot) });
    add({ id: 'EXECUTABLE_HASH', status: 'RECORDED', value: executableHash(pd), ...ctx(pdSlot),
      note: 'sha256 of the trimmed executable; a hash alone does not identify a release (e.g. 0.2.1 vs 0.2.2)' });
  } else {
    for (const id of ['UPGRADE_AUTHORITY', 'DEPLOY_SLOT', 'EXECUTABLE_HASH']) add(UNKNOWN(id, p.id, 'ProgramData not decoded'));
  }
  if (skipExternal) return checks;
  try {
    const idl = await anchorIdl(rpc, p.id);
    const v = { address: idl.address, present: idl.present, version: idl.version ?? null, instructionCount: idl.instructions?.length ?? 0 };
    if (p.interfaceIndicator && idl.present) v[`has_${p.interfaceIndicator}`] = idl.instructions.includes(p.interfaceIndicator);
    add({ id: 'INTERFACE', status: idl.present ? 'RECORDED' : 'UNKNOWN', value: v,
      note: idl.present ? 'on-chain Anchor IDL recorded; an IDL account can lag or differ from the deployed code, so this is an indicator only' : 'no on-chain Anchor IDL account' });
  } catch (e) { add({ id: 'INTERFACE', status: 'UNKNOWN', note: `IDL read/decode failed: ${sanitizeError(e)}` }); }
  const o = await osec(p.id);
  const execHash = checks.find((c) => c.id === 'EXECUTABLE_HASH')?.value ?? null;
  const osecText = o.error ? `OtterSec status unavailable (${o.error})`
    : `${o.is_verified ? 'OtterSec reports a verified build' : 'not verified by OtterSec; this is not a demonstrated mismatch'}`
      + `${o.on_chain_hash ? `; OtterSec on-chain hash ${o.on_chain_hash}${execHash ? (o.on_chain_hash === execHash ? ' (equals the hash read here)' : ' (differs from the hash read here)') : ''}` : ''}`;
  add({ id: 'SOURCE_BUILD', status: 'NOT_ATTEMPTED', osec: osecText, raw: o.error ? undefined : { is_verified: o.is_verified ?? null, on_chain_hash: o.on_chain_hash ?? null, repo_url: o.repo_url ?? null, commit: o.commit ?? null },
    note: 'no reproducible build attempted: building the Meteora program source for commercial evaluation awaits licence permission (LOCAL-1)' });
  add({ id: 'AUDIT_COVERAGE', status: 'NOT_EVALUATED', note: 'a source/build match is not a security audit; audit scope versus deployed code was not assessed' });
  return checks;
}

async function inspectConfig(rpc, label, address) {
  const required = REQUIRED_CONFIGS.has(label);
  const base = { id: 'CONFIG', subject: label, address, required };
  const compat = { id: 'CONFIG_COMPATIBILITY', subject: label, address, required };
  let r;
  try { r = await readAccount(rpc, address); }
  catch (e) { return [{ ...base, status: 'ERROR', error: sanitizeError(e), note: 'RPC read failed' }, { ...compat, status: 'UNKNOWN', note: 'config not read' }]; }
  const ctx = { contextSlot: r.contextSlot, commitment: COMMITMENT };
  if (!r.acc) return [{ ...base, status: 'FAIL', note: 'config account missing', ...ctx }, { ...compat, status: 'UNKNOWN', note: 'config missing' }];
  if (r.acc.owner !== DAMM_V2) return [{ ...base, status: 'FAIL', value: { owner: r.acc.owner, dataLength: r.acc.data.length }, note: 'not owned by DAMM v2', ...ctx }, { ...compat, status: 'UNKNOWN', note: 'config invalid' }];
  let cfg;
  try { cfg = decodeDammV2Config(r.acc.data); }
  catch (e) { return [{ ...base, status: 'FAIL', value: { owner: r.acc.owner, dataLength: r.acc.data.length }, note: `not a complete DAMM v2 Config: ${e.message}`, ...ctx }, { ...compat, status: 'UNKNOWN', note: 'config invalid' }]; }
  const fields = { pool_creator_authority: cfg.pool_creator_authority, vault_config_key: cfg.vault_config_key, activation_type: cfg.activation_type,
    collect_fee_mode: cfg.collect_fee_mode, config_type: cfg.config_type, index: cfg.index, sqrt_min_price: cfg.sqrt_min_price, sqrt_max_price: cfg.sqrt_max_price };
  const route = CONFIG_ROUTES[label];
  const configOk = { ...base, status: 'PASS', value: { owner: r.acc.owner, dataLength: r.acc.data.length, decoded: fields }, note: 'owned by DAMM v2; full Config layout decoded (cp-amm-sdk 1.4.10 IDL)', ...ctx };
  if (!route) {
    return [configOk, { ...compat, status: 'NOT_ASSESSED', ...ctx,
      value: { route: label, pool_creator_authority: cfg.pool_creator_authority, config_type: cfg.config_type },
      note: 'fixed-fee migration routes are outside V0; recorded, not assessed (no route-specific fee/range/schedule/activation rules defined)' }];
  }
  const problems = [];
  if (cfg.pool_creator_authority !== route.poolCreatorAuthority) problems.push(`pool_creator_authority ${cfg.pool_creator_authority} != DBC pool authority ${route.poolCreatorAuthority}`);
  if (!(cfg.config_type in DAMM_V2_CONFIG_TYPES)) problems.push(`config_type ${cfg.config_type} is not a known ConfigType (0 Static, 1 Dynamic)`);
  else if (cfg.config_type !== route.configType) problems.push(`config_type ${cfg.config_type} (${DAMM_V2_CONFIG_TYPES[cfg.config_type]}) but the ${label} route requires ${route.configType} (${DAMM_V2_CONFIG_TYPES[route.configType]})`);
  return [configOk, { ...compat, status: problems.length ? 'FAIL' : 'PASS', ...ctx,
    value: { route: label, pool_creator_authority: cfg.pool_creator_authority, expected_pool_creator_authority: route.poolCreatorAuthority,
      config_type: cfg.config_type, expected_config_type: route.configType, evidence: route.evidence },
    note: problems.length ? problems.join('; ')
      : `${label} route: DBC pool authority and Dynamic config_type both match. Rules are CONFIRMED_FOR_PINNED_SOURCE (DBC f552f20, DAMM a85c926) and the authority PDA is CONFIRMED_OFFLINE; this row is the live observation of this account only` }];
}

/**
 * Runs every check for one cluster. `rpc` is injected (live JSON-RPC or a labelled fake).
 * Checks after a failed CONNECTIVITY or CLUSTER_IDENTITY are UNKNOWN, never inferred. Recoverable RPC errors are
 * per-check ERROR. With `rpc2`, CROSS_CHECK is required: UNAVAILABLE (second provider not usable) is distinct from
 * DISAGREEMENT (a contradiction that survived one re-read at a consistent context slot).
 */
export async function verifyCluster({ cluster, rpc, rpc2 = null, osec = fetchOsecStatus, endpoint = null, now = () => new Date().toISOString() }) {
  const r = { schemaVersion: REPORT_SCHEMA_VERSION, cluster, endpoint: endpoint ? redactUrl(endpoint) : (rpc.endpoint ?? null), rpcLabel: rpc.label ?? 'UNLABELLED',
    commitment: COMMITMENT, crossCheckRequested: !!rpc2, startedAt: now(), checks: [] };
  const skipAll = (why) => {
    for (const p of PROGRAMS) for (const id of PROGRAM_CHECK_IDS) r.checks.push({ ...UNKNOWN(id, p.id, why), program: p.name, required: p.required });
    for (const [label, address] of DAMM_V2_MIGRATION_CONFIGS) for (const id of ['CONFIG', 'CONFIG_COMPATIBILITY']) r.checks.push({ id, subject: label, address, required: REQUIRED_CONFIGS.has(label), status: 'UNKNOWN', note: why });
    if (rpc2) for (const p of PROGRAMS) r.checks.push({ ...UNKNOWN('CROSS_CHECK', p.id, why), program: p.name, required: p.required });
    r.finishedAt = now();
  };
  let genesis;
  try {
    genesis = await rpc.getGenesisHash();
    r.checks.push({ id: 'CONNECTIVITY', subject: cluster, status: 'PASS', required: true });
  } catch (e) {
    r.checks.push({ id: 'CONNECTIVITY', subject: cluster, status: 'FAIL', required: true, error: sanitizeError(e) });
    r.checks.push({ id: 'CLUSTER_IDENTITY', subject: cluster, status: 'UNKNOWN', required: true, note: 'not reached' });
    skipAll('RPC not reachable');
    return r;
  }
  const expected = GENESIS[cluster];
  const idStatus = expected ? (genesis === expected ? 'PASS' : 'FAIL') : 'UNKNOWN';
  r.checks.push({ id: 'CLUSTER_IDENTITY', subject: cluster, status: idStatus, required: true, value: { genesisHash: genesis, expected: expected ?? null },
    note: expected ? 'genesis hash compared with the published value' : 'no published genesis for this cluster; identity cannot be validated' });
  try { r.version = await rpc.getVersion(); } catch (e) { r.version = { error: sanitizeError(e) }; }
  if (idStatus === 'FAIL') { skipAll('cluster identity failed; data from this endpoint is not trusted'); return r; }
  for (const p of PROGRAMS) r.checks.push(...await inspectProgram(rpc, p, osec));
  for (const [label, address] of DAMM_V2_MIGRATION_CONFIGS) r.checks.push(...await inspectConfig(rpc, label, address));
  if (rpc2) r.checks.push(...await crossCheck(r, rpc, rpc2, genesis));
  r.finishedAt = now();
  return r;
}

const pickVal = (checks, id, subject) => checks.find((c) => c.id === id && c.subject === subject);
async function crossCheck(r, rpc, rpc2, genesis) {
  const out = [];
  const mk = (p, status, extra) => ({ id: 'CROSS_CHECK', subject: p.id, program: p.name, required: p.required, status, ...extra });
  let g2;
  try { g2 = await rpc2.getGenesisHash(); }
  catch (e) { for (const p of PROGRAMS) out.push(mk(p, 'UNAVAILABLE', { error: sanitizeError(e), note: 'second provider unreachable; no comparison was made' })); return out; }
  if (g2 !== genesis) { for (const p of PROGRAMS) out.push(mk(p, 'DISAGREEMENT', { value: { genesisA: genesis, genesisB: g2 }, note: 'second provider reports a different cluster' })); return out; }
  const facts = (checks, id) => ({ authority: pickVal(checks, 'UPGRADE_AUTHORITY', id), hash: pickVal(checks, 'EXECUTABLE_HASH', id) });
  const usable = (f) => f.authority?.status === 'RECORDED' && f.hash?.status === 'RECORDED';
  const same = (a, b) => JSON.stringify(a.authority.value) === JSON.stringify(b.authority.value) && a.hash.value === b.hash.value;
  for (const p of PROGRAMS) {
    const a = facts(r.checks, p.id);
    let bChecks;
    try { bChecks = await inspectProgram(rpc2, p, null, { skipExternal: true }); } catch (e) { out.push(mk(p, 'UNAVAILABLE', { error: sanitizeError(e) })); continue; }
    let b = facts(bChecks, p.id);
    if (!usable(a) || !usable(b)) { out.push(mk(p, 'UNAVAILABLE', { note: 'authority/hash not recorded on both providers; nothing to compare' })); continue; }
    if (same(a, b)) { out.push(mk(p, 'PASS', { value: { contextSlots: [a.hash.contextSlot, b.hash.contextSlot] }, note: 'same genesis, upgrade authority and executable hash on an independent provider' })); continue; }
    // One re-read of both sides at a consistent context (the newer of the two observed slots) before calling it a contradiction.
    const minContextSlot = Math.max(Number(a.hash.contextSlot ?? 0), Number(b.hash.contextSlot ?? 0)) || undefined;
    let a2, b2;
    try {
      a2 = facts(await inspectProgram({ ...rpc, getAccountInfoWithContext: (x, o) => rpc.getAccountInfoWithContext(x, { ...o, minContextSlot }) }, p, null, { skipExternal: true }), p.id);
      b2 = facts(await inspectProgram({ ...rpc2, getAccountInfoWithContext: (x, o) => rpc2.getAccountInfoWithContext(x, { ...o, minContextSlot }) }, p, null, { skipExternal: true }), p.id);
    } catch (e) { out.push(mk(p, 'UNAVAILABLE', { error: sanitizeError(e), note: 'consistent re-read failed after an initial difference' })); continue; }
    if (usable(a2) && usable(b2) && same(a2, b2)) out.push(mk(p, 'PASS', { value: { minContextSlot }, note: 'initial difference resolved by a re-read at a consistent context slot' }));
    else out.push(mk(p, 'DISAGREEMENT', { value: { minContextSlot, a: { authority: a2.authority?.value, hash: a2.hash?.value, slot: a2.hash?.contextSlot }, b: { authority: b2.authority?.value, hash: b2.hash?.value, slot: b2.hash?.contextSlot } },
      note: 'providers disagree after a consistent re-read; not waived' }));
  }
  return out;
}

const SATISFIED = new Set(['PASS', 'RECORDED']);
const UNAVAILABLE_CLASS = new Set(['UNAVAILABLE', 'ERROR']);
const REQUIRED_PROGRAM_CHECKS = ['PROGRAM_PRESENCE', 'LOADER_STATE', 'PROGRAMDATA', 'UPGRADE_AUTHORITY', 'EXECUTABLE_HASH'];

/**
 * The expected check inventory for a run, built from the plan (clusters, cross-check) and the pinned program/config
 * lists, never from the results. Each entry: { cluster, id, subject, required }.
 */
export function expectedInventory(plan) {
  const out = [];
  for (const { cluster, crossCheck } of plan) {
    out.push({ cluster, id: 'CONNECTIVITY', subject: cluster, required: true }, { cluster, id: 'CLUSTER_IDENTITY', subject: cluster, required: true });
    for (const p of PROGRAMS) {
      for (const id of PROGRAM_CHECK_IDS) out.push({ cluster, id, subject: p.id, required: p.required && REQUIRED_PROGRAM_CHECKS.includes(id) });
      if (crossCheck) out.push({ cluster, id: 'CROSS_CHECK', subject: p.id, required: p.required });
    }
    for (const [label] of DAMM_V2_MIGRATION_CONFIGS) for (const id of ['CONFIG', 'CONFIG_COMPATIBILITY']) out.push({ cluster, id, subject: label, required: REQUIRED_CONFIGS.has(label) });
  }
  return out;
}
/** Plan implied by the reports themselves (library callers); the CLI passes its own plan from the flags. */
const impliedPlan = (clusters) => clusters.map((r) => ({ cluster: r.cluster, crossCheck: !!r.crossCheckRequested }));

export function summarize(clusters, plan = impliedPlan(clusters)) {
  const expected = expectedInventory(plan);
  const key = (c, x) => `${c}|${x.id}|${x.subject}`;
  const got = new Map();
  for (const r of clusters) for (const c of r.checks ?? []) { const k = key(r.cluster, c); got.set(k, [...(got.get(k) ?? []), c]); }
  const expectedKeys = new Set(expected.map((e) => key(e.cluster, e)));
  const missing = [], duplicate = [], unexpected = [], requiredFailures = [];
  for (const e of expected) {
    const found = got.get(key(e.cluster, e)) ?? [];
    if (found.length === 0) { missing.push(e); if (e.required) requiredFailures.push({ cluster: e.cluster, id: e.id, subject: e.subject, status: 'MISSING' }); continue; }
    if (found.length > 1) { duplicate.push(e); requiredFailures.push({ cluster: e.cluster, id: e.id, subject: e.subject, status: 'DUPLICATE' }); continue; }
    if (e.required && !SATISFIED.has(found[0].status)) requiredFailures.push({ cluster: e.cluster, id: e.id, subject: e.subject, status: found[0].status });
  }
  for (const [k, cs] of got) if (!expectedKeys.has(k)) { unexpected.push(k); requiredFailures.push({ key: k, status: 'UNEXPECTED', observed: cs[0].status }); }
  return { requiredFailures, overall: requiredFailures.length === 0 ? 'REQUIRED_CHECKS_SATISFIED' : 'REQUIRED_CHECKS_NOT_SATISFIED',
    inventory: { expected: expected.length, required: expected.filter((e) => e.required).length, missing: missing.length, duplicate: duplicate.length, unexpected: unexpected.length },
    notes: ['SOURCE_BUILD is NOT_ATTEMPTED and AUDIT_COVERAGE is NOT_EVALUATED in every run; neither is implied by any PASS.',
      'Exit 0 means only that the expected read-only inventory was complete and satisfied; it is not a readiness decision for any stage.'] };
}

/**
 * 0 = the expected inventory is complete and every required check is satisfied.
 * 2 = nothing contradicts, but a cluster, a second provider or a read was unavailable (CONNECTIVITY FAIL, UNAVAILABLE, ERROR).
 * 3 = a required check failed, disagreed, is unknown, missing, duplicated or unexpected.
 */
export function exitCodeFor(clusters, plan) {
  const { requiredFailures } = summarize(clusters, plan);
  if (requiredFailures.length === 0) return 0;
  const unreachable = new Set(clusters.filter((r) => r.checks?.some((c) => c.id === 'CONNECTIVITY' && c.status === 'FAIL')).map((r) => r.cluster));
  const unavailableOnly = requiredFailures.every((f) => UNAVAILABLE_CLASS.has(f.status) || (f.cluster && unreachable.has(f.cluster) && (f.status === 'UNKNOWN' || f.id === 'CONNECTIVITY')));
  return unavailableOnly ? 2 : 3;
}

export function renderMarkdown(report) {
  const L = [`# Program verification (READ-ONLY diagnostic) ${report.generatedAt.slice(0, 10)}`, '',
    `Generated ${report.generatedAt} by tools/program-verify ${VERIFIER_VERSION}. Reads only; no wallet, no transaction, no attestation.`, '',
    `Report schema ${REPORT_SCHEMA_VERSION}; commitment ${COMMITMENT}.`, '',
    `Required checks: **${report.summary.overall}** (exit code ${report.exitCode}). Inventory: ${report.summary.inventory ? `${report.summary.inventory.expected} expected, ${report.summary.inventory.missing} missing, ${report.summary.inventory.duplicate} duplicate, ${report.summary.inventory.unexpected} unexpected` : 'n/a'}.`, ''];
  for (const c of report.clusters) {
    L.push(`## ${c.cluster}`, '', `Endpoint: ${c.endpoint ?? 'n/a'} · RPC: ${c.rpcLabel} · started ${c.startedAt ?? 'n/a'} · finished ${c.finishedAt ?? 'n/a'}`, '', '| Check | Subject | Status | Slot | Value / note |', '|---|---|---|---|---|');
    for (const k of c.checks) {
      const v = k.error ?? k.osec ?? (k.value === undefined ? '' : JSON.stringify(k.value));
      L.push(`| ${k.id} | ${k.program ?? k.subject} | ${k.status} | ${k.contextSlot ?? ''} | ${[v, k.note].filter(Boolean).join(' — ').replace(/\|/g, '\\|')} |`);
    }
    L.push('');
  }
  L.push('Raw JSON is written next to this file.', '');
  return L.join('\n');
}
