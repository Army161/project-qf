# Project QF — adopt decisions; finish read-only readiness

Read DECISIONS.md, CONFIG-COMPATIBILITY.md, NETWORK-RUNBOOK.md and VERIFICATION-CHECKLIST.md from this package alongside the existing workspace. This is a bounded patch and evidence pass, not another architecture/spec cycle.

## Review scope
The reviewer checked all 241 manifested content hashes and independently ran 56 existing core/validator tests. The full175/38 suites and installed SEC-A runtime tests were not independently rerun. Four included diagnostic observations reproduce two remaining issues; they are not security passes. No live state was obtained. Never describe this as an external audit.

## Decision adoption
Technical recommendation is ACCEPT all five exact SEC-A dispositions for the internal Node V0 adapter: bigint MITIGATED_PATCHED; both toml FIXED_BY_SCOPED_OVERRIDE; uuid and stream-json NOT_AFFECTED_PATH_SPECIFIC. Preserve advisory/integrity/call-path conditions, raw audit, expiry2026-12-27 and earlier triggers. This handoff only becomes owner adoption when the owner supplies it as their instruction; retain review attribution and do not impersonate a human signature. Refresh evidence after any lockfile change.

Remove optional bufferutil/utf-8-validate from V0 runtime artifacts using pnpm10's targeted optional-dependency exclusion after checking paths. ws7.5.13 does not use the newer WS_NO_* flags, so flags alone are insufficient. Clean-install without scripts, test fallbacks for all installed ws versions, refresh SBOM/licence/boundary/security records. Do not broadly ban all native tooling or remove every optional dependency.

## Only two bounded repairs
1. Config: retain creator-authority equality with FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM. It is confirmed by pinned DBC source and offline PDA derivation, not live chain state. For the selected Customizable migration route require Dynamic config_type1 in addition to owner/layout/cluster and relevant semantics. Keep fixed routes separately assessed; do not treat generic DAMM public config support as a reason to weaken DBC's rule. No noncommercial program source is to be copied into QF; use the MIT SDK layout/IDL.
2. Input bounds: repair createBoundedFetch to count decoded stream bytes before aggregation and cancel/abort immediately on overflow, with whole-body deadline and error cleanup. Inspect verifier res.text/inflate paths too, with separate encoded/decompressed and per-operation limits. Preserve legitimate program-account reads. Reproduce the included test first, then turn observations into secure regression expectations.

Run tools/reproduce-review-observations.mjs against the untouched repaired upload to reproduce before patching. The tool exits0 when the old deficiency reproduces; do not treat that as secure behavior. Its positive type1 fixture is only a type-check control, not a real valid account.

## Network/run status
Recommend owner-controlled local computer/network with public api.mainnet.solana.com, api.devnet.solana.com and verify.osec.io. Package installation uses separately allowed registry.npmjs.org. No proxy/TLS/geographical bypass or paid-provider purchase. Preserve existing CLI four flags. Only read-only RPC methods/status GETs; no keygen/wallet/transactions/airdrop/attestation/simulation.

Permit collection of incomplete facts once owner-network authority is provided; do not create a circular gate requiring live confirmation before the read can run. Passing verification still requires complete valid checks. If blocked, save sanitized errors and continue offline; never report UNKNOWN as PASS. A successful read-only stage does not authorize devnet writes or mainnet.

## Inquiry and eligibility
Recommendation is SEND the prepared minimal inquiry, but it is NOT SENT by this review. Prepare it; do not transmit without explicit owner authorization through the available mail workflow. The official terms list U.S. restrictions; seek a developer/partner agreement and scope clarification for U.S. SDK/devnet/commercial use and private local copies. Do not assert that a private repository or MIT SDK overrides service/program terms. Do not attach source, ZIPs, scoring IP or credentials. Keep existing DEV-3/LOCAL-1/mainnet legal gates; no engine redesign in this pass.

## Deliver
Amend existing ADRs/code/tests, not a fresh spec set. Return red/green logs, full175/38 or updated honest counts, typecheck, exact dependency evidence, boundary/licence/SBOM/chain checks, raw audit plus dispositions, native runtime-load proof, config-type/body-limit tests, and read-only evidence or failures. Export actual tools and JSON outputs with the updated workspace, manifest and checksums. Name the concise return report RETURN-REPORT-READONLY-READINESS.md. State separately what ran, what was only inspected, what is unverified and which stage remains blocked.
