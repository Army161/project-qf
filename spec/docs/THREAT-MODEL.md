# THREAT-MODEL

Carried forward from `V1-ARCHITECTURE-REVIEW.md` §F and updated for the resolved architecture.

| Sev | Threat | Mitigation (component) |
|---|---|---|
| Critical | Malicious / fake canonical quote mint | Registry identity = (chain, mint); impersonation FAIL (S2.2); registry-first search (Validator, Registry) |
| Critical | Freeze-authority abuse bricking vaults | Non-allowlisted freeze authority FAIL (S1.8); AuthorityMonitor on pool vaults |
| Critical | Mint-authority abuse (inflation) | Non-allowlisted mint authority FAIL (S1.9) |
| Critical | Transfer-fee authority raising fee on quote | FAIL if authority live (S1.5) |
| Critical | Malicious T22 extensions (PermanentDelegate, TransferHook, Pausable, DefaultAccountState) | TOKEN-2022.md REJECTED list |
| Critical | AI authorizing transactions / malicious model output | AI-ENGINE.md pipeline; Policy Engine; simulation; wallet signature |
| Critical | Wallet-drainer frontend injection / supply chain | CSP, SRI, no third-party scripts on signing pages, pinned deps, SBOM, OSV, client-side decoded preview |
| High | Hijack of stray dependency `chain@^0.4.0` declared by `@meteora-ag/cp-amm-sdk@1.4.10` (unrelated package, third-party maintainers) | **Removed** (2026-09-27, ADR-012): targeted override `"@meteora-ag/cp-amm-sdk@1.4.10>chain": "-"`; absence proven in graph, lockfile, SBOM and runtime (`pnpm deps:chain`); install with scripts off in a secret-free environment; report upstream. Not treated as evidence of compromise |
| High | Admin/partner key compromise | Separate 2-of-3 multisigs per role; no hot authority |
| High | Creator key compromise | Alerts on `transferPoolCreator` / `EvtUpdatePoolCreator`; hardware-wallet guidance |
| High | Prompt injection from external data | Typed untrusted fields, sanitization, no agent tools, output filter |
| High | Oracle/price manipulation | Median of Pyth + approved provider; TWAP windows; disagreement → WARN; scores never trigger txs |
| High | Reward/snapshot/claim manipulation | TWAB (no point snapshot), exclusions, Sybil clustering, min hold, published artifacts, double-claim prevention by settlement program |
| High | Vendor program change (Meteora upgrade) | Version pinning, daily config dry-run, programdata slot monitoring, mainnet-fork compatibility suite |
| High | Settlement program unaudited delta | Mainnet settlement gate (REWARDS.md §6) |
| Medium | Front-running / sandwich / MEV / snipers | First-buy in create tx; user slippage bounds; simulation of flat-fee sniping impact (ECONOMICS.md §5) |
| Medium | Wash trading inflating scores | Wash filter; wash-adjusted features |
| Medium | RPC/API compromise or inconsistency | Two-RPC agreement; finalized; slot recorded |
| Medium | Indexer inconsistency / reorgs | Slot-aware ingestion, confirmed→finalized promotion, idempotency, reconciliation, backfill |
| Medium | Migration stall | MigrationCrank + alert on `complete && !migrated` |
| Medium | Data-license contamination | DataLicensePolicy gate; purge job |
| Low | CPI Guard / MemoTransfer user accounts | Pre-flight warning |
| Low | Metadata spoofing/phishing | Sanitization, image proxy, link allowlist |
| Low | Name/brand conflict ("QuoteForge") | Internal codename only; naming/trademark screen before launch |

## Amendment 2026-09-27 (V0 decisions)
| Severity | Threat | Mitigation |
|---|---|---|
| High | LGPL `rpc-websockets` or `@solana/web3.js` v1 leaking into a browser bundle, worker or public source map (breaks QF-LIC-EX-001) | `pnpm boundary` audits the web dependency graph, esbuild metafile inputs, emitted JS, worker bundle and source maps, with canaries proving the check detects web3.js and refuses an adapter import; adapter throws if `window` exists |
| High | Mock or TEST_ONLY data presented as live, or synthetic assets promoted to production | `MOCK_BANNER` on every mock surface; `assertNotMock`; `test-only:` namespace; `promoteToProductionRegistry` refuses TEST_ONLY class, id prefix or evidence; TEST_ONLY validation can never PASS |
| High | USD ceiling mistaken for market cap or silently repriced after consent | Decision 3 record stores raw threshold, decimals, price source, time and slot; `migrationMarketCap` never used; `recheckBeforeSigning` returns REPRICE_REQUIRED or NEW_CONSENT_REQUIRED; adapter fails closed if the SDK-stored threshold differs from the approved raw |
| Medium | Duplicate pool reports inflating quote-market liquidity | Pools deduplicated by chain + venue + address, minimum reserves kept; two providers on one pool count as corroboration only |
| Medium | Diagnostic tooling performing writes or attestations | Verifier RPC client has a three-method read allowlist; static test forbids send/sign/airdrop/key code; no env vars read |
| Medium | Unlicensed local copies of Meteora programs (commercial use not cleared) | ADR-013: no clone/rebuild/cache until written permission; LOCALNET_INTEGRATION blocked on LOCAL-1 |
