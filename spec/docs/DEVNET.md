# DEVNET — V0 Proof Plan

No mainnet write transactions. Run order: **Step 0 → localnet with cloned programs → public devnet**.

> **Amended 2026-09-27 (ADR-011, ADR-013).** Localnet program cloning (§2) is **suspended** until written permission covers local copies, source builds and CI caching (LOCAL-1). `LOCALNET_INTEGRATION` and `DEVNET_INTEGRATION` are BLOCKED; only `OFFLINE_V0` is active. Step 0 must validate the genesis hash, not the hostname.

## 1. Preconditions
- Environment with outbound access to Solana devnet (and mainnet read-only) RPC. **The environment used to write this spec had Solana RPC blocked** — V0 must run where RPC egress is allowed.
- Step 0: run `tools/program-verify` (see its README for the exact flags) and commit `docs/verification/PROGRAM-VERIFICATION-<date>.{md,json}`. Exit code 0 is required; any required FAIL/UNKNOWN or mismatch with PROTOCOL.md halts devnet work.
- Devnet test wallets are disposable, hold no real funds, are generated locally into a git-ignored directory, and their secrets never enter model context, logs or chat.

## 2. Environment setup
```
# SUSPENDED (ADR-013): do not run until LOCAL-1 permission is recorded
solana-test-validator --reset \
  --url devnet \
  --clone-upgradeable-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN \
  --clone-upgradeable-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
  --clone <DAMM v2 migration config A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck> \
  --clone <other accounts discovered in Step 0: DBC pool_authority/event authority as needed, locker program if vesting used>
```
The exact clone list is produced by Step 0 (UNVERIFIED until run). SF Rewards: deploy program built from `df7517d` to localnet/devnet under a test authority (MIT permits).

## 3. Steps and assertions
| # | Step | Assertions |
|---|---|---|
| 0 | Program verification | All programs exist+executable on target cluster; authorities and hashes recorded; DAMM v2 migration configs exist on devnet |
| 1 | Connect | Genesis hash = expected cluster; DBC and DAMM v2 executable |
| 2 | Registry | Create issuer `devnet_test`; register test quote `qUSD` (6 dp, freeze None, mint authority revoked after minting supply) and negative fixtures: T22 TransferFee 100 bps; T22 PermanentDelegate; SPL with non-allowlisted freeze authority; SPL with live mint authority; impersonator "USDC" |
| 3 | Validator | qUSD → PASS/WARN (Stage 3 `SIMULATED`); TransferFee → FAIL S1.5; PermanentDelegate → FAIL S1.4; freeze → FAIL S1.8; mint auth → FAIL S1.9; impersonator → FAIL S2.2; each result stores policy `validator-v0.1`, slot, evidence |
| 4 | Policy engine | AI-free fixture proposal ACCEPTED with V0_TEST economics; out-of-range proposal (baseFeeBps 10, field not clampable) REJECTED with reason; clampable field out of range (migration targetUsd above ceil) clamped and reported; `DBC_BASE_TRANSFER_FEE` request REJECTED |
| 5 | Config selection | ConfigRegistry: no config for key → `createConfig` signed by test multisig/keypair; on-chain decode equals submitted params byte-for-byte; status `active`; second launch reuses same config |
| 6 | createPool + first buy | `createPoolWithFirstBuy`; pool at `deriveDbcPoolAddress`; base mint authority None; metadata matches; creator base balance = quoted first-buy output |
| 7 | Buy | Output = `swapQuote` exactly; quote reserve delta = input − fees |
| 8 | Sell | Output = `swapQuote`; succeeds |
| 9 | Fees | `getPoolFeeBreakdown`: protocol + partner + creator = total within rounding; protocol = 20% (assert; flag if Meteora changed); fees in qUSD only |
| 10 | Curve completion | Quote reserve ≥ threshold; `getPoolQuoteTokenCurveProgress` = 1; further curve swap rejected; `EvtCurveComplete` indexed |
| 11 | Migration crank | Crank (no Meteora keeper on devnet) calls `migrateToDammV2`; DBC `is_migrated = 1` |
| 12 | DAMM v2 verify | Pool at `deriveDammV2PoolAddress`; mints (base, qUSD); positions for partner and creator; permanently locked liquidity equals configured percentages (on-chain position state proves lock); claimable creator LP = 0; DAMM v2 swap succeeds |
| 13 | Fee harvesting | Partner fees claimed to fee account; creator fees claimed by creator; ledger = on-chain deltas |
| 14 | Reward plan | EPOCH_PROPORTIONAL over a short test epoch; exclusions remove pool/vault/protocol accounts; two runs → identical allocation hash + root |
| 15 | Merkle root + funding | Distribution created with root; vault funded = total allocated (after any transfer fee) |
| 16 | Test settlement + claims | Two holders claim with valid proofs → exact amounts; double claim fails; invalid proof fails; artifact `claimStatus` updated |
| 17 | Indexing | DB holds config → pool → swaps → complete → migration → DAMM pool → fee claims → distribution → claims; counts = on-chain signatures; balances reconcile at final slot with 0 discrepancy |
| 18 | UI lifecycle | Playwright: each stage rendered with signature links; validator panel shows per-check results; decoded preview present before signing; no keys in browser storage |

## 4. Exit criteria
All assertions pass on localnet-clone **and** devnet; single idempotent command; artifacts (validation records, epoch artifact, verification report) committed.
