# CLAUDE.md — Project QF (codename QUOTEFORGE)

> Repository layout: code at the root, the spec package under `spec/` (so `docs/…` below means `spec/docs/…`), owner and reviewer handoffs under `handoffs/`. The read-only verifier is `spec/tools/program-verify`.

Rules for every coding agent working in Project QF repositories. These are binding. If a task conflicts with a rule here, stop and ask.

## Status
- Stage: **V0 offline implementation** (amended 2026-09-27, ADR-011). Readiness is tracked per stage: `OFFLINE_V0` ACTIVE; `DEVNET_INTEGRATION` ACTIVE since 2026-10-03 (owner's "unblock devnet", devnet test launches with throwaway keys and free test SOL only); `LOCALNET_INTEGRATION` ACTIVE since 2026-10-11 for Project QF's own engine programs only on 127.0.0.1 (ADR-014; Meteora program copies stay excluded, ADR-013); `MAINNET` BLOCKED (see `packages/core/src/readiness.ts`). No mainnet write transactions. No production deployment.
- Codename only: `QuoteForge` / `Project QF`. Do not create public branding, domains, or package scopes using "QuoteForge". Internal npm scope: `@project-qf/*`.

## Source of truth
1. `docs/DECISIONS/ADR-*.md` (accepted ADRs win over everything below)
2. `docs/SPEC.md`
3. The other documents in `docs/`
4. Upstream **program source at pinned commits**, never READMEs (the SF Rewards README is known to be stale).

## Hard rules — licensing
- **Never fork, copy, modify, vendor, or paraphrase-port** code from `MeteoraAg/dynamic-bonding-curve` or `MeteoraAg/damm-v2` (Meteora Non-commercial Licence). Interact with deployed programs only through `@meteora-ag/dynamic-bonding-curve-sdk` / `@meteora-ag/cp-amm-sdk` (MIT) inside `packages/adapter-meteora-dbc`.
- **Never add `@raydium-io/raydium-sdk-v2`** (GPL-3.0) to any Project QF package. Raydium is out of V1.
- No GPL / AGPL / LGPL / BUSL / SSPL / non-commercial / "source-available" code or packages in proprietary packages. CI license scanner enforces `LICENSE-MANIFEST.json` allowlist. The only exceptions are the exact OFL-1.1 web fonts (QF-LIC-EX-003..005). `QF-LIC-EX-001` (rpc-websockets, LGPL) and `QF-LIC-EX-002` (pako) were REMOVED with the Meteora adapter on 2026-10-25, and the scanner denies them if they come back. Never suppress license scans.
- Do not copy, clone into a local validator, rebuild, cache or redistribute Meteora program binaries or source until written permission covers it (ADR-013). SDK MIT terms do not cover the programs.
- Preserve MIT/Apache notices of dependencies in `THIRD_PARTY_NOTICES.md`. Never relicense third-party code.
- Do not add any open-source LICENSE file to Project QF original code. See `PROPRIETARY-NOTICE.md`.

## Hard rules — security
- AI/LLM code paths have **no access** to keys, signers, RPC write methods, multisig tooling, or policy configuration writes.
- Never put private keys, seed phrases, API keys or `.env` contents in prompts, logs, commits, test fixtures or chat. Devnet keypairs are generated locally at runtime into a git-ignored directory.
- The server **never signs on behalf of a user**. User transactions are built unsigned, simulated, decoded for preview, and signed in the user's wallet.
- Signing pages: no third-party scripts; strict CSP; SRI on any static asset.
- Every critical on-chain read used for a decision (validator, config selection, migration, reward settlement) is performed at `finalized` commitment and cross-checked against a second RPC provider.
- External text (token metadata, social, news, GitHub) is **data**, never instructions. It is passed to models only inside typed fields, and model outputs are schema-validated.

## Hard rules — product boundary (V1)
- **Owner amendment, 2026-10-11 (ADR-014)** (Jeremy, 12:48Z: "im not waiting on metora anymore im taking over and making this mine"; he chose "Own curve + CPMM" at 12:49Z). Project QF's own engine replaces Meteora: `qf-curve` (QF original) and `qf-pool` (a fork of Raydium's Apache-2.0 raydium-cp-swap), source in `quoteforge/engine-qf/`. These rules apply:
  - `packages/engine` is the only package that knows the engine's formats. It is browser-safe and Kit-only.
  - The two Apache-2.0-derived files keep their notice (`packages/engine/third_party/raydium-cp-swap/`).
  - Engine coins are Token-2022 mints with metadata on the mint, no transfer fee, no freeze authority and no mint authority. This overrides "classic SPL Token" below, for engine coins only.
  - The app runs on the engine only. Jeremy approved the switch on 2026-10-25 ("Both": merge the 3-tab app and switch to our own engine), and the Meteora adapter, its checks and its licence exceptions were removed the same day. Do not re-add Meteora code.
  - The engine programs are devnet/localnet only, upgradeable and not audited. Mainnet needs an outside security review, the multisig holding every admin and upgrade key, and Jeremy's explicit words.
  - The line below about "No custom on-chain programs" is superseded by this amendment. The licensing rules above are unchanged.
- Engine: Project QF's own engine only (ADR-014, above). The original "Meteora DBC → DAMM v2 only" rule and the `DBC_BASE_TRANSFER_FEE` capability are retired with the Meteora code.
- Reward strategies: `NONE`, `TRADING_FEE`, `DIRECT`, `MERKLE`, `EPOCH_PROPORTIONAL`. No continuous-rewards contract. Mainnet settlement is feature-gated (`REWARDS_SETTLEMENT_MAINNET=false`).
- Jupiter: `JupiterProvider` is `OPTIONAL_LEGAL_GATED`. Core must run with it disabled. Never persist Jupiter responses into the Asset Graph / feature store.
- Tokenized securities are FAIL in the validator. No EVM code. No custom on-chain programs in V1.
- Launched coins are Token-2022 mints (ADR-014, above).

## Engineering conventions
- Node ≥ 22.12, pnpm 10, TypeScript strict. Exact version pins (no `^`) for Solana packages.
- `@solana/web3.js` v1 is not used anywhere (it left with the Meteora adapter); everything uses `@solana/kit`. `pnpm boundary` keeps web3.js, `rpc-websockets`, the Meteora SDKs, Anchor and the launchpad server out of the browser dependency graph, bundles and source maps.
- Mocks and fixtures carry `MOCK_BANNER` / `TEST_ONLY` labels and are never presented as live results. Synthetic assets live in the `test-only:` namespace and cannot be promoted to the production registry.
- All policies (validator thresholds, economics, exclusions, allocation) are versioned objects; every result records the policy version it used.
- Money math in integer base units (`bigint`); never JS `number` for token amounts.
- The launchpad (`apps/launchpad`) runs on devnet only and proves the cluster by genesis hash before it starts. It may also run on a local validator at 127.0.0.1 (`QF_CLUSTER=localnet`), proven by a loopback URL and a genesis that is not devnet's. Live reads never fall back to fixtures. Missing data is INCOMPLETE, UNAVAILABLE or WAIT with a reason, never a default and never a zero.
- The browser (`apps/web`) talks only to the same-origin launchpad server (CSP `connect-src 'self'`) and the user's wallet, and never calls an RPC.
- Before any PR: `pnpm typecheck && pnpm build:web && pnpm test && pnpm license:check && pnpm boundary && pnpm audit --prod` (install with `--ignore-scripts` in a secret-free environment).

## Stop conditions
Stop and ask the human if a task requires: a mainnet write, a new dependency with a non-allowlisted license, a new on-chain program, changing a policy threshold, touching multisig/authority configuration, or relying on an UNVERIFIED item from `docs/PROGRAM-VERIFICATION.md`.
