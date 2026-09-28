# CANONICAL-ASSETS — Canonical Asset Registry

Identity is `(chain, canonical_mint)`. Symbols and names are display only.

## 1. Schema
```sql
create table issuer (
  issuer_id uuid primary key,
  legal_name text not null,
  trust_tier text not null check (trust_tier in ('regulated','established','unknown','devnet_test')),
  official_domains text[] not null,
  first_party_address_page_url text,
  authority_allowlisted boolean not null default false,   -- permits freeze/mint authority → WARN instead of FAIL
  allowlist_approved_by text[],                             -- two distinct reviewers
  allowlist_approved_at timestamptz
);
create table asset (
  asset_id uuid primary key,
  chain text not null,                        -- solana-mainnet | solana-devnet | solana-localnet
  canonical_mint text not null,
  symbol text, name text,                     -- display only
  issuer_id uuid references issuer,
  token_program text not null,                -- spl-token | token-2022
  decimals smallint not null,
  extensions jsonb not null,                  -- snapshot incl. authorities per extension
  mint_authority text, freeze_authority text,
  last_authority_change_slot bigint,
  bridge_provenance jsonb,                    -- {bridge, origin_chain, origin_address, registry_url, retrieved_at, content_hash}
  provenance_confidence text not null check (provenance_confidence in ('first_party','official_bridge','corroborated','unverified')),
  legal_asset_class text not null check (legal_asset_class in ('native_crypto','stablecoin','wrapped_crypto','tokenized_security','lst','unknown')),
  oracle jsonb,                               -- {provider:'pyth', feed_id, verified_at}
  liquidity_sources jsonb,
  verification_sources jsonb not null,        -- [{type, ref, retrieved_at, content_hash, license_class, raw_or_derived}]
  data_license_tags text[] not null,          -- DATA-LICENSES.md classes present in this record
  capability_flags text[] not null default '{}', -- e.g. {'dbc_permissionless'} | {'dbc_token_badge'}
  risk_status text not null,                  -- PASS|WARN|FAIL (last validation)
  qf_compatibility jsonb not null,            -- {dbc:{permissionless,badge}, damm_v2, settlement:{sf_rewards}}
  status text not null check (status in ('verified','pending','rejected','deprecated')),
  policy_version text not null,               -- validator policy used for risk_status
  last_verified_at timestamptz, last_verified_slot bigint,
  verified_by text[],                         -- two-person rule for status=verified
  unique (chain, canonical_mint)
);
```
Every external datum carries `source`, `retrieved_at`, `license_class`, `content_hash` (where applicable), `raw_or_derived`.

## 2. Source precedence
1. Issuer first-party address page on an official domain (required for `verified`).
2. On-chain state at a recorded finalized slot (two RPCs).
3. Official bridge registry for wrapped assets (which endpoint is authoritative per bridge: OPEN, see ROADMAP open items).
4. Secondary corroboration (≥ 1): Pyth feed metadata, approved commercial provider. Jupiter `isVerified` MAY be viewed by an operator but is not stored while ADR-005 gate is closed.

## 3. Rules
- `verified` requires sources 1 + 2 + 4 and two distinct reviewers. Changing `canonical_mint` requires the same.
- `legal_asset_class = tokenized_security` ⇒ validator FAIL in production V1.
- Wrapped assets without source 1 or 3 ⇒ `provenance_confidence = unverified` ⇒ FAIL.
- AuthorityMonitor updates `last_authority_change_slot` and triggers revalidation.

## 4. Authority allowlist
Freeze/mint-authority issuers (e.g., USDC's issuer) are allowlisted only after: verified first-party mint publication, documented issuer identity, two-person production review. Allowlisting changes a FAIL to WARN-with-disclosure, never to PASS.

## 5. Initial candidate set (to be verified, not assumed)
SOL (wrapped native `So11111111111111111111111111111111111111112`), USDC, USDT, JUP and other assets named by the product owner. Each entry must pass §3 before `verified`. No mint address in this document is authoritative except wrapped SOL.
