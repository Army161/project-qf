# Bounded acceptance checklist

## SEC-A adoption
- [ ] Owner explicitly adopts the scoped technical dispositions; do not fabricate a signature/time.
- [ ] Exact versions, integrities, patch hash and reviewed lockfile recorded.
- [ ] bigint native path eliminated in the actual runtime artifact; width-specific integer checks preserved.
- [ ] Anchor toml4.2 compatibility, recursion and prototype regressions pass.
- [ ] uuid and stream-json call-path assumptions verified after dependency changes.
- [ ] Raw audit retained; no force-fix/global suppression.
- [ ] Review-by 2026-12-27 retained; earlier change triggers enforced.

## Optional natives
- [ ] Targeted optional exclusion only; no blanket optional-dependency removal.
- [ ] Clean install and both ws-version fallback tests.
- [ ] bufferutil and utf-8-validate absent from deployed application artifacts/runtime loads.
- [ ] Refresh lockfile, SBOM, licence, boundary and SEC-A evidence.

## Config
- [ ] Authority equality source-confirmed and PDA derived independently.
- [ ] Customizable mode requires Dynamic config type1.
- [ ] Full layout/owner/cluster and route-specific semantics checked.
- [ ] Unknown enum and static-on-dynamic-route fail.
- [ ] Mode not implemented is explicit, not silently accepted.
- [ ] Live observations remain UNKNOWN until obtained.

## Resource bounds
- [ ] Byte cap enforced during streaming before complete buffering.
- [ ] Missing/false headers cannot bypass cap.
- [ ] Body-timeout and abort/cancel cleanup tested.
- [ ] Compressed and decompressed account bytes bounded separately.
- [ ] Per-operation sizes accommodate legitimate program records.

## Read-only stage
- [ ] Owner-controlled authorized network selected.
- [ ] Three read-only RPC methods only; status GETs only.
- [ ] No wallet/keys/airdrop/simulation/attestation/transactions.
- [ ] Genesis and finalized context recorded; inventory complete.
- [ ] Second-provider disagreement differs from unavailability.
- [ ] Source/deployment/audit statuses reported separately.
- [ ] Network failure cannot become success.

## Commercial and local eligibility
- [ ] U.S. eligibility and applicable integration terms clarified.
- [ ] Local copying/building/caching/distribution permission independently addressed.
- [ ] Inquiry transmission authorized separately; no proprietary attachments.
- [ ] Existing localnet/devnet/mainnet gates preserved.

## Return artifact
- [ ] Updated workspace ZIP includes reports, scripts, evidence, manifest and checksums.
- [ ] Actual regression reproductions, not only descriptions, included.
- [ ] Full tests/typecheck/boundary/licence/SBOM/chain proofs rerun and actual exits retained.
- [ ] Failed hypotheses and skipped/not-run layers remain visible.
