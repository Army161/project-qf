# PROGRAM-VERIFICATION-2026-09-26

Environment: spec-authoring cloud sandbox. Tool: `tools/program-verify/verify-programs.mjs` (read-only), executed 2026-09-26T21:04Z.

## 1. RPC result
| Cluster | Endpoint | Result |
|---|---|---|
| mainnet-beta | https://api.mainnet-beta.solana.com | `403 Forbidden: Host not in allowlist` (sandbox egress policy) |
| devnet | https://api.devnet.solana.com | `403 Forbidden: Host not in allowlist` |
Other public RPC hosts tried (publicnode, ankr, helius, alchemy) were also blocked. **No on-chain field in §3 of PROGRAM-VERIFICATION.md could be read.**

## 2. OtterSec verified-build status (verify.osec.io/status, fetched via web tool, mainnet index)
| Program | is_verified | on_chain_hash | Interpretation |
|---|---|---|---|
| DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | false | `b3f7b765e1b9a2e87e45c4663165974819d248f00c1beefe678af60e9dfe6c44` | Program exists on mainnet (INFERENCE from hash presence); build not verified |
| DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | false | (empty) | No hash returned; not verified; existence not established by this source |
| Rewards `REWArDioXgQJ2fZKkfu9LCLjQfRwYWVVfsvcsR5hoXi` | false | `96a2835c4d2c0065882de9845faae7287332e84f4a5f19ef9b199c8c6034d88d` | A program appears to exist at this address on mainnet (INFERENCE); owner/authority unknown; not verified |

## 3. Source-side facts checked via git (read-only)
| Item | Result |
|---|---|
| DBC `main` HEAD | `f552f20` (Release 0.2.1) — unchanged since 2026-09-09 |
| DBC `release_0.2.2` | `746806e` "Feat/transfer fee support (#212)" 2026-09-23 |
| DBC PR #211 | open (merge ref present; main not advanced) |
| DBC SDK `main` | `a28b723`, npm latest 1.5.13 |
| DBC SDK PR #114 | head `fb31af5`, package version 2.0.0, changelog date 2026-10-02, unmerged |
| DAMM v2 migration configs in SDK | single constant set (`constants.ts`), no cluster distinction |

## 4. Status
Explorer UI pages (explorer.solana.com, solscan.io) did not render account data to the fetch tool. Upgrade authorities, devnet presence, and bytecode parity remain **UNVERIFIED**. Re-run the tool with RPC egress before V0 Step 1.
