// Shapes of the pinned IDL subset (Anchor 0.30 IDL JSON, as bundled in the MIT SDK package).
export type IdlType = string | { defined?: { name: string }; array?: [IdlType, number]; option?: IdlType; vec?: IdlType };
export interface IdlField { name: string; type: IdlType; docs?: string[] }
export interface IdlTypeDef { kind: 'struct' | 'enum'; fields?: IdlField[]; variants?: unknown[] }
export interface IdlAccountMeta { name: string; writable: boolean; signer: boolean; optional: boolean; address: string | null }
export interface IdlInstruction { name: string; discriminator: number[]; accounts: IdlAccountMeta[]; args: IdlField[] }
export interface IdlSubset {
  provenance: { package: string; license: string; idlName: string; idlVersion: string; programId: string; fullIdlSha256: string };
  instructions: IdlInstruction[];
  types: Record<string, IdlTypeDef>;
  /** Account discriminators, for subsets that also decode program accounts (Squads). */
  accounts?: Record<string, number[]>;
  /** Anchor self-CPI events (emit_cpi): discriminator and fields, for subsets the indexer reads events with (DBC, DAMM v2). */
  events?: Record<string, { discriminator: number[]; fields: IdlField[] }>;
}
