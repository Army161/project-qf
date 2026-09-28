// MOCK labelling. Anything synthetic carries a non-enumerable-proof, frozen label
// so no UI or report can present it as a live blockchain result.
export const MOCK_BANNER = 'MOCK DATA: synthetic fixtures, not live blockchain results. No wallet, no RPC, no transactions.';

export interface MockLabel { readonly label: 'MOCK'; readonly live: false; readonly note: string }
export type Mocked<T> = T & { readonly __mock: MockLabel };

export function labelMock<T extends object>(value: T, note: string): Mocked<T> {
  return Object.freeze({ ...value, __mock: Object.freeze({ label: 'MOCK', live: false, note }) }) as Mocked<T>;
}

export function isMock(v: unknown): v is Mocked<object> {
  return typeof v === 'object' && v !== null && (v as { __mock?: MockLabel }).__mock?.label === 'MOCK';
}

export function assertNotMock(v: unknown): void {
  if (isMock(v)) throw new Error(`refusing to treat MOCK value as live: ${v.__mock.note}`);
}
