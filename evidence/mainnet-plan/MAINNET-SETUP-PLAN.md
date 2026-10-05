# Mainnet setup plan (PLAN ONLY, not signable)

Generated 2026-10-05T21:24:52.223Z from real mainnet reads. Mainnet readiness: BLOCKED. MAINNET_WRITES: false.

- PLAN ONLY. Nothing here was signed, simulated or sent, and nothing can be: the payer, the multisig create key, the config account and the blockhash are placeholders no one holds a key for.
- The economics are STANDARD_V1@0-v0test (usage V0_TEST), the devnet test economics. They are not approved for production (DEPLOYMENT.md §2 item 6).
- The graduation target assumes USDC at $1.00 with no live price or liquidity evidence. At execution the record is made again from live evidence.
- Members are placeholders: the owner has not named the real signers yet (TRE-1).

## What would be created

1. **Create the 2-of-3 platform treasury (Squads v4 multisig).** Multisig `7uiZkoTuNwgUgGKpZioGKPdEjG2bqVfDSFb4bTBQZdBV`, vault `6TauWKgWHh7djAPdRBjnSFH7oRYxL7UZeNJZzgm1b8g7`. These addresses come from the placeholder create key, so the real ones will differ.
2. **Create the mainnet DBC config (USDC quote; platform fees and leftovers to the treasury vault).** Fee claimer and leftover receiver: the vault above. Quote: USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

## Treasury members

| # | Address | Placeholder |
|---|---|---|
| 1 | `AMkK85iLWDzrBF2U133jASwbBKpUHn36ka5VSdhRjzYP` | yes |
| 2 | `H6GDUBkcjQKuzJDq4xfJUfyDvrx8JmcexsNGPm3JLNcz` | yes |
| 3 | `AgULNkdgafhd1a6hZd4U1aeiuSARNMewex1Fx7Ew6aiJ` | yes |

Approvals needed: **2 of 3**. Time lock: **0 s**. Config authority: **none**. Every member can propose, approve and execute.

## Economics in this plan (test economics, not approved for production)

| Item | Value |
|---|---|
| trading fee on the curve | 1% of each trade (flat; dynamic fee off) |
| Meteora's protocol share | 20% of that fee, set by the DBC program (observed on every devnet trade) |
| creator share of the rest | 50% |
| platform share of the rest | 50%, to the treasury vault |
| platform share split (revenue / holder rewards) | 50 / 50 (policy only: holder rewards are not built for mainnet) |
| fee collected in | the quote token (USDC) |
| graduated DAMM v2 pool fee | 1% |
| LP after graduation | platform 50% and creator 50%, both permanently locked (fees claimable, principal not) |
| migration fee taken by the platform | 0% |
| pool creation fee charged to creators | 0 lamports |
| token mint and update authority after launch | Immutable |
| token supply | 1000000000 (6 decimals), 20% of supply moves to DAMM v2 at graduation |
| graduation target | 5000 USDC = 5000000000 raw (USDC at par; plan assumption) |

## Cost to set up

| Item | Amount |
|---|---|
| Squads multisig creation fee (from its program config on mainnet) | 0.000000 SOL |
| rent for the multisig account (231 bytes; both providers agree) | 0.001824 SOL |
| rent for the DBC config account (1048 bytes; both providers agree) | 0.005974 SOL |
| network fees (2 transactions x 2 signatures x 5,000 lamports; no priority fee) | 0.000020 SOL |
| **total** | **0.007818 SOL** |

## Checks on what was built

| Check | Result | Detail |
|---|---|---|
| SQUADS_PROGRAM_CONFIG | PASS | read at finalized, MATCH: fee 0 lamports to 5DH2e3cJmFpyi6mk65EGFediunm4ui6BiKNUNrhWtD1b |
| MULTISIG_ADDRESS_DERIVED_TWICE | PASS | multisig 7uiZkoTuNwgUgGKpZioGKPdEjG2bqVfDSFb4bTBQZdBV, vault 6TauWKgWHh7djAPdRBjnSFH7oRYxL7UZeNJZzgm1b8g7 (Squads SDK and QF derivation agree) |
| MULTISIG_ARGS | PASS | decoded from the instruction bytes: threshold 2, time lock 0s, config authority none, 3 members with initiate+vote+execute |
| CONFIG_BOUND_TO_TERMS | PASS | QF decoder: one create_config, every account, signer, writable and the parameter digest match |
| FEE_CLAIMER_IS_TREASURY_VAULT | PASS | fee_claimer 6TauWKgWHh7djAPdRBjnSFH7oRYxL7UZeNJZzgm1b8g7 |
| LEFTOVER_RECEIVER_IS_TREASURY_VAULT | PASS | leftover_receiver 6TauWKgWHh7djAPdRBjnSFH7oRYxL7UZeNJZzgm1b8g7 |
| QUOTE_MINT | PASS | quote_mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v |
| DBC_PROGRAM | PASS | config instruction calls the pinned DBC program; multisig instruction calls the pinned Squads v4 program |
| NOT_SIGNABLE | PASS | required signers EvZro4eJ8PtgubWXm9QNtjA594BpFyjXZs2Ew5XDCy22, BmnG5deTGQPpsjUXY97fJWV6t8hXzRfALGJYXvsiZKS1, 55hQZoQqX3dypU4wTnq82SdybPW7yuSfVbD4f99VBZun are all placeholders (sha256 of a label; no one holds their keys) |
| NOT_LANDABLE | PASS | recent blockhash HwvUCFh3rkorwnGL6k1pyRRsFwnePsyLDpdNbY2zeDyw is a placeholder, not a mainnet blockhash |
| MEMBERS_NOT_PLACEHOLDER_SIGNERS | PASS | no member is the payer, create key or config account |

## Decisions only the owner can make

| Item | Question | This plan uses | Note |
|---|---|---|---|
| TRE-1 members | Who are the treasury signers? | 3 placeholders | Three different people, each on a hardware wallet (DEPLOYMENT.md §2 item 5). No signer may be the server, the payer or a hot wallet. |
| TRE-1 threshold | How many approvals move money? | 2 of 3 | The policy says 2-of-3. With 3-of-3, one lost device locks the treasury for good. |
| TRE-1 time lock | Should approved proposals wait before they can run? | 0 seconds | A time lock (for example 24 hours) gives signers a window to cancel a bad proposal, and delays every fee claim by the same amount. |
| ECON | Which fees go live? | STANDARD_V1@0-v0test (test economics) | Production economics and curve template need approval with a simulation report (DEPLOYMENT.md §2 item 6). A config cannot be changed after it is created; new economics mean a new config. |
| GRAD | At how many USDC does a coin graduate to DAMM v2? | 5000 USDC | The migration policy allows 1000 to 100000 USD; 5000 is its standard default. |
| PAYER | Which wallet pays for setup? | placeholder | A funded wallet with about 0.0078 SOL. It gets no rights over the treasury or the config. |

## After the real run

1. Read the multisig back at finalized from two providers: members, threshold, time lock, config authority none.
2. Read the DBC config back at finalized from two providers and decode it: fee claimer and leftover receiver are the vault, quote mint is USDC, every parameter equals the approved digest (DEPLOYMENT.md §3, verifier parity).
3. Record the config in the registry as active only after both read-backs match.
4. Run program-verify on mainnet with two RPCs and set up upgrade alerting (DEPLOYMENT.md §2 item 2).

## Transactions (unsigned; read them independently)

### Create the 2-of-3 platform treasury (Squads v4 multisig)

Program `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, instruction `multisig_create_v2`. Required signers (all placeholders): `EvZro4eJ8PtgubWXm9QNtjA594BpFyjXZs2Ew5XDCy22`, `BmnG5deTGQPpsjUXY97fJWV6t8hXzRfALGJYXvsiZKS1`.

| Account | Address | Signer | Writable |
|---|---|---|---|
| program_config | `BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr` |  |  |
| squads_treasury | `5DH2e3cJmFpyi6mk65EGFediunm4ui6BiKNUNrhWtD1b` |  | yes |
| multisig | `7uiZkoTuNwgUgGKpZioGKPdEjG2bqVfDSFb4bTBQZdBV` |  | yes |
| create_key | `EvZro4eJ8PtgubWXm9QNtjA594BpFyjXZs2Ew5XDCy22` | yes |  |
| creator (payer) | `BmnG5deTGQPpsjUXY97fJWV6t8hXzRfALGJYXvsiZKS1` | yes | yes |
| system_program | `11111111111111111111111111111111` |  |  |

Message (base64; paste into a Solana transaction inspector to decode it yourself):

```
AgEDB6ANmbq16l0/NVdt3F/PPwyLDgRDwMKYDLfQQ541UktCzuDdvWNad0xKC5i82QooycKhLeHy0jP20SC0R9xaZFM+k9cyxEgkJ5DS27UxpAq9GfFsVeMTLP9Sd63J1pOrWmanUi91T3X2/AIq42AKyyIeKRY3v3X+285KWz/vwsOgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACbGrn+ly+yZhxebQwZs5X/1yCFK/bj44BdqL6GYhjPTQaBxM5H4iNouLFVXsiHrwku/H77tmyj9S+/aNSsnLeo+8zP28Wi0p9b6fcOOELQYgiJ+7j48TF6NTftzzqO4E4BBgYFAgMBAAR4Mt3HXSj1i+kAAgADAAAAiwnFpdgmH98aT4DxR/R7e8CVThw+5Xe78x79XnVm0LAH7xQZNx4blW9cfiBEBasIurtXdXiO6yYNqF3pGc5SkWMHj9W9mCMrrmYfeF7ZY/fo7sc8wN2nSVTs5A5qOzVrMUcHAAAAAAAA
```

### Create the mainnet DBC config (USDC quote; platform fees and leftovers to the treasury vault)

Program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, instruction `createConfig`. Required signers (all placeholders): `55hQZoQqX3dypU4wTnq82SdybPW7yuSfVbD4f99VBZun`, `BmnG5deTGQPpsjUXY97fJWV6t8hXzRfALGJYXvsiZKS1`.

| Account | Address | Signer | Writable |
|---|---|---|---|
| config | `55hQZoQqX3dypU4wTnq82SdybPW7yuSfVbD4f99VBZun` | yes | yes |
| fee_claimer | `6TauWKgWHh7djAPdRBjnSFH7oRYxL7UZeNJZzgm1b8g7` |  |  |
| leftover_receiver | `6TauWKgWHh7djAPdRBjnSFH7oRYxL7UZeNJZzgm1b8g7` |  |  |
| quote_mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |  |  |
| payer | `BmnG5deTGQPpsjUXY97fJWV6t8hXzRfALGJYXvsiZKS1` | yes | yes |
| system_program | `11111111111111111111111111111111` |  |  |
| event_authority | `8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF` |  |  |
| program | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |  |  |

Message (base64; paste into a Solana transaction inspector to decode it yourself):

```
AgAFB6ANmbq16l0/NVdt3F/PPwyLDgRDwMKYDLfQQ541UktCPKLCLJr2OwOuZsMrWkB5HsmfXYrgGH4lcktEIc7SVMUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFEZ31qhDajeELXaf3CekItgEmAAAKHSmMbinGSWXfXobNbMgMewCyTCECA4Qz9Iqg/KjufoGQM8D+H7pyjf9QwJYAylJPext9bMscOXOqAzDRkD2mAcybXe48ZitMrRScb6evO+2606PWXzaqvJdDGxu+TC0vbg5HymAgNFL11h+8zP28Wi0p9b6fcOOELQYgiJ+7j48TF6NTftzzqO4E4BBQgBAwMGAAIEBYMCyc/zcktvL72AlpgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAYAMgAyAPIFKgEAAAAJMrhuhetRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYBAIDGpH6NAwAAgMakfo0DADIBAAAAAGQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAArkfhehSuRwEAAAAAAAAAADntzZXse34/Y3rccDYBAACbV2lOqRpchLHE/v8AAAAAfoCmX3qncF2X1wIAAAAAAA==
```

The full decoded arguments, the QF binding terms and the open mainnet items are in the JSON next to this file.
