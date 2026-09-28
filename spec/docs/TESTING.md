# TESTING

## 1. Layers
| Layer | Scope | Tooling |
|---|---|---|
| Unit | validator checks, policy engine rules, TWAB, Merkle builder, decoders | vitest |
| Property | curve math parity: QF simulator vs. SDK `swapQuote` over random inputs; TWAB invariants (sum of allocations = funded − rolled forward); Merkle proof round-trip | fast-check |
| Golden | Validator decisions on fixture mints (T22 with each extension, authority variants) | recorded snapshots |
| Integration (localnet-clone) | DEVNET.md steps against `solana-test-validator` with cloned DBC/DAMM v2 and dependencies | scripted, single command |
| Integration (devnet) | Same suite on public devnet | scripted |
| Mainnet-fork read-only | Adapter decoding/quoting against real configs/pools; no writes | read-only RPC |
| E2E UI | Studio lifecycle timeline, preview decoder, WARN acknowledgement | Playwright (Chromium) |
| Security | CSP headers present on signing routes; no third-party script tags; license scanner; OSV; secret scan | CI |
| AI red-team | prompt-injection corpus in token metadata/social fields; banned-phrase outputs; schema breaking attempts | eval harness |

## 2. Mandatory assertions (cross-reference)
DEVNET.md §3 assertion table is normative for V0.

## 3. Determinism tests
- Reward epoch: two independent runs → identical allocation-file hash and Merkle root.
- Scores: recompute from stored snapshot → identical values.
- Validator: same snapshot + policy → identical result.

## 4. CI gates
`lint`, `typecheck`, `test`, `license:check` (LICENSE-MANIFEST.json), `pnpm audit --prod`, OSV, SBOM generation, secret scanning, CODEOWNERS review.

## 5. Amendment 2026-09-27 — V0 offline implementation (what actually runs)
| Layer | Tooling in `project-qf` | Command |
|---|---|---|
| Unit / policy / boundary values | `node --test` (Node 22 type stripping); vitest and fast-check were not adopted, to keep the dependency tree small | `pnpm test` |
| Adapter compatibility | SDK 1.5.13 / cp-amm 1.4.10 against a labelled MOCK RPC; independent Kit decoder | included in `pnpm test` |
| Econ simulation | `tools/econ-sim`, identical synthetic traces, SDK quote math | included in `pnpm test`; `node tools/econ-sim/src/run.ts` |
| E2E mock UI | Playwright-core + preinstalled Chromium, localhost only, MOCK banners asserted | included in `pnpm test` |
| Types | `tsc --noEmit` strict | `pnpm typecheck` |
| Licences | resolved graph against LICENSE-MANIFEST.json, exception conditions enforced | `pnpm license:check` |
| Dependency removal | `chain` absent from lockfile, graph, node_modules, SBOM and runtime | `pnpm deps:chain` |
| Browser boundary | web graph, bundle inputs, JS, worker, source maps, wallet packages, canaries | `pnpm boundary` |
| Verifier | 16 negative/contract tests, fake RPC | `cd spec/tools/program-verify && pnpm test` |

Integration layers (localnet-clone, devnet, mainnet-fork) stay BLOCKED per ADR-011.

## 6. Amendment 2026-09-27 — repair pass
- **Red first.** Each review finding was reproduced as a failing test before the fix; the logs are in `project-qf/evidence/repair/red/` and `green/`. Tests that defined the deficient behaviour as success were removed or rewritten.
- **New suites.** `packages/tx/test/binding.test.ts` (terms, consent, strict Borsh); `packages/adapter-meteora-dbc/test/mutation.test.ts` (16 serialized-message mutations of valid SDK transactions); `idl-subset.test.ts` (IDL subset drift/licence); `supply-accounting.test.ts` (ECON-1); `sec-a.test.ts` (installed-artifact assertions for the five advisories); `packages/validator/test/schema-admission.test.ts`; review-findings tests in tx, validator, policy and the verifier.
- **Licence.** `tools/license-check/test/spdx.test.ts` covers the exact pako exception.
- Integration layers stay BLOCKED per ADR-011, including the new READ_ONLY_VERIFICATION stage.
