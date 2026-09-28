# LICENSES

Project QF original code: proprietary, all rights reserved (`PROPRIETARY-NOTICE.md`). Legal conclusions below are engineering INFERENCE pending counsel.

## 1. Policy
| License family | Proprietary packages | Notes |
|---|---|---|
| MIT, ISC, BSD-2/3, Apache-2.0, 0BSD, CC0 | Allowed | Preserve notices (THIRD_PARTY_NOTICES.md); Apache NOTICE files |
| MPL-2.0 | Review | File-level copyleft |
| LGPL / GPL / AGPL | **Denied** | Includes `@raydium-io/raydium-sdk-v2` (GPL-3.0). Sole exception: QF-LIC-EX-001 (§5) |
| BUSL / SSPL / Elastic / "non-commercial" / source-available | **Denied** | Includes Meteora program sources, Uniswap v4-core, Ondo GM |
| No license | Denied | e.g., PONS repo lacks a root LICENSE file |

## 2. Findings (retrieved 2026-09-26)
| Component | Version / commit | License | V1 use |
|---|---|---|---|
| Meteora DBC program | `f552f20` (0.2.1) | Meteora Non-commercial Licence | Interact with deployed program only; never copy |
| Meteora DAMM v2 program | `a85c926` (0.2.4) | Meteora Noncommercial Licence | Same |
| `@meteora-ag/dynamic-bonding-curve-sdk` | 1.5.13 | MIT | Yes (adapter only) |
| `@meteora-ag/cp-amm-sdk` | 1.4.10 | MIT | Yes (adapter only) |
| Meteora Invent | `dd77ef3` | MIT (root); fun-launch scaffold package.json ISC | Reference only |
| Solana Foundation Rewards | `df7517d` | MIT | Devnet settlement candidate; mainnet gated |
| Token-2022 program / `@solana-program/token-2022` | `23b03f8` / 0.19.0 | Apache-2.0 | Yes |
| `@solana-program/token` | 0.17.0 | Apache-2.0 | Yes |
| `@solana/spl-token` | 0.4.15 | Apache-2.0 | Transitive via Meteora SDK |
| `@solana/web3.js` | 1.99.0 | MIT | Adapter only (the verifier moved to `@solana/addresses`, 2026-09-27) |
| `@solana/kit` | 8.3.0 | MIT | Optional outside adapter |
| `@coral-xyz/anchor` | 0.32.1 latest; Meteora SDK requires ^0.31 | MIT OR Apache-2.0 | Transitive |
| `@pythnetwork/hermes-client` | 3.1.0 | Apache-2.0 | Yes |
| `@pythnetwork/pyth-solana-receiver` | 0.16.0 | Apache-2.0 | Optional |
| `@jup-ag/api` | 6.0.48 | MIT (client); API use under Jupiter SDK & API License Agreement | Gated (ADR-005) |
| `@raydium-io/raydium-sdk-v2` | 0.2.73-alpha | GPL-3.0 | **Not used** |
| Raydium CPMM/CLMM programs | `59fb845` / `ed7c84a` | Apache-2.0 (Raydium docs) | V2 research |
| Raydium LaunchLab | not found publicly | UNKNOWN | Not V1 |
| PONS (`ponsdotdev/pons-labs`) | `162310f` | README badge MIT, no LICENSE file; vendors BUSL-1.1 + GPL-2.0 files | Research only |
| Uniswap v4-core | 1.0.2 / `46c6834` | BUSL-1.1 → MIT at earlier of 2027-06-15 or ENS date | Not V1 |
| Uniswap v4-periphery | 1.0.3 | MIT | Not V1 |
| Uniswap v3-core / v2-core | 1.0.1 / 1.0.1 | BUSL-1.1 (npm metadata; reported converted) / GPL-3.0-or-later | Not V1 |
| OpenZeppelin contracts | 5.6.1 | MIT | Not V1 |
| Ondo GM Solana | `d1d011e` | BUSL-1.1, no additional use grant | Reference only |

## 3. Transitive findings (FACT — `npm install` of the pinned set, 2026-09-26)
Tally: MIT 156, Apache-2.0 17, BSD-3 3, (MIT OR Apache-2.0) 1, BSD-2 1, ISC 1, 0BSD 1, CC0 1, (MIT AND Zlib) 1, **LGPL-3.0-only 1**, no license field 2.

| Package | License | Pulled by | Disposition |
|---|---|---|---|
| `rpc-websockets@9.3.9` | **LGPL-3.0-only** | `@solana/web3.js@1.99.0` (required by both Meteora SDKs) | **APPROVED_NARROW as QF-LIC-EX-001 (2026-09-27, Decision 1)**; see §5 |
| `chain@0.4.2` | none | `@meteora-ag/cp-amm-sdk@1.4.10` declares `"chain": "^0.4.0"` as a runtime dependency | Unrelated turborepo-template package by non-Meteora maintainers; not imported by the SDK's dist. **REMOVED (2026-09-27, Decision 4, QF-DEP-RM-001)** with the targeted override `"@meteora-ag/cp-amm-sdk@1.4.10>chain": "-"`; not stubbed, not pinned. Absence proven in graph, lockfile, SBOM and runtime (§6). Report upstream remains open |
| `text-encoding-utf-8@1.0.2` | Unlicense (in LICENSE.md) | `borsh@0.7.0` | Allowed |

## 4. Data licenses
See DATA-LICENSES.md (separate from code licenses).

## 5. Exception QF-LIC-EX-001 — `rpc-websockets@9.3.9` (amended 2026-09-27, Decision 1)

Recorded in `LICENSE-MANIFEST.json` → `exceptions[QF-LIC-EX-001]`. This is a narrow policy exception, not legal advice.

| Field | Value |
|---|---|
| Package | `rpc-websockets@9.3.9`, LGPL-3.0-only, unmodified |
| Integrity | `sha512-2iQDaTB4g5fDB2ihrTFSJSibCEuxaRi1q7qTW7ZO9/M5/TC+ToHA4D9/ffNLEbAoHNNrcdeP05oATNk44SKZXA==` (from `project-qf/pnpm-lock.yaml`) |
| Dependency path | `@project-qf/adapter-meteora-dbc` → `@solana/web3.js@1.99.0` → `rpc-websockets@9.3.9` (only path; checked by `tools/license-check`) |
| Permitted | internal server-side execution of the Meteora adapter operated by Project QF |
| Not permitted | browser bundles (including workers and public source maps), downloadable SDKs/CLIs, mobile/desktop apps, customer Docker images, on-prem installs, redistributable dev bundles, any modification |
| Conditions | keep upstream copyright, licence text and source identification (THIRD_PARTY_NOTICES.md); no proprietary label over its source; third-party hosting and contractors are assessed on their actual arrangement |
| Owner / reviewer | Project QF product owner; counsel review optional and recommended before any distribution |
| Review triggers | version change; any new dependency path; any distribution or modification; new deployment target; 2027-09-27 at latest |
| Enforcement | `pnpm license:check` fails if the package appears on any other path or version, or if any other LGPL package appears; `pnpm boundary` fails if `@solana/web3.js`, `rpc-websockets` or the adapter appear in the `apps/web` graph, bundles, worker bundles or source maps. No scan suppression (`scanSuppression: NONE`). |

Other LGPL packages remain denied. No dependency is upgraded merely to find a more favourable licence.

## 6. Current resolved licence results (2026-09-27, `project-qf/evidence/license-check.json`)
164 lockfile packages: ALLOW 137, ALLOW_EXCEPTION 1 (`rpc-websockets`), REVIEW 1 (`pako@2.2.0`, `(MIT AND Zlib)`, via `@coral-xyz/anchor`; Zlib is permissive but not yet on the allowlist, owner review needed) [superseded 2026-09-27 repair pass: ALLOW_EXCEPTION 2, REVIEW 0; see §7], NOT_INSTALLED 25 (esbuild platform binaries for other OSes). `chain` does not appear. The verifier's separate lockfile resolves 9 packages, all MIT (`project-qf/evidence/rpc-attempt/verifier-licenses.json`).

## 7. Amendment 2026-09-27 — repair pass: LIC-R1 `pako@2.2.0` (QF-LIC-EX-002)
- **Decision.** The owner allowed exact `pako@2.2.0` under `(MIT AND Zlib)`, preserving both licences' obligations and upstream notices. Not a policy-wide change: Zlib stays REVIEW for any other package.
- **Obligations.** MIT: keep the copyright and permission notice with all copies or substantial portions. Zlib: do not misrepresent the origin; mark altered source plainly; do not remove or alter the notice in any source distribution. QF uses pako unmodified.
- **Enforcement.** `tools/license-check` status `APPROVED_EXACT`: licence expression, lockfile integrity `sha512-zJq6RP/5…81dz/w==`, not patched, and `LICENSE` and `lib/zlib/README` byte-identical to the preserved copies in `project-qf/licenses/pako@2.2.0/`.
- **Result.** 164 packages: ALLOW 137, ALLOW_EXCEPTION 2 (`rpc-websockets`, `pako`), REVIEW 0, NOT_INSTALLED 25, failures 0.

### 7.1 Update 2026-09-27 (decision review)
After removing the optional ws natives: 161 packages, ALLOW 134, ALLOW_EXCEPTION 2 (`rpc-websockets`, `pako`), REVIEW 0, NOT_INSTALLED 25, failures 0.
