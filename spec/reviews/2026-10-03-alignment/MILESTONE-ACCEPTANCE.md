# Next milestone proposal: private read-only inspector + creator draft

This narrows already approved product capabilities. It is not mainnet approval and does not add an engine, chain, custody or trading feature.

## User-visible outcome
Enter a quote-mint address -> see provenance, network and as-of evidence -> view the existing deterministic checks -> save a proposed creator draft/report -> reload it -> see measured feature components with coverage/confidence.

All wallet/signing, launch, migration, fee-harvesting and reward-settlement actions remain absent or unavailable. Do not advertise a launched token.

## Work lanes
- Product UI: replace the fixture-only walkthrough with real report/draft screens. Preserve public/browser dependency restrictions and clear live/test/unavailable labels.
- API/storage: typed requests and records, draft/report persistence, evidence and policy digests, access control, database migrations, error states and contract tests.
- Read-only data/features: bounded provider adapter, mint/account metadata and price provenance where authorized, network failures, deterministic initial feature functions. Store data only when the existing DataLicensePolicy permits it.

Define shared contracts first. Use separate branches/worktrees only with one integrator and clear ownership. A remote improves backup/CI/PRs but is not required to write local code. Avoid parallel edits to the same lockfile or core policy.

## Evidence-based acceptance
1. Invalid/malformed mint and wrong-network inputs are rejected.
2. Unavailable, stale or disagreeing data is explicit and cannot create a spurious PASS.
3. TEST_ONLY fixtures remain clearly separate; blocked live providers do not silently fall back to fake live data.
4. Saved drafts and evidence/policy references survive API/database restart and reload; unauthorized reads/writes are rejected.
5. Missing social/history/cohort inputs remain null/unavailable. No fabricated 30-day history or unsupported overall opportunity ranking. The LLM is optional interpretation only, never the source of numerical scores or permission decisions.
6. Policy changes that affect economics or approvals require the existing review/consent mechanism. Do not silently clamp approved terms.
7. Browser dependency/bundle boundaries, security/licence controls and existing relevant tests continue to pass; report raw advisories and dispositions separately.
8. Live acceptance requires actual authorized reads and their evidence. A completed offline product slice must not be called live-ready when RPC is still unavailable.
9. Demonstrate the integrated vertical slice, not four unconnected feature branches.

## Review cadence
Claude handles ordinary test-first fixes inside scope. Astra reviews the integrated milestone. Escalate immediately only for new material security, authority/signing, licence, architecture or dependency changes. Do not reopen corrected prior findings without new evidence.

## Unchanged external gates
Network configuration; data-provider/service terms; applicable Meteora eligibility; owner approval for external email or remote creation where not already granted; all localnet/devnet/mainnet and reward settlement gates.
