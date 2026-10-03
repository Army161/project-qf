# Project QF — alignment brief, 2026-10-03

## Conclusion
Claude is ahead on the newest implementation checkpoint. Astra has now reconciled that checkpoint and supplies the missing checkable source references. The architecture does not need reopening. Shift reviews to integrated milestones, while preserving event-driven review for genuine security, licence, signing, or authority changes.

This is a reconciliation addendum, not a new specification or an external security audit. It makes recommendations and records evidence; it does not create a repository, send email, change network settings, approve external contracts, or authorize chain writes.

## Source precedence for status
1. BACK-BRIEF-2026-10-03.md: latest narrative, reports no implementation change since September 28.
2. PROJECT-QF-STATUS-REPORT-2026-09-28.md and HANDOFF-TO-ASTRA-2026-09-28.md: product assessment, outstanding asks, and claimed local-git history.
3. The supplied latest code snapshot: quoteforge-v0-readonly-readiness-2026-09-27.zip, with spec/RETURN-REPORT-READONLY-READINESS.md. This is the latest runnable source supplied here, not proof of unsupplied later local commits.
4. RETURN-REPORT-V0-REPAIR.md and older reports: historical checkpoints, not current test totals.
For implementation decisions, preserve the existing accepted ADR -> SPEC -> other docs precedence. Report dates do not silently override accepted policies.

## Independently established in this review
- ZIP SHA256: 6b147099f82fc1e5e5afa6b8d6d6102989f60d2ff1d580746a1deb119132166e, matching the handoff.
- 317 manifested content files all match; 319 physical files include MANIFEST.json and SHA256SUMS.
- Current lockfile SHA256: c2bb276af21b15c87bba002d20b51e7f9564cde2247d082370bec4d27f3a90e6.
- Compared with the preceding repair ZIP, the package-resolution diff removes only bufferutil@4.1.0, utf-8-validate@6.0.6 and node-gyp-build@4.8.4. The other 161 shared package resolutions are unchanged; no package was added.
- Core and validator subset: 56 tests passed after restoring the local @project-qf/core workspace link, without downloading dependencies. Runtime was Node 22.16.0 with explicit experimental type stripping, not the project's reported 22.22.2 environment. Preserve both the initial missing-workspace-link failure log and the successful rerun.
- No .git directory or .bundle exists in the uploaded September 27 ZIP. The September 28 local repository and four commits are reported, not independently verified. Request/export the later bundle or inspect/push the existing history; do not recreate the project.
- The current GitHub connection returned 404 for Army161/project-qf. This means not visible through that connection, not conclusive nonexistence.

## Reported, not independently rerun
- Full clean-environment totals: 185 project tests and 55 verifier tests.
- Full typecheck, installed dependency checks, browser boundary and UI browser test.
- No successful live-chain observations; previous verifier attempts failed at connectivity.
- Meteora inquiry unsent; no public/private remote repository in the author's view.

## Alignment corrections
- The older 175/38 totals are superseded; do not restart those repairs.
- The verifier has been attempted; it has not successfully verified the live chain. 'Never run' is an imprecise shorthand.
- A labelled mock walkthrough exists; a connected creator application does not.
- Approximately 20% completion is Claude's subjective weighted estimate, not an audited measure, pass probability, or release schedule.
- No GitHub remote blocks the intended hosted PR/CI workflow and easy shared backup, not all local application development or worktree-based parallel work.
- QF-original private UI, API, storage, schemas and synthetic-data score tests can progress. Live ingestion still depends on allowed network access, provider terms, data permissions and explicit missing-data behavior. 'Nothing legal blocks live data' is too categorical.
- Keep rewards, automatic graduation, higher retention and safety language as planned capabilities or measurable hypotheses. Migration still needs its crank/keeper path. A validator PASS is not an investment-safety guarantee.
- The approved code rejects or reprices material out-of-policy economics and binds renewed consent. Do not introduce silent parameter changes because a narrative report used 'clamp'.

## Release tracking update
The upstream default SDK manifest read on October 3 identifies 1.5.13. Direct npm dist-tag freshness was not independently established in this runtime. PR #116 is open and proposes program 0.2.2 support in SDK 1.6.0, including transfer fees; #117 is the separate 2.0 refactor. #114 is shown closed by #116's current cross-reference. Therefore keep the present pin/disabled capability, but track released capability and deployed behavior rather than hard-coding 'major version 2 is necessary'. See PINNED-SOURCE-EVIDENCE.md.

## Recommended next milestone
A private read-only Quote Asset Inspector + Creator Draft: enter mint, retrieve permitted/provenanced evidence when reachable, display validator checks, save a draft/report, reload it, and show measured feature components with explicit unknowns. No wallet, signing, launch, custody or rewards payout. See MILESTONE-ACCEPTANCE.md.

The source-evidence and bigint-buffer requests to Astra are answered in the companion files. The exact owner actions still outstanding are: network authorization/configuration, remote repo creation/access where needed, inquiry send authorization, and SEC-A carryover adoption for the full lockfile above. The $100 credit provider is unknown and should not hold up this milestone.
