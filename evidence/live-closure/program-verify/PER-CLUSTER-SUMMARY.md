# Program verification per cluster (2026-10-03, read-only)

Generated from PROGRAM-VERIFICATION-2026-10-03.json (this run) and compared with the 10:05Z run in evidence/full-rerun/program-verify/. Status values are the verifier’s own; nothing is upgraded here.

## mainnet-beta (https://api.mainnet.solana.com, LIVE_RPC, commitment finalized, cross-check requested: false)

| Subject | Presence / loader / ProgramData | Upgrade authority | Deploy slot | Executable sha256 | Same as 10:05Z? | Source/build | Audit |
|---|---|---|---|---|---|---|---|
| dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN | PASS / PASS / PASS | RECORDED "JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd" | "445503633" | b3f7b765e1b9a2e8… | yes (hash and deploy slot) | NOT_ATTEMPTED | NOT_EVALUATED |
| cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG | PASS / PASS / PASS | RECORDED "JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd" | "445230614" | 7c479dd7de729ada… | yes (hash and deploy slot) | NOT_ATTEMPTED | NOT_EVALUATED |
| REWArDioXgQJ2fZKkfu9LCLjQfRwYWVVfsvcsR5hoXi | PASS / PASS / PASS | RECORDED "DXtFpbPjcn2hxPnw79x1Pfoj35vXh5AsWBkS37YnXMVv" | "422571636" | 96a2835c4d2c0065… | yes (hash and deploy slot) | NOT_ATTEMPTED | NOT_EVALUATED |

| Config route | CONFIG | CONFIG_COMPATIBILITY |
|---|---|---|
| FixedBps25 | PASS | NOT_ASSESSED |
| FixedBps30 | PASS | NOT_ASSESSED |
| FixedBps100 | PASS | NOT_ASSESSED |
| FixedBps200 | PASS | NOT_ASSESSED |
| FixedBps400 | PASS | NOT_ASSESSED |
| FixedBps600 | PASS | NOT_ASSESSED |
| Customizable | PASS | PASS |

## devnet (https://api.devnet.solana.com, LIVE_RPC, commitment finalized, cross-check requested: false)

| Subject | Presence / loader / ProgramData | Upgrade authority | Deploy slot | Executable sha256 | Same as 10:05Z? | Source/build | Audit |
|---|---|---|---|---|---|---|---|
| dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN | PASS / PASS / PASS | RECORDED "DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX" | "503167099" | e9599c7da9278c62… | yes (hash and deploy slot) | NOT_ATTEMPTED | NOT_EVALUATED |
| cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG | PASS / PASS / PASS | RECORDED "DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX" | "503166267" | f838b2ae3ed23721… | yes (hash and deploy slot) | NOT_ATTEMPTED | NOT_EVALUATED |
| REWArDioXgQJ2fZKkfu9LCLjQfRwYWVVfsvcsR5hoXi | PASS / PASS / PASS | RECORDED "wB85XAcKnhQsU8BU7njytoU8AcPJuaKfkVacUyHo3Cj" | "466676095" | b243adae886d7538… | yes (hash and deploy slot) | NOT_ATTEMPTED | NOT_EVALUATED |

| Config route | CONFIG | CONFIG_COMPATIBILITY |
|---|---|---|
| FixedBps25 | PASS | NOT_ASSESSED |
| FixedBps30 | PASS | NOT_ASSESSED |
| FixedBps100 | PASS | NOT_ASSESSED |
| FixedBps200 | PASS | NOT_ASSESSED |
| FixedBps400 | PASS | NOT_ASSESSED |
| FixedBps600 | PASS | NOT_ASSESSED |
| Customizable | PASS | PASS |

Summary: {"requiredFailures":[],"overall":"REQUIRED_CHECKS_SATISFIED","inventory":{"expected":86,"required":28,"missing":0,"duplicate":0,"unexpected":0},"notes":["SOURCE_BUILD is NOT_ATTEMPTED and AUDIT_COVERAGE is NOT_EVALUATED in every run; neither is implied by any PASS.","Exit 0 means only that the expected read-only inventory was complete and satisfied; it is not a readiness decision for any stage."]}; exit 0.

Source/build provenance stays UNKNOWN on both clusters: NOT_ATTEMPTED means no reproducible source-to-deployment comparison exists in QF evidence. OtterSec is_verified=false is recorded by the verifier and is not a mismatch. No upstream or independent source-linked artifact was obtained (see the closure report). Mainnet evidence says nothing about devnet bytes and vice versa.
