# Review scope and limitations

Date: 2026-10-03.

Read in full: the supplied current back brief, September28 handoff/status, pasted handoff note, supplied historical repair narratives, and the latest RETURN-REPORT-READONLY-READINESS.md extracted from the latest ZIP. Inspected both supplied architecture/mock-app images. Read the relevant spec/ADR, lockfile, disposition/evidence and targeted implementation material needed for this alignment. This is not a claim to have audited every line of all 317 archive files, all generated dependency artifacts or all original source.

Verified all manifested archive checksums, the archive hash, exact lockfile hash and dependency-resolution delta. No git bundle or .git history is in the supplied ZIP.

Test attempt 1: node --experimental-strip-types --test packages/core/test/*.test.ts packages/validator/test/*.test.ts. Node22.16.0, no dependencies installed. Nine core tests passed; five validator test files could not load because the @project-qf/core workspace link was missing. This was an environment/setup failure, not a reproduced assertion bug.

Test attempt 2: created only node_modules/@project-qf/core -> ../../packages/core in the disposable extracted copy, then reran the same command. 56 tests passed, no failures/skips. No source code or lockfile changed, no package downloaded, no lifecycle script executed. This is not a frozen-lockfile clean-environment reproduction of the full185/55 suites or of the reported Node22.22.2 runtime.

The two actual test logs are retained under evidence/. Archive verification/lockfile results are in evidence/ARCHIVE-AND-LOCKFILE-CHECK.json. Full-suite, browser, licence and installed-dependency outcomes remain Claude-reported evidence, not independently rerun here.

GitHub read-only get_repo for Army161/project-qf returned404. This does not distinguish absence from permission restriction. No repository was created or changed. No email was sent and no network setting changed. No wallet/signing or on-chain verification was performed in this review.

External research was limited to current SDK release tracking, exact previously requested source constraints, a dependency replacement path, network configuration documentation, and the existing eligibility issue. Direct npm dist-tag refresh was unavailable; do not call the repository version proof of the registry's latest dist-tag.

Primary general references:
- Claude cloud environment controls: https://code.claude.com/docs/en/cloud-environments
- Meteora terms (U.S. restriction and separate agreement language): https://docs.meteora.ag/resources/legal/terms-of-service
- File/line-level engine references: PINNED-SOURCE-EVIDENCE.md.
