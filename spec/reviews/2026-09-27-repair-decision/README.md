# Project QF — Repair review decisions
Review date: 2026-09-27. Scope: uploaded repair archive, targeted offline checks, primary-source research.

This is a supplemental technical review and handoff, not a replacement QF workspace, external audit, production approval, or legal opinion. No original QF source was modified for delivery, no upstream program source was copied into QF, no chain transaction was sent, and no inquiry was sent.

## Start here
Read DECISIONS.md, CONFIG-COMPATIBILITY.md, NETWORK-RUNBOOK.md and CLAUDE-NEXT-PASS.md. The ready-to-send but unsent external inquiry is METEORA-INQUIRY.md. Primary references are in SOURCES.md.

The actual diagnostic tool and its recorded output are included:
- tools/reproduce-review-observations.mjs
- evidence/targeted-observations.json
- evidence/targeted-observations-run.txt
- tools/derive-pool-authority.py
- evidence/pda-derivation-rerun.json

VERIFICATION-CHECKLIST.md is included. MANIFEST.json and SHA256SUMS enumerate this package, not the original workspace.

## Evidence boundaries
- All 241 content files in the uploaded archive's checksum manifest match; this is consistency evidence, not proof of authorship/security.
- 56 existing core and validator tests independently reran with zero failures/skips on Node 22.16.0. See evidence/core-validator-rerun.tap.
- The full 175 project tests, 38 verifier tests, typecheck, installed dependency checks and browser build were not independently rerun here; their results are reported in the uploaded archive.
- Four diagnostic observations reproduce two remaining issues using synthetic inputs against extracted original functions. Their positive reproduction exit code is NOT a safety pass.
- RPC and npm requests failed DNS resolution here. Nothing about live deployments, upgrade authorities, config accounts, or build parity was verified.
- Source-pinned behavior and offline PDA derivation do not identify the deployed version.

## Reproduce observations
Use a disposable environment and the Node runtime supporting --experimental-strip-types. The extracted upload root must contain project-qf/ and spec/.

```sh
node --experimental-strip-types tools/reproduce-review-observations.mjs /absolute/path/to/quoteforge-v0-repair-2026-09-27
python tools/derive-pool-authority.py
```

The observation tool performs no network request and no blockchain operation. It reads original functions from your uploaded workspace and evaluates them with synthetic data; it is not the full verifier or SDK test suite. It does not change the production files.
