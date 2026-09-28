// In-memory FAKE_RPC cluster for verifier tests. Nothing here touches a network.
// Config accounts are full-length (8-byte discriminator + 320-byte DAMM v2 Config) so decoding is exercised.
import { deflateSync } from 'node:zlib';
import { getAddressEncoder, getProgramDerivedAddress, createAddressWithSeed } from '@solana/addresses';
import { GENESIS, PROGRAMS, DAMM_V2_MIGRATION_CONFIGS, UPGRADEABLE_LOADER } from '../../lib.mjs';

const enc = getAddressEncoder();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export const CONFIG_DISC = Buffer.from([155, 12, 170, 224, 30, 250, 204, 130]);
export const DBC_POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
export const DAMM = PROGRAMS[1].id;
export const DBC = PROGRAMS[0].id;
export const CUSTOMIZABLE = DAMM_V2_MIGRATION_CONFIGS.find(([l]) => l === 'Customizable')[1];

/** 328-byte DAMM v2 Config: disc | vault_config_key | pool_creator_authority | pool_fees(128) | u8 x3 | pad5 | index | sqrt_min | sqrt_max | permission | pad[u64;8]. */
export function configBytes({ poolCreatorAuthority = DBC_POOL_AUTHORITY, index = 7n, collectFeeMode = 1, configType = 1 } = {}) {
  const b = Buffer.alloc(328);
  CONFIG_DISC.copy(b, 0);
  Buffer.from(enc.encode(poolCreatorAuthority)).copy(b, 40);
  b[200] = 0; b[201] = collectFeeMode; b[202] = configType;
  b.writeBigUInt64LE(BigInt(index), 208);
  return b;
}

export async function fakeCluster({ genesis = GENESIS['mainnet-beta'], slot = 400_000_000, mutate = () => {} } = {}) {
  const accounts = new Map();
  const programDataAddr = {};
  for (const p of PROGRAMS) {
    const [pd] = await getProgramDerivedAddress({ programAddress: UPGRADEABLE_LOADER, seeds: [enc.encode(p.id)] });
    programDataAddr[p.id] = pd;
    accounts.set(p.id, { owner: UPGRADEABLE_LOADER, executable: true, data: Buffer.concat([u32(2), Buffer.from(enc.encode(pd))]) });
    const exe = Buffer.concat([Buffer.from(`ELF-${p.id}`), Buffer.alloc(16)]);
    accounts.set(pd, { owner: UPGRADEABLE_LOADER, executable: false,
      data: Buffer.concat([u32(3), u64(123456), Buffer.from([1]), Buffer.from(enc.encode(PROGRAMS[0].id)), exe]) });
    const [base] = await getProgramDerivedAddress({ programAddress: p.id, seeds: [] });
    const idlAddr = await createAddressWithSeed({ baseAddress: base, programAddress: p.id, seed: 'anchor:idl' });
    const idl = deflateSync(Buffer.from(JSON.stringify({ metadata: { version: '0.2.1' }, instructions: [{ name: 'create_config' }, { name: 'swap' }] })));
    accounts.set(idlAddr, { owner: p.id, executable: false, data: Buffer.concat([Buffer.alloc(8), Buffer.alloc(32), u32(idl.length), idl]) });
  }
  for (const [, addr] of DAMM_V2_MIGRATION_CONFIGS) accounts.set(addr, { owner: DAMM, executable: false, data: configBytes() });
  const state = { genesis, slot, accounts, programDataAddr, failWith: null, failAccount: new Map() };
  mutate(state);
  const read = (a) => {
    if (state.failAccount.has(a)) throw state.failAccount.get(a);
    const x = state.accounts.get(a);
    return x ? { ...x, data: new Uint8Array(x.data) } : null;
  };
  return {
    label: 'FAKE_RPC',
    state,
    async getGenesisHash() { if (state.failWith) throw state.failWith; return state.genesis; },
    async getVersion() { return { 'solana-core': 'fake' }; },
    async getAccountInfo(a) { return read(a); },
    async getAccountInfoWithContext(a) { return { contextSlot: state.slot, value: read(a) }; },
  };
}
export const noOsec = async () => ({ error: 'not fetched in test' });
export const check = (r, id, subject) => r.checks.find((c) => c.id === id && (subject === undefined || c.subject === subject));
