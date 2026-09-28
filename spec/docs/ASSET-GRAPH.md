# ASSET-GRAPH

Private, provenance-tagged graph of assets and the ecosystems around them. Lives in `project-qf-intelligence` storage; accessed by core via internal API.

## 1. Nodes
`Asset(chain,mint)` · `Issuer` · `Pool(venue,address)` · `Launch(dbc_pool)` · `Config(qf_config_id)` · `HolderCluster` (Sybil/funding clusters, hashed wallet sets) · `CommunityToken` (launched tokens quoted in an asset) · `Repo` (GitHub) · `SocialEntity` (derived handles/topics) · `Bridge`.

## 2. Edges
`ISSUED_BY(Asset→Issuer)` · `QUOTED_IN(CommunityToken→Asset)` · `TRADES_ON(Asset→Pool)` · `LAUNCHED_WITH(Launch→Config)` · `HOLDS(HolderCluster→Asset, twab)` · `FUNDED_BY(HolderCluster→HolderCluster)` · `BRIDGED_FROM(Asset→Asset via Bridge)` · `DEVELOPED_IN(Asset→Repo)` · `MENTIONED_WITH(Asset↔Asset, window)`.

## 3. Rules
- Every node/edge property carries provenance (`source`, `retrieved_at`, `license_class`, `raw_or_derived`, `content_hash`).
- Only `ONCHAIN_PUBLIC`, `OPEN_PERMISSIVE`, `COMMERCIAL_APPROVED` data (DATA-LICENSES.md).
- Time-versioned (bitemporal: `valid_from/valid_to`, `recorded_at`) so scores are reproducible "as of" a timestamp.
- Storage: Postgres (relational core) + graph projection (e.g., Apache AGE or materialized adjacency tables). Choice OPEN; relational-first for V1.

## 4. Outcome labels (proprietary history)
Per launch: graduation (bool), time-to-graduation, retained holders (7d/30d), organic volume, wash-adjusted volume, quote-liquidity retention, reward participation, 30-day survival, creator repeat usage. Computed from own indexer only.
