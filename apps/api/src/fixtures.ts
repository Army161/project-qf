// TEST_ONLY fixture provider for the 'test-only' cluster. Synthetic mint accounts with no real asset behind them; every
// observation carries providerClass TEST_ONLY and cluster 'mock-offline', so the validator caps it at WARN and the UI
// labels it. It is selected only by an explicit 'test-only' request and is never used when a live read fails.
import { createHash } from 'node:crypto';
import { decodeBase58, encodeBase58 } from '@project-qf/core';
import { encodeMintForFixture, type MintFacts } from '@project-qf/validator';

/** base58(sha256('QF-MOCK:<label>')): well-formed addresses with no known key or asset (same scheme as apps/web fixtures). */
export const mockAddress = (label: string) => encodeBase58(createHash('sha256').update(`QF-MOCK:${label}`).digest());

const AUTH = mockAddress('issuer-authority');
const HOOK_PROGRAM = mockAddress('hook-program');

function feeConfig(bps: number, authority: string | null): Uint8Array {
  const v = new Uint8Array(108);
  if (authority) v.set(decodeBase58(authority), 0);
  for (const o of [72 + 16, 90 + 16]) { v[o] = bps & 0xff; v[o + 1] = bps >> 8; }
  return v;
}

interface FixtureMint { label: string; facts: Omit<MintFacts, 'extensions'>; extensions?: { type: number; value: Uint8Array }[]; disagreeOnB?: boolean }
const base = { initialized: true, mintAuthority: null, freezeAuthority: null, supplyRaw: '1000000000000000', decimals: 6 } as const;

export const FIXTURE_MINTS: Readonly<Record<string, FixtureMint>> = Object.freeze({
  // QUSD from apps/web fixtures: a clean classic SPL mint.
  EtriFwkv36LDftunesYPdxScW2KU5BK55pcm7qwBonXn: { label: 'qUSD clean SPL', facts: { ...base, tokenProgram: 'SPL_TOKEN' } },
  [mockAddress('freezable-spl')]: { label: 'SPL with freeze authority', facts: { ...base, tokenProgram: 'SPL_TOKEN', freezeAuthority: AUTH } },
  [mockAddress('t22-transfer-hook')]: { label: 'Token-2022 with TransferHook', facts: { ...base, tokenProgram: 'TOKEN_2022' },
    extensions: [{ type: 14, value: Uint8Array.from([...new Uint8Array(32), ...decodeBase58(HOOK_PROGRAM)]) }] },
  [mockAddress('t22-transfer-fee')]: { label: 'Token-2022 with 50 bps transfer fee', facts: { ...base, tokenProgram: 'TOKEN_2022' },
    extensions: [{ type: 1, value: feeConfig(50, AUTH) }] },
  [mockAddress('t22-metadata-only')]: { label: 'Token-2022 with metadata pointer only', facts: { ...base, tokenProgram: 'TOKEN_2022' },
    extensions: [{ type: 18, value: new Uint8Array(64) }] },
  [mockAddress('provider-disagreement')]: { label: 'Providers disagree on freeze authority', facts: { ...base, tokenProgram: 'SPL_TOKEN' }, disagreeOnB: true },
});

const OWNER = { SPL_TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' } as const;
export const FIXTURE_PROVIDERS = ['fixture-a.test-only', 'fixture-b.test-only'] as const;
export const FIXTURE_SLOT = '1000';

export function fixtureAccount(provider: string, mint: string): null | { owner: string; dataBase64: string } {
  const f = FIXTURE_MINTS[mint];
  if (!f) return null;
  const facts = f.disagreeOnB && provider === FIXTURE_PROVIDERS[1] ? { ...f.facts, freezeAuthority: AUTH } : f.facts;
  const bytes = encodeMintForFixture({ ...facts, extensions: f.extensions ?? [] }, decodeBase58);
  return { owner: OWNER[f.facts.tokenProgram], dataBase64: Buffer.from(bytes).toString('base64') };
}

/** Synthetic largest accounts: 40% / 10% / 5% / 17 x 1% of supply (20 accounts) (raw amounts as strings). */
export function fixtureLargest(mint: string): { address: string; amountRaw: string }[] {
  const f = FIXTURE_MINTS[mint];
  if (!f) return [];
  const supply = BigInt(f.facts.supplyRaw);
  const pct = [40n, 10n, 5n, ...new Array<bigint>(17).fill(1n)];
  return pct.map((p, i) => ({ address: mockAddress(`holder-${i}`), amountRaw: ((supply * p) / 100n).toString() }));
}
