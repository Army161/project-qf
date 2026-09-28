# Project QF — V0 verification checklist

Version: review-2026-09-27. This checklist is included in this ZIP. It does not authorize signing, transactions, public deployment, or restricted program copies.

## A. Package and runtime
- [ ] Verify archive manifest/hashes and record original archive identity. Check traversal/symlinks before extraction.
- [ ] Pin and report the tested Node/pnpm versions. Native TS execution and proxy flags must work on that documented runtime.
- [ ] Start dependency work in an isolated, secret-free environment with lifecycle scripts disabled.
- [ ] Frozen lockfile install. Inspect exact artifact integrity, transitive licenses, and conditional/browser exports.
- [ ] Preserve original proprietary code and required upstream notices; allow pako `(MIT AND Zlib)` only with both obligations satisfied.
- [ ] Keep narrow LGPL exception; no restricted SDK path in browser, workers, source maps, downloaded SDKs or customer artifacts.
- [ ] Prove chain absent from all resolved paths, installed tree, runtime and SBOM; retain the control without override.
- [ ] Add a version-bound SEC-A disposition for all five advisories. Do not hide raw audit failures.

## B. Transaction and input safety: offline first
- [ ] Existing tests remain passing; new negative cases fail before repair and pass after it.
- [ ] Decode each permitted pinned engine instruction; validate operation kind, arguments and expected account/authority relationships.
- [ ] Bind every System/Token/ATA/ComputeBudget instruction to legitimate approved rent, wrap/unwrap, transfer and budget flows.
- [ ] Extra transfers, substituted mint/destination/fee recipient, unexpected authority change, excessive amounts/compute prices, and wrong operation are rejected.
- [ ] Test serialized message mutations, not only manually constructed decoded objects.
- [ ] Account for required ephemeral mint signers without permitting arbitrary additional authority.
- [ ] Exact message/economics/cluster/evidence/policy are bound to consent. A refreshed blockhash is not permission to change terms.
- [ ] No unsupported ALT path silently accepted; no wallet added until its browser dependency boundary is tested.
- [ ] Required exit list and mandatory check inventory are nonempty and policy-derived; enums, addresses, decimals, notionals and evidence are runtime-validated.
- [ ] Empty evidence or an externally asserted issuer status cannot promote an asset to production.
- [ ] All applicable WARNs require explicit current acknowledgement.
- [ ] New adverse data invalidates prior approval even within its TTL. Production execution quote age is separate from V0 analytical freshness.
- [ ] TEST_ONLY synthetic data and migration-supply20 fixture cannot activate a live route or production registry.

## C. Verifier correctness before network access
- [ ] Preserve/document four existing flags: --mainnet, --mainnet2, --devnet, --out. Unknown flags fail clearly.
- [ ] Validate expected cluster/program/config inventory independently from returned data; missing/duplicate checks cannot yield success.
- [ ] Config fixtures contain full decoded fields. Discriminator-only and incompatible configs fail.
- [ ] Validate program/loader/ProgramData full layouts and option tags. Invalid authority encoding cannot mean immutable.
- [ ] URL credentials in userinfo, path, query, fragments and nested errors are redacted. Use synthetic canaries only.
- [ ] Separate provider unreachable from actual state disagreement. A contradictory second-provider observation cannot silently pass.
- [ ] Preserve commitment, RPC context slots, deploy slot, source and time in results.
- [ ] Emit per-check status for recoverable errors; no partial success inferred from omitted records.
- [ ] Read-only RPC method restriction remains; no wallet/keys, transaction simulation/submission, or verification attestation.

## D. Live read-only evidence
Only in an owner-authorized environment. No disabling TLS or bypassing network controls.

- [ ] RPC connectivity and actual genesis match each intended cluster; label endpoint by provider, not credentials.
- [ ] DBC and DAMM program accounts exist, executable flag and loader match, and ProgramData points to valid state.
- [ ] Record authority address/null and deploy slot. Separately establish organizational authority ownership if required; a key alone proves no identity.
- [ ] Record executable hashes with exact hashing method. Do not infer a source version from a hash alone.
- [ ] Verify full required devnet migration configs, fields, owner and compatibility with the pinned SDK/template.
- [ ] Verify required event/account/instruction interface parity separately from executable presence.
- [ ] Cross-provider contradictions are resolved against consistent finalized state, not waived as optional.
- [ ] Record Rewards candidate separately; its optional unverified status must not claim rewards readiness.
- [ ] Source-to-binary match and applicable audit scope are separate statuses, never implied by exit0 or a hash.
- [ ] Produce complete JSON+Markdown with schema/version, checked inventory, slots/times, source provenance and unresolved items.

After repairs, existing public-endpoint invocation (relative to extracted archive root):

```sh
cd spec/tools/program-verify
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
node verify-programs.mjs --mainnet https://api.mainnet.solana.com --devnet https://api.devnet.solana.com --out ./verification-results
```

Use the exact validated runtime from the project. Public RPC may be rate-limited; hostname is not cluster identity. Use --mainnet2 only with a correctly secured independent endpoint. Do not put secret-bearing endpoint URLs into ordinary command history or logs. If a protected secret-input mechanism is needed, design it explicitly rather than inventing undocumented flags.

## E. Promotion
- [ ] No single PASS or exit0 promotes all stages. OFFLINE, READ_ONLY_VERIFICATION, LOCALNET, DEVNET and MAINNET evidence remain distinct.
- [ ] LOCAL-1 licensing permission is resolved before restricted source/binary copies/builds/cache operations; LOCAL-2/3 proven separately.
- [ ] DEV-1 complete inventory, DEV-2 cluster and key safeguards, DEV-3 terms, SEC-A dispositions, and semantic/policy regressions all resolved before live devnet integration.
- [ ] Before any future devnet write, separate explicit authorization and test-only key handling outside model context. This review is not write authorization.
- [ ] Mainnet gates remain closed; no production economics, custody model, program audit or legal permission inferred from V0.
