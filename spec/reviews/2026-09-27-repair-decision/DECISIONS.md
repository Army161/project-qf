# Technical decisions — adopt through the owner workflow

## Four requested decisions

1. **SEC-A:** Accept the five exact, version- and path-bound technical dispositions for the internal Node V0 adapter, subject to artifact integrity and reported regression checks remaining valid. This is not a blanket security waiver or approval of devnet/mainnet execution. Retain owner signoff separately; do not impersonate Jeremy or invent an approval timestamp.
2. **Network:** Recommend the owner's ordinary local computer/network, using public Solana mainnet/devnet RPC for read-only account evidence and OtterSec for status. Do not bypass the sandbox proxy, disable TLS, use an anonymity service, or open unrestricted cloud egress. See NETWORK-RUNBOOK.md.
3. **Config:** The exact authority equality is CONFIRMED_FOR_PINNED_SOURCE. It remains LIVE_UNVERIFIED. The selected Customizable path additionally requires Dynamic config type (1); authority equality alone is insufficient. See CONFIG-COMPATIBILITY.md.
4. **Meteora inquiry:** Recommend sending the revised minimal inquiry. It is NOT SENT. Clarify U.S. developer eligibility, separate integration terms, and local-copy licensing before applicable integration activity. Source/API licensing and service eligibility are separate questions.

## SEC-A decisions
| Advisory | Exact target | Accepted disposition | Conditions |
|---|---|---|---|
| GHSA-3gc7-fjrx-p6mg | bigint-buffer 1.1.5 with recorded pnpm patch | MITIGATED_PATCHED | Confirm patched entrypoint remains the runtime entrypoint; no vulnerable native loader; preserve original licence/patch notice; range-check integers to their actual u64/u128/other schema widths. Not an upstream fixed release. |
| GHSA-82x6-q7mm-w9cf | toml 4.2.0 via anchor 0.31.1 override | FIXED_BY_SCOPED_OVERRIDE | Preserve Anchor Buffer-input compatibility test and depth regression test. Major-version override needs revalidation whenever consumer changes. |
| GHSA-v5mp-jgw5-2x6j | same toml 4.2.0 | FIXED_BY_SCOPED_OVERRIDE | Preserve prototype-pollution regression and installed-version proof. |
| GHSA-w5hq-g745-h8pq | uuid 8.3.2 through jayson 4.3.0 | NOT_AFFECTED_PATH_SPECIFIC | Only v4() without caller buffer in reviewed path. A new v3/v5/v6 call or dependant invalidates this conclusion. |
| GHSA-528h-pc64-c93x | stream-json 1.9.1 through reviewed jayson paths | NOT_AFFECTED_PATH_SPECIFIC | No affected path filters invoked; preserve installed-artifact/import evidence. Independent transport resource limits still require repair. |

These acceptances are based on source/patch inspection, the uploaded installed-artifact test evidence, and the advisory scopes. The installed SEC-A tests were not independently rerun in this review. Keep the raw audit red and visible alongside dispositions; never rewrite it as a zero-advisory scan.

Retain 2026-12-27 as the latest review-by date, not guaranteed validity until then. Any lockfile, patch, runtime, import path, deployment target, package licence, advisory, browser boundary or mitigating-control change triggers an earlier review. Optional-native dependency removal changes the lockfile and therefore requires refreshing the disposition evidence before continued reliance.

## Optional ws accelerators
Decision: remove/disable optional bufferutil and utf-8-validate in V0 server application artifacts. This does NOT ban Node's native internals or separately reviewed development tools.

The actual dependency graph contains ws 7.5.13 and 8.22.0. The older tagged implementations load those accelerators without consulting the newer WS_NO_* environment flags. Therefore environment variables alone are not sufficient for the complete graph.

Review and apply pnpm 10's supported optional-dependency exclusion at the workspace root:

```yaml
ignoredOptionalDependencies:
  - bufferutil
  - utf-8-validate
```

Clean-install with scripts disabled. Verify there are no nonoptional paths before assuming this is sufficient. Prove the target artifacts do not contain/load these packages, test both ws versions' fallbacks, and rerun adapter/boundary/SBOM/licence/security checks. Environment flags may remain defence in depth; do not rely on them alone. Do not indiscriminately remove all optional dependencies.

## Two remaining bounded code changes

### CFG-TYPE: route-specific config compatibility
The fully decoded config passes the current compatibility predicate whenever its authority matches, even with type 0 or unknown 255. Synthetic full 328-byte fixtures demonstrated this. For the selected Customizable route require type 1 and the pinned authority, plus owner/layout/cluster and relevant route parameters. A static config may be useful for another explicitly supported route; never globally reject or approve all static configs without route context.

### BODY-LIMIT: reject before complete buffering
The adapter's createBoundedFetch checks Content-Length, then awaits arrayBuffer(), then checks actual size. In the synthetic test, a 1,024-byte cap consumed the entire 32,768-byte body before rejection; cancellation was not triggered. This is a post-download size check, not a streaming memory cap.

Implement incremental byte counting before accumulation, cancel/abort on overflow, and apply a timeout through the entire body lifetime. Test absent/false headers, slow streams, abort cleanup, chunk boundaries, and oversized/error bodies. Inspect the verifier's res.text()/compressed-account path too: configure per-operation HTTP, base64 and decompressed-output bounds so legitimate program accounts are not rejected by an arbitrary shared cap. Do not treat Content-Length or compressed size as a sufficient decoded-size limit.

This transport fix is independent of whether stream-json's specific filter vulnerability is reachable. Do not undo the path-specific advisory conclusion or claim it covers general network-resource exhaustion.

## Stage outcomes
- OFFLINE_V0: continue existing scoped work.
- READ_ONLY_VERIFICATION: permit owner-run evidence collection after network authorization; incomplete/failed runs remain incomplete. Config compatibility must be tested correctly before a passing status is issued.
- LOCALNET: existing source/binary-copy permission, provenance and tooling gates remain.
- DEVNET: existing cluster safety, service eligibility/terms, SEC-A adoption and integration gates remain.
- MAINNET: unchanged and blocked. No keys/signing/send paths are authorized by this review.

A diagnostic may gather evidence needed to resolve uncertainty; it need not already have proven the uncertainty false before it is allowed to read. Collection authorization and successful verification are different states.
