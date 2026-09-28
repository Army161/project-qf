# DATA-LICENSES — DataLicensePolicy

The Asset Graph is strategic IP. Data whose terms forbid storage or derivative use must never enter it.

## 1. License classes
| Class | Meaning | Persist raw? | Persist derived? |
|---|---|---|---|
| `ONCHAIN_PUBLIC` | Read from chain via our RPC/Geyser | Yes | Yes |
| `OPEN_PERMISSIVE` | Explicit permissive license (e.g., CC-BY with attribution) | Yes (with attribution record) | Yes |
| `COMMERCIAL_APPROVED` | Paid provider whose contract permits storage/derivation | Per contract | Per contract |
| `LIVE_ONLY` | May be displayed/used transiently; no storage | No | No |
| `PROHIBITED` | Not to be ingested | No | No |
| `UNREVIEWED` | Default for any new source | No | No |

## 2. Current assignments
| Source | Class | Basis |
|---|---|---|
| Solana RPC / Geyser (own subscription) | ONCHAIN_PUBLIC | Public chain data; provider ToS to be checked for storage clauses |
| Pyth price data | UNREVIEWED → target COMMERCIAL_APPROVED or OPEN_PERMISSIVE | Client libs Apache-2.0 (FACT); data terms UNVERIFIED |
| Issuer first-party pages | OPEN_PERMISSIVE (facts: mint address) | Mint addresses are facts; store URL + hash, not page copy |
| Jupiter APIs | LIVE_ONLY (gated) | License agreement restrictions (ADR-005) |
| GitHub REST API | UNREVIEWED | GitHub API terms review pending |
| Birdeye / DEX Screener / CoinGecko / Helius / Bitquery / Dune | UNREVIEWED | Not integrated until contract review |
| Social / news | UNREVIEWED | Prefer derived counts over raw text |

## 3. Enforcement
- Ingest pipeline: `SOURCE → INGEST → LICENSE GATE → NORMALIZE → PROVENANCE TAG → FEATURE STORE → SCORE → ASSET GRAPH → AI`.
- The gate rejects writes whose `license_class ∈ {LIVE_ONLY, PROHIBITED, UNREVIEWED}`.
- Every stored datum: `source`, `retrieved_at`, `license_class`, `content_hash` (where applicable), `raw_or_derived`.
- Prefer storing derived metrics over raw third-party content.
- Purge job: if a source is reclassified downward, delete its raw rows and recompute derived features lacking alternative provenance.
