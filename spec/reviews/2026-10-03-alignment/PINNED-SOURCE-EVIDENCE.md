# Checkable upstream evidence — 2026-10-03

These are physical repository line numbers checked with GitHub file reads at full commit IDs. They are NOT ChatGPT/web-parser line indices. Read-only source inspection supports the statements below; it does not prove deployed/source parity, live account values or an audit. These short quotations are evidence, not permission to copy or port upstream program implementation into QF.

## 1. DBC config creator-authority requirement
Repository: MeteoraAg/dynamic-bonding-curve
Commit: f552f20aa3c1c7631427c3827aeea7c58b902813
Path: programs/dynamic-bonding-curve/src/instructions/migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs
Git blob SHA: 2d8387ab2a6e4f6c35bda11e3c612e374e7e2099
Physical lines: 490–493; essential condition at 491.

```rust
damm_config.pool_creator_authority == const_pda::pool_authority::ID,
```

Source: https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/instructions/migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs#L490-L493

The equality follows the fee-option match and therefore also applies to the Customizable branch. A comment inside that branch does not waive the later authority check.

## 2. Customizable dispatches to DAMM's dynamic-config initializer
Same repository, commit, path and blob as section 1.
Physical lines: 151–178. Customizable branch at 151; CPI invocation at 166; supplied creator authority at 178.

```rust
damm_v2::cpi::initialize_pool_with_dynamic_config(
```

Source: https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/instructions/migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs#L151-L178

## 3. The downstream initializer requires a Dynamic config
Repository: MeteoraAg/damm-v2
Commit: a85c926607433f23f0ea60f4ca7b1ae92f4156cb
Path: programs/cp-amm/src/instructions/initialize_pool/ix_initialize_pool_with_dynamic_config.rs
Git blob SHA: 0d98382ef3a13c2450dbd5aa734f35f5970e61f1
Physical lines: 202–205; condition at 203.

```rust
config.get_config_type()? == ConfigType::Dynamic,
```

Source: https://github.com/MeteoraAg/damm-v2/blob/a85c926607433f23f0ea60f4ca7b1ae92f4156cb/programs/cp-amm/src/instructions/initialize_pool/ix_initialize_pool_with_dynamic_config.rs#L202-L205

## 4. Config encoding: Dynamic is 1
Same DAMM repository and commit.
Path: programs/cp-amm/src/state/config.rs
Git blob SHA: 551f6596fc45a0117655bc34bf08f9df31493ab1
Physical lines: 190–191.

```rust
/// Config type mode, 0 for static, 1 for dynamic
pub config_type: u8,
```

Source: https://github.com/MeteoraAg/damm-v2/blob/a85c926607433f23f0ea60f4ca7b1ae92f4156cb/programs/cp-amm/src/state/config.rs#L190-L191

## Conclusion and limits
For the reviewed Customizable route, authority equality and Dynamic type are required. They are necessary, not sufficient for all migration compatibility. Preserve the complete account owner, layout, cluster and relevant parameter checks. These findings do not verify any live config or program build.

## Current release pointers, not production activation
- Default package manifest: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/main/packages/dynamic-bonding-curve/package.json (read version 1.5.13).
- Program 0.2.2 sync: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/pull/116 (open; proposes SDK 1.6.0 with base transfer-fee support).
- Separate SDK 2.0 refactor: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/pull/117 (open cross-reference from #116).
- Superseded sync: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/pull/114 (shown closed by current #116 cross-reference).
These URLs include evolving branches/PRs, unlike the immutable source references above. Pin a released artifact/integrity and verify deployment/security/integration before enabling any capability. Maintainer-linked devnet examples are not QF's own live verification.
