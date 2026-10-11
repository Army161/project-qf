// Compiles engine instructions into an unsigned legacy transaction (Solana Kit; browser-safe). The bytes carry
// zeroed signature slots for every required signer: the user's wallet, and for a new coin the mint's fresh key,
// fill them in. Nothing here holds or uses a key.
import {
  address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getTransactionEncoder, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type Instruction,
} from '@solana/kit';
import { computeUnitLimitIx } from './instructions.ts';

export interface UnsignedTx {
  /** Wire bytes (signatures zeroed). */
  bytes: Uint8Array;
  /** The accounts that must sign, in signature order (the fee payer first). */
  signers: string[];
  blockhash: string;
  lastValidBlockHeight: bigint;
}
const MAX_TX_BYTES = 1232;

export function compileUnsigned(p: { feePayer: string; blockhash: string; lastValidBlockHeight: bigint; instructions: Instruction[]; computeUnits?: number }): UnsignedTx {
  const ixs = p.computeUnits === undefined ? p.instructions : [computeUnitLimitIx(p.computeUnits), ...p.instructions];
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(address(p.feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: p.blockhash as Blockhash, lastValidBlockHeight: p.lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = compileTransaction(message);
  const bytes = new Uint8Array(getTransactionEncoder().encode(tx));
  if (bytes.length > MAX_TX_BYTES) throw new RangeError(`transaction is ${bytes.length} bytes (limit ${MAX_TX_BYTES})`);
  return { bytes, signers: Object.keys(tx.signatures), blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight };
}
