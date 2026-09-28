# Project QF: handoff from Claude to Astra

Date: 2026-09-28. From: Claude (the build thread). To: Astra, via Jeremy.
Jeremy asked me to speak plainly and ask for what I need, so this note is direct.

**Attach with this note:**
1. `spec/RETURN-REPORT-READONLY-READINESS.md`, the latest checkpoint report.
2. `exports/quoteforge-v0-readonly-readiness-2026-09-27.zip`, the full package (317 files, with MANIFEST.json and SHA256SUMS inside).
   sha256 `6b147099f82fc1e5e5afa6b8d6d6102989f60d2ff1d580746a1deb119132166e`.

## Where we are, in one paragraph

The offline V0 is in good shape. There are 185 project tests and 55 verifier tests, all passing in a clean, secret-free environment. The licence gate and SBOM are clean, and the five SEC-A dispositions were adopted by Jeremy. Every decision from your last package is applied: Customizable needs config_type 1, response bodies are bounded while streaming, and the ws natives are removed. **But nothing on-chain has been verified.** After three passes, we still have not confirmed a single program address, authority, config value or deploy hash against a live cluster. The cloud environment gets `403 Host not in allowlist` for the Solana RPC hosts, and I cannot reach Jeremy's computer.

## What's bugging me

1. **We're polishing offline code while the foundation is unverified.** Each review pass finds real but small issues, and I fix them. Meanwhile the one thing that could invalidate the design has never been checked: whether the deployed programs match what we built against. More spec or review cycles now have diminishing returns. The next pass should be driven by live read-only results, not another review.
2. **U.S. eligibility is the biggest risk in the whole project, and it's the cheapest to settle.** Meteora's terms have a territorial restriction. If it covers a U.S.-based developer doing SDK work or devnet integration, DEVNET and MAINNET are blocked no matter how good the code is. The inquiry is written, contains no attachments and discloses nothing confidential. I recommend Jeremy sends it now. Any launch-planning work before we have that answer is a bet on it.
3. **Your "confirmed for pinned source" claims are ones I can't check.** I recorded the config-type and authority rules as `CONFIRMED_FOR_PINNED_SOURCE` on your word, because I never opened Meteora's program source. When you cite source, please give the repo, the commit hash, the file path, the line range and the quoted lines, so I can check it myself. A citation I can't open becomes a trust-me in the evidence record, and I'd rather not have those.
4. **The raw audit is still red** (1 high and 2 moderate: bigint-buffer, uuid, stream-json). The dispositions make that acceptable for V0, but they expire on 2026-12-27. Before MAINNET, the high item needs removing, not dispositioning. If you know a maintained path that doesn't pull in `bigint-buffer`, I'd like it on the roadmap now rather than in December.

## What I need, and from whom

| # | Need | From | Form |
|---|---|---|---|
| 1 | Live read-only verification | Jeremy | **Either** run `sh run-readonly-local.sh` (report §5) and send back `verification-results/`, **or** add `api.mainnet.solana.com`, `api.devnet.solana.com` and `verify.osec.io` to the allowed domains in Project settings so I can run it myself. The second option is faster and keeps the evidence in one place. |
| 2 | SEC-A carry-over | Jeremy | One line: "SEC-A adoption covers lockfile c2bb276a". The five records came out identical after the natives removal (evidence is in the ZIP). |
| 3 | Meteora inquiry | Jeremy | One line: "send it" or "hold". It goes to an outside party, so I won't send it without those words. The text is Astra's draft, unchanged, in `spec/reviews/2026-09-27-repair-decision/METEORA-INQUIRY.md`. |
| 4 | Checkable source citations | Astra | Repo, commit, path, lines and a quoted excerpt, for the DBC Customizable migration rules (see point 3 above). |
| 5 | A path off `bigint-buffer` | Astra | A package name and version, or "none known". |
| 6 | Next pass | Astra | Scope it to what the live results show. If the live values match, the goal is READ_ONLY_VERIFICATION → passed, then the DEV-1…DEV-3 prerequisites. If they don't match, the goal is to reconcile the mismatch first. Please don't open a new architecture or spec cycle. |

## How to send things back so I can use them

These work well:
- ZIPs with SHA256SUMS;
- runnable diagnostics (your last one reproduced both bugs exactly, and that was the most useful input I've had);
- one-line decisions.

These I can't use:
- files that are mentioned but not attached;
- ChatGPT citation markers;
- `sandbox:` links;
- "see above" references to a conversation I can't see.

Please put decisions in a short numbered list I can quote back verbatim.

## Unchanged limits

- No wallets, keys, signing, transactions, simulations or airdrops, and no mainnet writes.
- No copying Meteora program binaries or source into a local validator until they give written permission (LOCAL-1).
- No TLS, proxy or geographic bypass.
- Mocks stay labelled.
- Test counts are never readiness. This is not an audit.
