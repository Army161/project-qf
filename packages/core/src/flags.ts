// Capability flags (ARCHITECTURE.md §4). Values are fixed in code for V0; changing
// one is an ADR-level decision, not configuration.
export const CAPABILITY_FLAGS = Object.freeze({
  REWARDS_SETTLEMENT_MAINNET: false,              // ADR-004
  JUPITER_PROVIDER: 'OPTIONAL_LEGAL_GATED',       // ADR-005: off until legal clearance
  MAINNET_WRITES: false,                          // DEPLOYMENT.md mainnet gate
} as const);

export type CapabilityFlag = keyof typeof CAPABILITY_FLAGS;

export function isCapabilityEnabled(flag: CapabilityFlag): boolean {
  const v: unknown = CAPABILITY_FLAGS[flag];
  return v === true || v === 'ENABLED';
}

export function assertCapabilityEnabled(flag: CapabilityFlag): void {
  if (!isCapabilityEnabled(flag)) {
    throw new Error(`capability ${flag} is disabled or gated (${String(CAPABILITY_FLAGS[flag])})`);
  }
}
