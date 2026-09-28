# VISION

## Long-term question
> "What chain + quote asset + execution engine + launch configuration + economic structure best fits this proposed launch under measurable constraints?"

Project QF becomes the system creators and launch partners use to answer that question with evidence, then execute the answer safely.

## Loop
```
DISCOVER → VALIDATE → SCORE → SIMULATE → ARCHITECT → EXECUTE → MEASURE → LEARN
```
Every launch executed through QF produces outcome labels (graduation, time-to-graduation, retained holders, wash-adjusted volume, quote-liquidity retention, reward participation, 30-day survival, creator repeat usage). Those labels become the proprietary evaluation history that improves scoring. This loop — not any single on-chain capability — is the moat.

## What is deliberately not the moat
- "Launch against arbitrary quote assets." Competing launchpads already offer custom quote assets, altcoin pairs, stock pairs and quote-denominated rewards (DECISION 2026-09-26; competitor specifics reported by the product owner, UNVERIFIED by this package).
- On-chain logic. All V1 execution runs on public Meteora programs; parameters are visible on-chain.

## Horizon
| Horizon | Scope |
|---|---|
| V1.0 | Solana, Meteora DBC → DAMM v2, SPL base tokens, trading-fee rewards settled by Merkle |
| V1.1 | Native DBC base-mint transfer fees (capability `DBC_BASE_TRANSFER_FEE`) once gates in ADR-003 pass |
| V2 | Additional engines (Raydium via IDL/instructions under Apache-2.0 programs), BYO partner configs, additional templates |
| Later | Multi-chain (EVM), tokenized-asset track via compliance partnerships |

Multi-chain and multi-engine are reached by adding adapters behind `LaunchEngineAdapter` and `MarketDataProvider`, never by rewriting QF Core.
