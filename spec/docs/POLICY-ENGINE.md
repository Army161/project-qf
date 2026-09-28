# POLICY-ENGINE

The Policy Engine is the only component that turns a proposal into an executable `LaunchPlan`. It is deterministic, versioned, and has no AI inside it.

## 1. Inputs → output
```
LaunchProposal (AI or user) + ValidationResult + EconomicsPolicy + CurveTemplate + EngineConstraints + MigrationPolicy
      → LaunchPlan { policyDecision: ACCEPT|REJECT, reasons[], clamped[], resolvedConfigKey, engineParams, versions{} }
```

## 2. Rule order
1. Validation gate: quote validation must be PASS or acknowledged WARN, not older than policy max age, same policy version.
2. Capability gate: any requested capability flag not enabled → REJECT (e.g., `DBC_BASE_TRANSFER_FEE`).
3. Schema: proposal validates against JSON Schema; unknown fields → REJECT.
4. Engine constraints (hard, from PROTOCOL.md §4): base decimals 6–9; base fee 25–9900 bps; migrated pool fee 10–1000 bps; locked LP ≥ 10% at day 1; lock ≤ 2 y; ≤ 16 curve points; migration option = DAMM v2.
5. Template bounds: values outside `CurveTemplate`/`EconomicsPolicy` ranges are **clamped only if the policy marks the field clampable**, otherwise REJECT. Every clamp is reported.
6. Migration threshold: `MigrationPolicy` asset-relative bounds (ECONOMICS.md §4). AI may recommend inside bounds; Policy decides.
7. Liquidity policy: claimable creator LP must be 0 (`creator_liquidity_percentage = 0`) unless a future template allows it.
8. Compliance hooks (COMPLIANCE.md) → REJECT with reason.
9. Config resolution via ConfigRegistry.

## 3. Versioned policy objects
`ValidatorPolicy` (QUOTE-ASSETS.md §7), `EconomicsPolicy` and `CurveTemplate` (ECONOMICS.md), `MigrationPolicy`, `ExclusionPolicy` and `AllocationPolicy` (REWARDS.md), `DataLicensePolicy` (DATA-LICENSES.md). Stored in Postgres with `id`, `version`, `content_hash`, `approved_by[2]`, `effective_from`. Every decision record stores the ids + hashes it used.

## 4. Change control
Policy change = new version + two approvals + backtest/simulation report attached. Policies are never edited in place. AI agents cannot write policies.
