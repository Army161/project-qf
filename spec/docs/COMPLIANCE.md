# COMPLIANCE

This document defines **configurable hooks**, not legal conclusions. Jurisdiction lists, screening requirements and disclosures come from counsel (DECISION). Nothing here is legal advice.

## 1. Architecture principles
- Non-custodial: users sign their own launch/trade/claim transactions; QF never holds creator/user trading funds in a hot wallet.
- Protocol-generated fees flow only through program- or multisig-controlled accounts with transparent accounting.
- Tokenized securities are excluded from production V1 (validator S2.4).

## 2. Policy hooks (all versioned, default values are placeholders pending counsel)
| Hook | Where | Default |
|---|---|---|
| `jurisdictionGate(request)` | Studio entry, launch, claim | OPEN — counsel to supply; ships as pass-through + logging in V0 |
| `sanctionsScreen(address)` | Launch creator, fee claim recipients, reward claimants | OPEN — provider and requirement from counsel |
| `issuerRestriction(issuer)` | Validator S2.5 | Blocklist table, empty in V0 |
| `assetClassPolicy(class)` | Validator S2.4 | `tokenized_security → FAIL` |
| `walletScreening(address)` | Optional, only if legally required | Off |

## 3. Language policy (AI and product copy)
Banned: "guaranteed", "guaranteed profit", "safe investment", "expected return", "risk free", "can't lose", price or ROI projections. QF describes technical configuration, measured data and risk. Enforced by output filter (AI-ENGINE.md §5) and copy review.

## 4. Disclosures (draft list for counsel)
Risk acknowledgement per validator WARN; fee breakdown (including Meteora 20% protocol share); lock status stated only as verified on-chain; rewards are discretionary and gated; no investment advice.

## 5. Records
Validation, simulation, preview, signature and policy-version records retained (retention period OPEN).
