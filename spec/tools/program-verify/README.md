# program-verify (read-only)

Reads Solana cluster state for the programs and configs Project QF depends on. It never signs, sends or simulates a transaction, never loads a key, never publishes an on-chain verification attestation, and reads no environment variables.

## Run it (only from an owner-authorized environment with RPC egress)

```sh
cd spec/tools/program-verify
pnpm install --frozen-lockfile --ignore-scripts      # one MIT dependency tree: @solana/addresses 8.3.0
pnpm test                                            # 55 offline negative/contract tests (v0.4.0), labelled fake RPC only
node verify-programs.mjs                             # public endpoints (defaults below)
node verify-programs.mjs --mainnet <RPC_A> --mainnet2 <RPC_B> --devnet <RPC_C> [--out <dir>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--mainnet` | `https://api.mainnet-beta.solana.com` | primary mainnet RPC (reads only) |
| `--mainnet2` | none | optional second, independent mainnet RPC for CROSS_CHECK |
| `--devnet` | `https://api.devnet.solana.com` | devnet RPC |
| `--out` | `../../docs/verification` relative to this script | output directory |

No other flags exist; unknown flags exit 64. URLs must be `https` (plain `http` only for localhost). Endpoints are written as `scheme://host[:port]` only: userinfo, path (API keys often live there), query and fragment are dropped from the report, the console and nested error causes. Do not put secret-bearing URLs in shell history; the verifier deliberately provides no secret-input mechanism (a protected one must be designed explicitly before use). Solana's cluster docs also list `https://api.mainnet.solana.com`; whichever endpoint is used, the cluster is identified by its genesis hash, never by the hostname.

**Behind an HTTP proxy.** Node's `fetch` ignores `HTTPS_PROXY` unless started with `node --use-env-proxy verify-programs.mjs …` (Node ≥ 22.21). Never disable TLS verification. The proxy must allow the RPC hosts and `verify.osec.io`.

**Allowed hosts.** The environment needs HTTPS egress to exactly the RPC hosts you pass and `verify.osec.io`.

## Output

`PROGRAM-VERIFICATION-YYYY-MM-DD.json` and `.md`. Each check carries its own status:

| Check | Status values | Meaning |
|---|---|---|
| CONNECTIVITY | PASS / FAIL | the endpoint answered `getGenesisHash` |
| CLUSTER_IDENTITY | PASS / FAIL / UNKNOWN | genesis equals the published hash; on FAIL nothing else from that endpoint is trusted |
| PROGRAM_PRESENCE | PASS / FAIL / UNKNOWN | program account exists (finalized) |
| LOADER_STATE | PASS / FAIL / UNKNOWN | executable and owned by BPFLoaderUpgradeable |
| PROGRAMDATA | PASS / FAIL / UNKNOWN / ERROR | ProgramData account decodes; the program account must be exactly 36 bytes; an authority option tag other than 0/1 is FAIL, never "immutable" |
| UPGRADE_AUTHORITY | RECORDED / UNKNOWN | the authority key, or null if immutable; who controls it is not established |
| DEPLOY_SLOT | RECORDED / UNKNOWN | last deploy slot |
| EXECUTABLE_HASH | RECORDED / UNKNOWN | sha256 of the trimmed executable; does not identify a release |
| INTERFACE | RECORDED / UNKNOWN | on-chain Anchor IDL; `has_create_config2` is an indicator only |
| CONFIG | PASS / FAIL / UNKNOWN / ERROR | DAMM v2 migration config exists, owned by DAMM v2, exactly 328 bytes, and every field decodes against the pinned layout (`layouts/damm-v2-config-layout.json`, sha256 `cf446496…caf4`); decoded fields are recorded |
| CONFIG_COMPATIBILITY | PASS / FAIL / UNKNOWN / NOT_ASSESSED | route-specific (v0.4.0). Customizable: `pool_creator_authority` equals the DBC pool authority `FhVo3mqL…HLuM` **and** `config_type` is 1 (Dynamic); 0 (Static) or an unknown enum is FAIL. Both rules are confirmed for the pinned sources and the PDA was derived offline; the row itself is the live observation. Fixed-fee routes: NOT_ASSESSED (outside V0), values recorded |
| CROSS_CHECK | PASS / DISAGREEMENT / UNAVAILABLE | with `--mainnet2`: same genesis, authority and hash. A difference is re-read once at `minContextSlot` = the higher slot; a persisting difference is DISAGREEMENT, an unreachable second provider is UNAVAILABLE (never PASS) |
| SOURCE_BUILD | NOT_ATTEMPTED | OtterSec status recorded; `is_verified=false` is not a demonstrated mismatch; no reproducible build until licence permission (LOCAL-1) |
| AUDIT_COVERAGE | NOT_EVALUATED | a source match is not a security audit |

Required: CONNECTIVITY, CLUSTER_IDENTITY, and for DBC and DAMM v2 PROGRAM_PRESENCE, LOADER_STATE, PROGRAMDATA, UPGRADE_AUTHORITY, EXECUTABLE_HASH, plus CONFIG and CONFIG_COMPATIBILITY for the Customizable config, plus CROSS_CHECK when `--mainnet2` is given. A required check that is FAIL, UNKNOWN or ERROR is never reported as satisfied.

**v0.3.0 (2026-09-27 repair pass).** Report schema `qf-program-verify-report/2`. The expected check inventory is computed from the flags, independently of the results; a missing, duplicated or unexpected check is a required failure. Every read uses commitment `finalized` and records its `contextSlot`. An RPC failure on one read yields ERROR for that check only; other checks still run.

**v0.4.0 (2026-09-27 decision review).** Report schema `qf-program-verify-report/3`. CONFIG_COMPATIBILITY is route-specific (above). Response bodies are bounded per operation while they stream, and the stream is cancelled on overflow: genesis/version 64 KiB; small account reads (program account, configs) 64 KiB of JSON and 16 KiB of decoded data; large reads (ProgramData, IDL) 15 MiB of JSON and 10 MiB of decoded data (the Solana maximum account size); the IDL's inflated output 8 MiB; OtterSec status 64 KiB. One 30 s deadline covers each request and its whole body.

Exit codes: `0` the inventory is complete and every required check is satisfied · `2` nothing contradicts, but a cluster, the second provider or a read was unavailable · `3` a required check failed, disagreed, is unknown, missing, duplicated or unexpected · `64` usage error. Exit 0 establishes on-chain state only; it is not a source match, an audit, or readiness for any stage.
