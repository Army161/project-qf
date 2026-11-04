# THIRD-PARTY NOTICES

Production dependencies of the launchpad server and the browser app, from the lockfile (`sbom/project-qf.cdx.json`, 2026-10-25). Apache-2.0 packages: include NOTICE if present. The Meteora adapter and everything only it pulled in (the Meteora SDKs, `@solana/web3.js` v1, `@sqds/multisig`, Anchor, `rpc-websockets`, `pako` and 128 packages in all) were removed on 2026-10-25, when the owner chose Project QF's own engine.

| Component | Version | License |
|---|---|---|
| @noble/hashes | 1.8.0 | MIT |
| @solana/accounts | 8.3.0 | MIT |
| @solana/addresses | 8.3.0 | MIT |
| @solana/assertions | 8.3.0 | MIT |
| @solana/codecs | 8.3.0 | MIT |
| @solana/codecs-core | 8.3.0 | MIT |
| @solana/codecs-data-structures | 8.3.0 | MIT |
| @solana/codecs-numbers | 8.3.0 | MIT |
| @solana/codecs-strings | 8.3.0 | MIT |
| @solana/errors | 8.3.0 | MIT |
| @solana/fast-stable-stringify | 8.3.0 | MIT |
| @solana/fixed-points | 8.3.0 | MIT |
| @solana/functional | 8.3.0 | MIT |
| @solana/instruction-plans | 8.3.0 | MIT |
| @solana/instructions | 8.3.0 | MIT |
| @solana/keys | 8.3.0 | MIT |
| @solana/kit | 8.3.0 | MIT |
| @solana/nominal-types | 8.3.0 | MIT |
| @solana/offchain-messages | 8.3.0 | MIT |
| @solana/options | 8.3.0 | MIT |
| @solana/plugin-core | 8.3.0 | MIT |
| @solana/plugin-interfaces | 8.3.0 | MIT |
| @solana/program-client-core | 8.3.0 | MIT |
| @solana/programs | 8.3.0 | MIT |
| @solana/promises | 8.3.0 | MIT |
| @solana/rpc | 8.3.0 | MIT |
| @solana/rpc-api | 8.3.0 | MIT |
| @solana/rpc-parsed-types | 8.3.0 | MIT |
| @solana/rpc-spec | 8.3.0 | MIT |
| @solana/rpc-spec-types | 8.3.0 | MIT |
| @solana/rpc-subscriptions | 8.3.0 | MIT |
| @solana/rpc-subscriptions-api | 8.3.0 | MIT |
| @solana/rpc-subscriptions-channel-websocket | 8.3.0 | MIT |
| @solana/rpc-subscriptions-spec | 8.3.0 | MIT |
| @solana/rpc-transformers | 8.3.0 | MIT |
| @solana/rpc-transport-http | 8.3.0 | MIT |
| @solana/rpc-types | 8.3.0 | MIT |
| @solana/signers | 8.3.0 | MIT |
| @solana/subscribable | 8.3.0 | MIT |
| @solana/sysvars | 8.3.0 | MIT |
| @solana/transaction-confirmation | 8.3.0 | MIT |
| @solana/transaction-introspection | 8.3.0 | MIT |
| @solana/transaction-messages | 8.3.0 | MIT |
| @solana/transactions | 8.3.0 | MIT |
| chalk | 5.6.2 | MIT |
| commander | 15.0.0 | MIT |
| fastestsmallesttextencoderdecoder | 1.0.22 | CC0-1.0 |
| typescript | 5.9.3 | Apache-2.0 |
| undici-types | 8.11.2 | MIT |
| ws | 8.22.0 | MIT |

Also shipped or derived:

| Component | Version | License | Copyright / notice |
|---|---|---|---|
| raydium-cp-swap (derived files in `packages/engine`: the qf-pool IDL and the swap-math port `src/pool-math.ts`) | `b3187ae` | Apache-2.0 | Copyright Raydium; modifications by Project QF (2026-10-11). LICENSE and NOTICE in `packages/engine/third_party/raydium-cp-swap/` |
| Bricolage Grotesque, Geist, Geist Mono web fonts (`@fontsource-variable/*`, copied into the browser build) | see `LICENSE-MANIFEST.json` | OFL-1.1 | exact exceptions QF-LIC-EX-003..005; licence texts in `licenses/@fontsource-variable/` and shipped next to each font |

No Meteora code, SDK or program is included or distributed.

Rewards Merkle format note (2026-09-27): `packages/rewards` computes leaves and sorted-pair keccak parents in the format of the Solana Foundation Rewards program at `df7517d` (MIT). This is an independent implementation of that format, with no copied source.

## Database gateway (deploy/supabase/qf-db, Supabase Edge Function only; not part of any app or package build)

- `postgres` 3.4.5 (porsager/postgres) — The Unlicense. Loaded by the Supabase runtime as `npm:postgres@3.4.5`.
- `jose` 5.9.6 (panva/jose) — MIT License, Copyright (c) 2018 Filip Skokan. Loaded by the Supabase runtime as `npm:jose@5.9.6`.
