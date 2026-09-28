# OPPORTUNITY-ENGINE

Deterministic measurement first, AI interpretation last. The LLM never computes an authoritative score.

## 1. Layers
1. **Features** — raw measured values, timestamped, provenance-tagged (feature store).
2. **Scores** — deterministic, versioned functions of features (this document).
3. **Interpretation** — LLM narrative over structured scores (AI-ENGINE.md).

## 2. Feature groups (initial)
| Group | Features | Source (V1) |
|---|---|---|
| Liquidity | liq_usd, depth_2pct_usd, liq_change_7d | own indexer + Pyth |
| Volume | vol_24h, vol_7d_trend, wash_adjusted_ratio | own indexer + wash filter |
| Holders | holders, holder_growth_7d, top10_share, gini, cluster_adjusted_holders | own indexer |
| Saturation | community_tokens_quoted_30d, graduated_share, competitor_reward_tokens | own DBC/DAMM indexer |
| Velocity | launches_per_day_in_asset, price_realized_vol_30d | own indexer + Pyth |
| Developer | commits_30d, contributors_30d, releases_90d | GitHub (pending license review) |
| Social/news | mentions_24h, unique_authors, bot_share, articles_7d | OPEN (no approved provider) |
| Utility | quote_route_count, oracle_present, keeper_eligible, dbc_permissionless | own indexer, registry |
| Cross-chain | chains_available, canonical_bridge | registry |

## 3. Required scores (each `score@version`)
| Score | Inputs (initial definition) |
|---|---|
| LiquidityScore | percentile(liq_usd), percentile(depth_2pct_usd), stability(liq_change_7d) |
| RiskScore | validator WARN count/severity, top10_share, authority flags, realized vol, liquidity instability |
| SaturationScore | community_tokens_quoted_30d, competitor_reward_tokens, graduated_share (higher = more saturated) |
| SocialVelocity | z-score(mentions, unique_authors vs 30d baseline) × (1 − bot_share); `null` until a provider is approved |
| DeveloperVelocity | f(commits, contributors, releases); `null` if no repo |
| MarketVelocity | vol_7d_trend, launches_per_day_in_asset |
| HolderQualityScore | cluster_adjusted_holders, gini, holder retention |
| QuoteUtilityScore | route count, exit liquidity, oracle_present, keeper_eligible, permissionless |
| CrossChainAvailability | chains_available with canonical provenance |
| LaunchCompetitionScore | launches in same asset last 7d/30d, their graduation/survival |
| OpportunityScore | weighted combination: + Liquidity, SocialVelocity, DeveloperVelocity, MarketVelocity, QuoteUtility − Saturation, Risk, LaunchCompetition |
Weights and transforms live in `project-qf-intelligence`, versioned; a missing input yields an explicit `null` component with reduced confidence, never an imputed guess.

## 4. Properties
Deterministic (pure over an as-of snapshot), versioned, reproducible, backtestable. Every score record stores `score_version`, `feature_snapshot_hash`, `as_of`.

## 5. Guardrails
RiskScore never lowers a validator FAIL. OpportunityScore never triggers a transaction.

## 6. Backtesting
For each policy/score version: replay as-of snapshots over historical DBC launches (own indexer backfill), correlate with outcome labels (ASSET-GRAPH.md §4), report calibration and drift. Required attachment for any validator threshold or score weight change.
