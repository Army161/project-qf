# TOKEN-2022 — Extension policy (V1)

Source of truth for extension types and invalid combinations: `solana-program/token-2022` @ `23b03f8`, `interface/src/extension/mod.rs` (FACT). Current mint extension types include TransferFeeConfig, MintCloseAuthority, ConfidentialTransferMint, DefaultAccountState, NonTransferable, InterestBearingConfig, PermanentDelegate, TransferHook, ConfidentialTransferFeeConfig, MetadataPointer, TokenMetadata, GroupPointer, TokenGroup, GroupMemberPointer, TokenGroupMember, ConfidentialMintBurn, ScaledUiAmount, Pausable, PermissionedBurn.

Invalid combinations enforced by the Token-2022 program (FACT):
- ConfidentialTransferFeeConfig without (TransferFeeConfig and ConfidentialTransferMint)
- TransferFeeConfig + ConfidentialTransferMint without ConfidentialTransferFeeConfig
- ConfidentialMintBurn without ConfidentialTransferMint
- ScaledUiAmount + InterestBearingConfig
- NonTransferable + ConfidentialTransferMint without ConfidentialMintBurn

## 1. Launched (base) token
DECISION: default **classic SPL Token**. Token-2022 only when a supported QF capability requires it; no V1.0 capability does.

| Category | Extensions | Notes |
|---|---|---|
| SUPPORTED (if T22 is ever selected) | MetadataPointer + TokenMetadata | DBC sets these itself for `token_type=1` (FACT) |
| EXPERIMENTAL_DISABLED | TransferFeeConfig (base) | Requires DBC 0.2.2 `create_config2` (unmerged). ADR-003 |
| NOT V1 | TransferHook (DBC hook configs; hook revoked at curve completion) | Needs an on-chain QF hook program — out of V1 |
| IMPOSSIBLE via DBC | all others | DBC initializes the mint |

## 2. Quote mint (validator S1.4)
| Category | Extensions | Rationale |
|---|---|---|
| SUPPORTED | none (classic SPL); MetadataPointer; TokenMetadata | DBC permissionless (`is_supported_quote_mint`) |
| CONDITIONALLY SUPPORTED (Meteora TokenBadge present **and** QF WARN review) | TransferFeeConfig with 0 bps **and** authority None; MintCloseAuthority; InterestBearingConfig; ScaledUiAmount (display differs, raw math unaffected; UI shows raw + UI amount); GroupPointer; TokenGroup; GroupMemberPointer; TokenGroupMember | Low direct pool risk; disclose |
| REJECTED (FAIL) | PermanentDelegate; TransferHook; DefaultAccountState; Pausable; NonTransferable; ConfidentialTransferMint; ConfidentialTransferFeeConfig; ConfidentialMintBurn; PermissionedBurn; TransferFeeConfig with nonzero bps or live authority; any unknown/new extension type | Vault drain, issuer halt, frozen vaults, unauditable balances, unassessed behaviour |

Note (FACT, DBC 0.2.2 CHANGELOG, unreleased): 0.2.2 would make "TransferFeeConfig, zero fee, authority revoked" permissionless and allow badged nonzero-fee quote mints via `create_config2`. QF policy stays stricter: nonzero-fee quote mints remain FAIL until a new validator policy version says otherwise.

## 3. Account-level extensions (user side)
MemoTransfer, CpiGuard, ImmutableOwner are not mint properties. The tx builder detects MemoTransfer/CpiGuard on the user's token account and shows a pre-flight warning.

## 4. Real-world check
Ondo Global Markets mints (FACT, `ondoprotocol/global-markets-solana` @ `d1d011e`, `token_factory.rs`) use ScaledUiAmount, MetadataPointer, Pausable, ConfidentialTransferMint, DefaultAccountState, TransferHook (+ optional PermanentDelegate) → FAIL by §2 and by asset class (tokenized security).
