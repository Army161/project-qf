// Web Worker: computes the MOCK reward epoch off the main thread using the real QF reward code.
import { computeEpochAllocations, ALLOCATION_POLICY_V0_TEST } from '@project-qf/rewards';
import { holders, exclusions } from './fixtures.ts';

self.onmessage = (e: MessageEvent<{ fundedRaw: string }>) => {
  const r = computeEpochAllocations({ epochId: 'MOCK-2026-09-27', window: { start: 1000, end: 2000 }, fundedRaw: BigInt(e.data.fundedRaw),
    carryIn: {}, holders, exclusions, policy: ALLOCATION_POLICY_V0_TEST });
  (self as unknown as Worker).postMessage({ mock: true, rootHex: r.merkle.rootHex, fileHash: r.allocationFileHash,
    payouts: r.payouts.map((p) => [p.owner, p.amountRaw.toString()]), poolRollForwardRaw: r.poolRollForwardRaw.toString() });
};
