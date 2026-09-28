# Owner-run read-only evidence collection

## Selected environment
Recommend Jeremy's own local computer and ordinary authorized network, not the blocked Claude cloud sandbox. No VPN/geographical workaround, TLS bypass, proxy evasion or broad egress changes. An alternative is an administrator's explicit per-host authorization for the existing sandbox.

Runtime hosts:
- api.mainnet.solana.com — mainnet public ledger observations
- api.devnet.solana.com — devnet public ledger observations
- verify.osec.io — read-only build-status queries

Package installation may separately need registry.npmjs.org. Keep installation distinct from the diagnostic's runtime network allowance. Use the existing tested Node 22.22.2 and pnpm 10.33.0 toolchain where available; do not silently substitute versions or install globally with unnecessary privilege.

Mainnet-beta and mainnet aliases are not independent providers. A genuine second provider is optional for collection and must be separately approved; if its observed state disagrees, preserve that disagreement rather than treating it like unavailability.

## Existing CLI
From the extracted uploaded workspace root, inspect README.md and the actual flags first. The existing flags are --mainnet, --mainnet2, --devnet, --out.

Run each step only after the preceding step succeeds:

```sh
cd spec/tools/program-verify
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
node verify-programs.mjs --mainnet https://api.mainnet.solana.com --devnet https://api.devnet.solana.com --out ./verification-results
```

This single-line node command also avoids shell-specific line continuations. Do not paste paid RPC secrets into a command line, history, report, or chat. The current verifier intentionally has no protected credential-input mechanism; do not pretend that it does.

## Authorized operation envelope
Collect only getGenesisHash, getVersion and getAccountInfo via RPC and read-only OtterSec status requests as already implemented. No wallet connection, key generation, airdrop, simulation, signing, transaction submission or on-chain attestation. Keep cluster identities bound to genesis, not hostname.

Save context slots, endpoint origin labels, per-check outcomes, inventory, account owners/layouts, ProgramData information and upgrade authorities. Keep any returned program material subject to the existing artifact-copy policy; do not turn the diagnostic into a local executable deployment/cache workflow.

## Reporting
A network error is not a missing/deprecated program. Source confirmation does not prove deployed parity. An unverified-build status is not by itself a mismatch. A matching build is not an audit. Exit 0 covers only the implemented read-only checks and only if their inventory/semantic requirements are correct; it cannot unlock devnet/mainnet automatically.

Collection can begin to obtain facts even while a result is expected to be incomplete. Apply the bounded config-type and input-resource repairs before treating the output as a complete passing verification or running it unattended.

This review attempted getGenesisHash requests; they failed DNS resolution. Nothing on chain was verified. See evidence/network-probes.json. The uploaded report independently records cloud proxy 403 errors; those are different environmental observations.

Meteora service eligibility and commercial/local-copy permissions remain separate from authorization to run this public-ledger diagnostic. See the unsent inquiry; do not treat networking permission as contractual clearance.
