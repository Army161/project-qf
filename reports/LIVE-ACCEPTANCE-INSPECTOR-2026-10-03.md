# Live acceptance: Quote Asset Inspector + Saved Creator Draft

Date: 2026-10-03 (run 09:20–09:30 UTC). Author: Claude (implementer). Reviewer: Astra. Owner: Jeremy Gephart.
Builds on: `reports/RETURN-REPORT-MILESTONE-INSPECTOR.md` (branch `milestone/inspector-draft` @ `829a2af`). This file can be pasted as is. The ZIP that carries it also holds the raw evidence, `MANIFEST.json` and `SHA256SUMS`.

## 1. Result in one paragraph
The new cloud environment works for Solana. `api.mainnet.solana.com`, `api.devnet.solana.com` and `verify.osec.io` all answered with HTTP 200, and the proxy no longer refuses them. The inspector ran on the real server process and made **real, read-only, genesis-verified reads on mainnet and devnet**. It produced correct mint facts for USDC, USDT, wSOL, PYUSD (Token-2022, 8 extensions) and devnet USDC. It rejected bad input. A draft bound to a live report survived a server restart byte for byte. **Acceptance item 8 is now partially met.** It is not fully met for three reasons:
- there is only one provider per cluster, so S1.12 stays SKIP and a LIVE aggregate cannot PASS, by design;
- the public endpoints answer `getTokenLargestAccounts` with HTTP 429 every time;
- **the program verifier could not run.** The new environment does not allow the npm registry (`registry.npmjs.org` → 403 "Host not in allowlist"), so `@solana/addresses` could not be installed.

Nothing was signed, sent, simulated or written to any chain. No keys were used.

## 2. What I need from Jeremy (short)
1. **Allow the package registries in the environment.** Open Project settings → Environment → gear beside the environment → Network access (Custom). Keep the **default list of package managers** turned on, or add `registry.npmjs.org`. Without it, no session in this environment can install anything, so the verifier and the full test suite cannot run here. This affects new sessions only.
2. **Pick a second mainnet RPC provider** (unchanged from before). It needs to serve `getTokenLargestAccounts`, because the public endpoint rate-limits that method to zero.
3. **Decide the wSOL rule** (finding F1 below). Astra's input is welcome first.

## 3. Reachability (first step, before anything else)
| Host | Request | Result |
|---|---|---|
| api.mainnet.solana.com | getVersion / getGenesisHash | 200; solana-core 4.3.0; genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` (mainnet-beta) |
| api.devnet.solana.com | getVersion / getGenesisHash | 200; solana-core 4.4.0-beta.0; genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` (devnet) |
| verify.osec.io | GET /status/{program} | 200 |
| registry.npmjs.org | GET /pnpm, /typescript | **403** "Host not in allowlist" (pypi.org and npm.jsr.io also 403) |

## 4. Live inspections (real server, `node --use-env-proxy src/main.ts serve`, 127.0.0.1)
One provider per cluster: `api.mainnet.solana.com` and `api.devnet.solana.com`. Commitment is finalized. Every read had `genesisVerified: true`. Raw responses are in `evidence/live-acceptance/inspections/`.

| Case | Cluster | HTTP | Aggregate | PASS/WARN/FAIL/SKIP | Notes |
|---|---|---|---|---|---|
| USDC `EPjF…Dt1v` | mainnet | 201 | FAIL | 8/1/3/14 | SPL Token, 6 decimals, supply 8,427,643,990.280659. Mint and freeze authorities present → S1.8/S1.9 FAIL (V0 issuer allowlist is empty). S2.1 FAIL (registry admission off in V0). |
| USDT `Es9v…nwNYB` | mainnet | 201 | FAIL | 8/1/3/14 | Same pattern; mint and freeze authority `Q6Xp…Gi`. |
| wSOL `So11…112` | mainnet | 201 | FAIL | 9/1/2/14 | **S1.10 FAIL ZERO_SUPPLY**; see F1. |
| PYUSD `2b1k…4GXo` | mainnet | 201 | FAIL | 5/2/6/13 | Token-2022. Decoded: MintCloseAuthority, PermanentDelegate, TransferFeeConfig (0 bps, live config authority), ConfidentialTransferMint, ConfidentialTransferFeeConfig, TransferHook, MetadataPointer, TokenMetadata. S1.4 rejects 5 extensions; S1.5 ZERO_FEE_WITH_LIVE_CONFIG_AUTHORITY; S1.7 FAIL (badge lookup not built). The decoder works on a real, complex Token-2022 mint. |
| USDC-dev `4zMM…ncDU` | devnet | 201 | FAIL | 8/2/2/14 | Facts decoded; S2.1 is WARN on devnet, as designed. |
| Mainnet USDC address on devnet | devnet | 201 | FAIL | 1/2/1/22 | The address exists on devnet as a **System-owned** account → S1.1 FAIL `NOT_TOKEN_PROGRAM_OWNED 1111…`, every dependent check SKIP, 0/25 features. See F4. |
| Token program id as a "mint" | mainnet | 201 | FAIL | 1/1/2/22 | S1.1 FAIL `NOT_TOKEN_PROGRAM_OWNED BPFLoaderUpgradeab1e…`. |
| `not-a-mint` | — | **400** | — | — | `INVALID_MINT: not a 32-byte base58 Solana address` |
| cluster `testnet` | — | **400** | — | — | `UNSUPPORTED_CLUSTER "testnet"` |

All inspections:
- **S1.12 SKIP** with `SINGLE_PROVIDER: needs two independent providers`. The aggregate reasons list `REQUIRED_CHECK_MISSING S1.12`, so nothing can PASS. This is the intended result.
- **getTokenLargestAccounts: UNAVAILABLE `RATE_LIMITED (HTTP 429)`**, on mainnet and devnet, for every mint. I confirmed it with a direct curl: `{"code":429,"message":"Too many requests for a specific RPC call"}`. Holder-share features show UNAVAILABLE with that reason. Nothing was fabricated.
- Features measured: **7/25** (token program, decimals, supply, mint-authority present, freeze-authority present, extension count, DBC permissionless). `overallScore` is null.
- Every report is labeled `LIVE_READ` and FRESH, and carries slots and timestamps.

## 5. Drafts against live data (`evidence/live-acceptance/drafts/`)
- Draft `draft_ba13…` was saved (v1). It is bound to the live USDC inspection: report digest `005488f7…0b3e`, decision FAIL, policy refs recorded.
- **Server process stopped and restarted** on the same SQLite file:
  - the draft reloaded **byte-identical**;
  - the inspection's report digest matched.
- No token → 401. Wrong token → 401. A second user reading the owner's draft and live inspection → **404 / 404**.

## 6. Program verifier
**Not run.** It imports `@solana/addresses@8.3.0`, and the npm registry is blocked, so it cannot be installed. I did not shim it: a hand-written address/PDA library would make its output worthless as evidence. Accurate wording: *"the verifier has been attempted; it has still never successfully verified the live chain."*

In its place I captured **raw read-only probes**. These are not verifier output (`evidence/live-acceptance/raw-probes/probes.txt`):
- DBC `dbcij3…aqN` and DAMM v2 `cpamd…sGG`:
  - mainnet and devnet both show `executable: true` and owner `BPFLoaderUpgradeab1e…`;
  - ProgramData: DBC `HUfnSSiJxgspQm6C1rkqv6L3XgVtn7AESApgCQpCXCYh`, DAMM v2 `AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH`;
  - the ProgramData address is the same on both clusters.
- OtterSec `verify.osec.io/status`: **both programs `is_verified: false`** ("On chain program not verified"). DBC `on_chain_hash b3f7b765…6c44`. DAMM v2 has an empty hash.

## 7. Findings I'm flagging
- **F1 (spec gap, needs a decision): wSOL fails S1.10.** The SPL native mint `So11…112` reports supply 0 on mainnet, because wrapping does not mint. QUOTE-ASSETS S1.10 says "0 → FAIL". As a result `inspection-v0.1` rejects wSOL, which POLICY-ENGINE lists as a **required exit mint**. Proposed rule: for exactly the SPL Token native mint, S1.10 is NOT_APPLICABLE with the reason `NATIVE_MINT_SUPPLY_NOT_TRACKED`; the rule stays unchanged for every other mint. This needs a test-first patch plus a QUOTE-ASSETS amendment. I have **not** changed the rule, because it is a policy change.
- **F2: public RPC refuses getTokenLargestAccounts (429).** Holder concentration, and later S3.4, can't be measured live on public endpoints. Whichever provider is picked as the second one must support it.
- **F3: OtterSec shows neither Meteora program as verified.** Bytecode provenance has to come from our own build-and-hash path (the verifier's SOURCE_BUILD), not from OtterSec. Worth noting in PROGRAM-VERIFICATION.
- **F4 (minor UX):** an address that is a mint on mainnet can exist on devnet as a plain System account. The current message, `NOT_TOKEN_PROGRAM_OWNED 1111…`, is correct but unhelpful. Suggestion: when the owner is the System Program, add "not a mint on this network; check the network".
- **F5 (environment):** the npm registry is blocked (§2 item 1). PyPI and JSR are blocked too.

## 8. Deviations from the normal run, disclosed
- **No frozen install was possible.** I linked the workspace packages by hand (`node_modules/@project-qf/* → packages/*`), which is what pnpm's `workspace:*` links do.
- **`@noble/hashes@1.8.0` was replaced, in a scratch copy only, by a 6-line `node:crypto` SHA-256 shim** labeled `0.0.0-qf-live-run-shim`. Only `policy/economicsDigest` uses it.
  - Parity: the shim gives `ac2d675e…bbb5` for ECONOMICS_V0_TEST, the **same digest** recorded with the real package in the 2026-10-03 demo transcript.
  - The shim is not part of the code. Its three files appear only as disclosure text in `evidence/live-acceptance/shim-disclosed/`.
- **Tests:** a subset ran under this setup: core, validator, features, contracts, policy and api, **123/123 pass**. The full 230 suite, typecheck, boundary, licence, SBOM and audit were **not** rerun, because they need the installed toolchain. The code is unchanged since the last full green run at `829a2af`.
- Node here is v22.22.0; the earlier run used v22.22.2.

## 9. Acceptance items, updated
Items 1–7 and 9 are unchanged from the return report. They were re-observed live where it applies: invalid input → 400; network proven by genesis hash; explicit UNAVAILABLE reasons; drafts persist; owner scoping holds.

**Item 8: Partially met.**
- Done: real authorized mainnet and devnet reads, with evidence and the live draft round trip.
- Still open: two independent providers (S1.12), largest-accounts data, and a verifier run.

**Readiness:** READ_ONLY_VERIFICATION stays **BLOCKED** until the verifier runs cleanly. Nothing here unlocks localnet, devnet or mainnet.

## 10. Git
- New commit on `milestone/inspector-draft`: this report plus `evidence/live-acceptance/`.
- Excluded: the token and the SQLite file. The shim appears only as disclosure text.
- The bundle `git/project-qf.bundle` was refreshed (fast-forward only, no rewrite).

## 11. Notes for Astra
1. **F1:** do you agree with a native-mint-only NOT_APPLICABLE for S1.10, or do you want wSOL handled through registry admission (S2.1) instead? I'll implement it test-first once you and Jeremy choose.
2. **F2/F3:** please fold "must serve getTokenLargestAccounts" into the second-provider recommendation from DATA-PROVIDERS.md. Also confirm that OtterSec "not verified" leaves our SOURCE_BUILD path as the only provenance route.
3. **§8:** is the hashing shim with digest parity acceptable as evidence for this partial run? Or should item 8 be re-run in full once the registry is allowed? I'd prefer the full re-run, and I'll do it in the first session that has the registry.
4. Open asks 1–5 from the milestone return report §11 still stand.
