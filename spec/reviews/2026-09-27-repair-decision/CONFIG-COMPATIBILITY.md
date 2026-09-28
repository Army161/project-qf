# Config compatibility: source-confirmed, live unverified

## Evidence
S01: DBC f552f20, migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs, validate_config_key, source lines 464–467: the config creator authority must equal DBC's pool authority. The same function is called by the migration handler.
S02: On Customizable, DBC invokes DAMM's initialize_pool_with_dynamic_config. DAMM a85c926 requires ConfigType::Dynamic in that instruction (source lines 185–189).
S03: The pinned DAMM state enum maps Static=0 and Dynamic=1.
S04: DBC uses the pool_authority seed for the authority PDA.

Derived offline:
- program: dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
- seed: pool_authority
- bump: 255
- authority: FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM

The generic DAMM ability to use a public/static config does not remove the more specific DBC migration restriction. Do not relax equality to accept a default/zero creator authority on this route.

## What changes
Retain equality and its pin. Add migration-mode/config-type compatibility to the verifier's pinned policy. For the selected Customizable path require Dynamic (1). Keep fixed-fee migration modes separately scoped, with their own fee/range/schedule/activation rules, or report them as not assessed for V0. Do not label an authority-only comparison complete compatibility.

Use the licensed SDK layout/IDL for decoding; do not copy Meteora's noncommercial program implementation into QF. Research references explain expected behavior, not permission to relicense code.

## Evidence levels
CONFIRMED_FOR_PINNED_SOURCE: authority restriction and dynamic-route type requirement.
CONFIRMED_OFFLINE_DERIVATION: PDA address and bump.
UNKNOWN: live config bytes, cluster presence, program deployment version/authority, deployed/source parity.

No observed successful live account read occurred in this review. Revalidate the rule against the version actually encountered. If deployment differs from the pin, report drift rather than silently accepting a new layout or weakening constraints.

## Regression fixtures
Use a full 328-byte account with correct owner/discriminator/authority:
- type1: type check positive control, other constraints still required;
- type0: fails selected dynamic-route compatibility;
- type255: unknown enum fails;
- wrong authority: fails;
- correct bytes from wrong cluster/owner: fails;
- missing or duplicated required report result: no success.

The included diagnostic reproduces the current type omission using the original inspectConfig function and full-length synthetic bytes. It is not proof of a real deployed config's state.
