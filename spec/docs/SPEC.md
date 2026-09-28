# SPEC — Project QF V1 Functional Specification

Normative words: MUST, MUST NOT, SHOULD, MAY.

## 1. Scope
Solana. Execution engine Meteora DBC (program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`) migrating to Meteora DAMM v2 (`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`). Production assumption: DBC program **v0.2.1** (main @ `f552f20`) and SDK **1.5.13**. DBC 0.2.2 / SDK 2.0.0 are unreleased and MUST NOT be required (ADR-003).

## 2. User flow and acceptance criteria

| Step | Behaviour | Acceptance criteria |
|---|---|---|
| F1 Connect | Wallet Standard connect. Compliance hook `jurisdictionGate()` runs (COMPLIANCE.md). | No server-side key material involved. Hook result logged with policy version. |
| F2 Select quote | Search by mint; symbol search shows registry `verified` assets first and labels others "unverified". | Identity = `(chain, mint)`. A symbol-only match never auto-selects. |
| F3 Validate | `Validator.validate(mint, policy=validator-v0.1)` | Returns PASS/WARN/FAIL + per-check evidence + slot + policy version; persisted. FAIL blocks F4+. WARN requires per-warning acknowledgement. |
| F4 Assess | Opportunity Engine returns deterministic scores; AI returns narrative. | Scores reproducible from stored features + score version. AI text never alters scores. |
| F5 Token | Name, symbol, image, description; `tokenType=SPL` default. Metadata JSON uploaded to content-addressed storage. | Metadata sanitized; URI immutable (content hash). |
| F6 Propose | AI Launch Architect emits `LaunchProposal` JSON (AI-ENGINE.md). | Schema-valid or rejected; never executed directly. |
| F7 Policy | Policy Engine clamps/validates proposal against `EconomicsPolicy`, `CurveTemplate`, engine constraints. | Output `LaunchPlan` with `policyDecision: ACCEPT|REJECT` and reasons. |
| F8 Config | ConfigRegistry resolves an existing on-chain DBC config for the key tuple or marks "config creation required (multisig)". | A launch MUST NOT create a partner config from a user session. |
| F9 Simulate | Curve math via SDK quote functions + `simulateTransaction` of the exact create transaction. | Simulation success required; logs and compute units stored. |
| F10 Preview | Client-side decoder renders every instruction, account, amount. | Preview produced in the browser from the transaction bytes, not from server-provided text. |
| F11 Sign/send | User signs in wallet; QF may relay the signed tx. | Server never holds user signer. |
| F12 Trade | Pool trades on DBC (any venue). | Indexer records swaps idempotently. |
| F13 Graduate/migrate | On curve completion: Meteora keeper or QF `MigrationCrank` calls migrate to DAMM v2. | Alert if `complete && !migrated` > policy timeout (default 10 min). |
| F14 Verify post-migration | Verify DAMM v2 pool, positions, locks. | UI never says "permanently locked" unless on-chain state proves it. |
| F15 Harvest | FeeHarvester claims partner fees to the multisig-controlled fee account; creator claims own fees via UI. | Ledger reconciles to on-chain balances. |
| F16 Rewards | RewardEngine plans epochs; settlement per REWARDS.md. | Epoch artifact complete (REWARDS.md §5). Mainnet settlement only when gate open. |
| F17 Analytics | Lifecycle timeline, outcome labels. | Every stage links to signatures. |

## 3. Domain types (engine-neutral)
```ts
type Chain = 'solana-mainnet' | 'solana-devnet' | 'solana-localnet';
type MintRef = { chain: Chain; mint: string };               // identity; never symbol
type Decision = 'PASS' | 'WARN' | 'FAIL';
type RewardStrategyKind = 'NONE' | 'TRADING_FEE' | 'DIRECT' | 'MERKLE' | 'EPOCH_PROPORTIONAL';
type CapabilityFlag = 'DBC_BASE_TRANSFER_FEE';               // EXPERIMENTAL_DISABLED
interface LaunchEngineAdapter {
  id: 'meteora-dbc' | 'raydium';                              // raydium = stub, throws NotImplemented
  constraints(): EngineConstraints;
  resolveConfig(key: ConfigKey): Promise<ConfigRecord | null>;
  buildCreateLaunch(plan: LaunchPlan, creator: string): Promise<UnsignedTx>;
  quote(req: QuoteRequest): Promise<QuoteResult>;
  buildMigrate(pool: string): Promise<UnsignedTx>;
  buildClaimFees(req: ClaimRequest): Promise<UnsignedTx>;
  decodeEvents(tx: ConfirmedTx): EngineEvent[];
}
```
Engine-specific SDK types MUST NOT cross the adapter boundary.

## 4. Non-functional (proposed targets, not product-owner decisions)
- Validator p95 < 5 s for registry assets (cached on-chain reads ≤ 60 s old for Stage 3; Stage 1 always re-read at finalized before execution).
- Indexer lag p95 < 5 s from finalized slot.
- All policies versioned; all decisions reproducible.
- Availability target for Studio 99.5% (V1).

## 5. Out of scope
See PRODUCT.md non-goals and ADR-001.
