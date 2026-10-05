// TEST_ONLY helpers for the Squads treasury: the VaultTransaction account the program would store for a proposal,
// serialized by the Squads SDK's own generated serializer (so decoders are checked against the program's format).
import BN from 'bn.js';
import * as sq from '@sqds/multisig';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { squads } from '@project-qf/tx';

export function storedVaultTransaction(createIx: { data: Buffer | Uint8Array } | TransactionInstruction, o: { multisig: PublicKey | string; creator: PublicKey | string; index: bigint; vaultIndex?: number; bumps?: readonly number[] }): Uint8Array {
  const [args] = sq.generated.vaultTransactionCreateStruct.deserialize(Buffer.from(createIx.data));
  const m = squads.decodeCompactMessage(new Uint8Array(args.args.transactionMessage));
  const acct = sq.generated.VaultTransaction.fromArgs({ multisig: new PublicKey(o.multisig), creator: new PublicKey(o.creator), index: new BN(o.index.toString()), bump: 255,
    vaultIndex: o.vaultIndex ?? args.args.vaultIndex, vaultBump: 254, ephemeralSignerBumps: Uint8Array.from(o.bumps ?? []),
    message: { numSigners: m.numSigners, numWritableSigners: m.numWritableSigners, numWritableNonSigners: m.numWritableNonSigners, accountKeys: m.accountKeys.map((k) => new PublicKey(k)),
      instructions: m.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accountIndexes: Uint8Array.from(ix.accountIndexes), data: Buffer.from(ix.dataHex, 'hex') })), addressTableLookups: [] } });
  return new Uint8Array(acct.serialize()[0]);
}
