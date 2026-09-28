# CONFIG-REGISTRY

DBC launches reference a partner **config** account. QF reuses configs; it does not create one per launch.

## 1. Config key
```
ConfigKey = (chain, quoteMint, templateVersion, tokenType, feePolicyVersion, migrationPolicyVersion, capabilityFlags[])
```
Example: `(solana-mainnet, <USDC mint>, STANDARD_V1@1, SPL, fees@1, migration@1, [])`.

## 2. Record
```sql
create table dbc_config (
  qf_config_id uuid primary key,
  config_key_hash text unique not null,       -- sha256 of canonical JSON of ConfigKey
  chain text not null,
  onchain_config text unique,                 -- DBC config account pubkey
  quote_mint text not null,
  template_version text not null, token_type text not null,
  fee_policy_version text not null, migration_policy_version text not null,
  capability_flags text[] not null,
  params jsonb not null,                      -- exact ConfigParameters submitted (engine-neutral + adapter blob)
  program_version text not null,              -- e.g. dbc-0.2.1
  sdk_version text not null,                  -- e.g. 1.5.13
  creation_signature text, created_slot bigint,
  owner text not null, fee_claimer text not null,   -- multisig vaults
  status text not null check (status in ('proposed','active','paused','deprecated','replaced')),
  replaced_by uuid references dbc_config,
  compatibility jsonb not null                -- {keeperEligible, tokenBadgeRequired, verifiedDecodeMatchesParams}
);
```

## 3. Lifecycle
1. `proposed` — Policy Engine emits params for a new ConfigKey.
2. Multisig (CONFIG_OWNER) signs `createConfig`; tx recorded.
3. Verifier decodes the on-chain config and asserts byte-for-byte parity with `params` → `active`.
4. `paused`/`deprecated` when a policy version, quote validation, or engine version changes; `replaced_by` points to the successor. Existing pools are unaffected (they keep their config).

## 4. Rules
- A launch MUST use an `active` config whose quote mint currently validates PASS/WARN.
- Config creation is never triggered from a user request path.
- DBC 0.2.0 showed Meteora can make existing configs unusable for new pools (FACT, CHANGELOG 0.2.0). The Revalidator dry-runs pool creation (simulation) against every active config daily; failure → `paused` + alert.
