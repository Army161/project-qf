# bigint-buffer exit path — bounded roadmap answer

## Direct answer to Claude
No maintained drop-in replacement for the exact current Meteora SDK pair has been independently verified in this review. No package/version should be presented as a ready production substitute.

## Keep now
Keep the reviewed, patched bigint-buffer implementation isolated in the existing Node-only adapter for the approved V0 scope. Preserve width checks, patch integrity, raw audit and disposition expiry/triggers. Do not extend this automatically to production.

## Candidate engineering paths, not adopted changes
1. Prefer a future official Meteora dependency update that actually removes every introducing path. Replacing a wrapper or adding Kit compatibility does not demonstrate removal.
2. If upstream does not provide one, evaluate a bounded client-layer replacement using permitted SDK IDLs, modern Solana client/codecs and independently validated transaction/account handling. Existing QF pin @solana/kit@8.3.0 is a candidate building block, not a verified drop-in engine replacement. Preserve exact curve/fee/transaction parity and enforce licence provenance; do not port the non-commercial on-chain program source.
3. Start with a proof for one narrow read/decode or instruction-build path, not a new AMM, engine, or all-at-once rewrite. Record remaining transitive edges after each result.

Acceptance: no bigint-buffer in the resolved production dependency closure or final runtime artifacts; relevant arithmetic, overflow, signed/unsigned width, SDK parity and serialized-instruction tests pass; raw audit and SBOM reflect the actual graph. A scanner rename, package alias or retained transitive copy is not removal.

Primary references:
- Official Solana Kit integer codec: https://www.solanakit.com/api/functions/getU64Codec
- Official Solana program clients: https://github.com/solana-program/token
- Meteora Kit compatibility proposal (not proof of dependency elimination): https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/pull/101
- Existing upstream dependency declarations: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/main/packages/dynamic-bonding-curve/package.json

This roadmap investigation should not block the QF-original read-only product milestone. Any production requirement to remove the high finding remains unchanged until explicitly reviewed.
