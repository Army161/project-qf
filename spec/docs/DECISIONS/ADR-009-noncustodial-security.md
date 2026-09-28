# ADR-009: Non-custodial execution and authority separation

- Status: **Accepted** (2026-09-26, product owner decision; recorded by spec author)
- Supersedes: corresponding items in `V1-ARCHITECTURE-REVIEW.md`

## Decision
Users sign their own launch/trade/claim transactions; the server never signs for users; decoded preview is generated client-side. AI has no key or write access. Production authorities are separate 2-of-3 hardware-backed multisigs: CONFIG_OWNER, FEE_CLAIMER, REWARD_AUTHORITY, DEPLOYMENT_ADMIN. MIGRATION_CRANK and harvester fee payers are KMS/HSM-backed hot keys with minimal balance and no other authority. QF never takes custody of user trading funds; protocol fees flow only through program/multisig-controlled accounts with transparent accounting.

## Rationale
Minimizes blast radius and aligns with the product owner's regulatory posture for self-custodial interfaces (legal analysis is counsel's).

## Consequences
Operational overhead of multisig signing for config creation and fee claims.

## Amendment 2026-09-27 (repair pass, QF-SEC-01a/b) — transaction preview binds terms, not just programs
A program allowlist is a coarse filter only. `verifyTransactionPreview` (`packages/tx`) decodes the serialized message and binds it to owner-approved `ApprovedTerms` and a `ConsentRecord`:
- **Engine instruction.** Exactly one DBC instruction, strictly Borsh-decoded from an IDL subset extracted from the MIT SDK package (trailing bytes, short reads, bad bool/option tags and invalid UTF-8 are rejected). The operation, every named account (PDAs re-derived), mints, amounts, minimum-out and the full config parameter digest must equal the terms.
- **Supporting instructions.** ComputeBudget limit/price only, capped (1,400,000 CU, 10,000,000 micro-lamports). ATA CreateIdempotent only for the expected owner/mint/token program, paid by the fee payer. Any other System/Token/Token-2022 instruction is `UNBOUND_INSTRUCTION`; any other program is `UNEXPECTED_PROGRAM`.
- **Signers and writability.** The signer set must be exact (MIGRATE's two ephemeral position-NFT mints are allowed only with their derived position accounts). Writable accounts must be a subset of the expected set.
- **Consent.** The consent digest binds terms digest, cluster, policy version `tx-binding-v0.1`, evidence digest and acknowledgement digest. A refreshed blockhash does not permit changed terms.
- **Fail closed in V0.** Native SOL wrap/unwrap flows, Token-2022 and address lookup tables are rejected (`TERMS_UNSUPPORTED_V0`, `ADDRESS_LOOKUP_TABLES_NOT_SUPPORTED_IN_PREVIEW`) until each has its own binding and tests.
Serialized-message mutation tests (`packages/adapter-meteora-dbc/test/mutation.test.ts`) cover substituted mint/destination/fee recipient, extra transfers, authority changes, wrong operation, excessive compute and amounts. This is offline validation, not signing authorization; signing stays disabled (`EXECUTION_FRESHNESS_POLICY` is UNDEFINED).
