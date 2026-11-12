// Reads the engine's events from a transaction's log messages (browser-safe). Anchor's emit! writes each event as a
// "Program data: <base64>" line: an 8-byte discriminator, then the Borsh-encoded event. A line is attributed to the
// program running when it was written (tracked through the invoke/success lines, so events from the pool program
// inside a graduation are told apart from the curve's). Only qf-curve and qf-pool lines are decoded; an event from
// either program that the pinned IDL does not know throws, so a format change can never be skipped silently.
import { getBase64Decoder, getBase64Encoder } from '@solana/kit';
import { decodeFields, sameBytes, CodecError, type EngineIdl, type Value } from './codec.ts';
import { CURVE_IDL, POOL_IDL } from './idl.ts';
import type { LaunchConfig } from './config.ts';
import { QF_CURVE, QF_POOL } from './programs.ts';

export interface LaunchCreatedEvent { name: 'LaunchCreated'; mint: string; creator: string; coinName: string; symbol: string; uri: string; config: LaunchConfig }
export interface TradeEvent {
  name: 'TradeEvent'; mint: string; trader: string; isBuy: boolean;
  /** Quote the trader paid (buy, fee included) or received (sell, after the fee). */
  quoteAmount: bigint; baseAmount: bigint; platformFee: bigint; creatorFee: bigint;
  /** The curve's state after the trade. */
  realQuote: bigint; baseSold: bigint; complete: boolean;
}
export interface GraduatedEvent { name: 'Graduated'; mint: string; pool: string; quoteToPool: bigint; baseToPool: bigint; graduationFee: bigint; lpBurned: bigint }
export interface FeesClaimedEvent { name: 'FeesClaimed'; mint: string; to: string; amount: bigint; creator: boolean }
export interface PoolConfigChangedEvent { name: 'PoolConfigChanged'; mint: string; ammConfig: string }
/** A sold-out coin that did not graduate within the grace period is trading again (selling reopened it). */
export interface CurveReopenedEvent { name: 'CurveReopened'; mint: string; completedAt: bigint }
/** The settings for one quote changed (initialize, update_global, accept_admin). */
export interface GlobalUpdatedEvent {
  name: 'GlobalUpdated'; quoteMint: string; admin: string; pendingAdmin: string; feeRecipient: string; ammConfig: string; createPaused: boolean; buyPaused: boolean; config: LaunchConfig;
}
export interface PoolSwapEvent {
  name: 'SwapEvent'; poolId: string; inputVaultBefore: bigint; outputVaultBefore: bigint; inputAmount: bigint; outputAmount: bigint;
  inputTransferFee: bigint; outputTransferFee: bigint; baseInput: boolean; inputMint: string; outputMint: string; tradeFee: bigint; creatorFee: bigint; creatorFeeOnInput: boolean;
}
export interface LpChangeEvent { name: 'LpChangeEvent'; [field: string]: Value }
export type EngineEvent = (LaunchCreatedEvent | TradeEvent | GraduatedEvent | FeesClaimedEvent | PoolConfigChangedEvent | CurveReopenedEvent | GlobalUpdatedEvent | PoolSwapEvent | LpChangeEvent) & {
  /** The program that wrote the event, and its call depth (1 = called by the transaction itself). */
  program: string; depth: number;
};

const fromB64 = getBase64Encoder(), toB64 = getBase64Decoder();
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Strict base64 (Kit's decoder skips bad tails and anything after padding): canonical text only. */
function base64Bytes(s: string): Uint8Array {
  if (!B64.test(s)) throw new CodecError('event data is not base64');
  const b = fromB64.encode(s) as Uint8Array;
  if (toB64.decode(b) !== s) throw new CodecError('event data is not canonical base64');
  return b;
}
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const camelize = (v: Record<string, Value>): Record<string, Value> =>
  Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), x !== null && typeof x === 'object' && !Array.isArray(x) ? camelize(x) : x]));
const launchConfig = (c: Record<string, Value>): LaunchConfig => ({ ...(c as unknown as LaunchConfig), tradeFeeBps: BigInt(c.tradeFeeBps as number), creatorFeeShareBps: BigInt(c.creatorFeeShareBps as number) });

function decodeEvent(idl: EngineIdl, bytes: Uint8Array): Record<string, Value> & { name: string } {
  for (const [name, e] of Object.entries(idl.events)) {
    if (bytes.length >= 8 && sameBytes(bytes.subarray(0, 8), e.discriminator)) {
      const v = camelize(decodeFields(bytes.subarray(8), e.fields, idl.types));
      if (name === 'LaunchCreated') { const { name: coinName, ...rest } = v; return { ...rest, coinName, config: launchConfig(rest.config as Record<string, Value>), name } as never; }
      if (name === 'GlobalUpdated') return { ...v, config: launchConfig(v.config as Record<string, Value>), name } as never;
      return { ...v, name };
    }
  }
  throw new CodecError(`unknown ${idl.provenance.idlName} event`);
}

export interface ParsedLogs {
  events: EngineEvent[];
  /** The node cut the log short ("Log truncated"): events after the cut are missing. */
  truncated: boolean;
}
/** Every qf-curve and qf-pool event in a transaction's log messages, in order. */
export function parseEngineEvents(logs: readonly string[]): ParsedLogs {
  const stack: string[] = [];
  const events: EngineEvent[] = [];
  let truncated = false;
  for (const line of logs) {
    let m: RegExpExecArray | null;
    if ((m = /^Program (\w+) invoke \[(\d+)\]$/.exec(line))) {
      if (Number(m[2]) !== stack.length + 1) throw new CodecError(`log invoke depth ${m[2]} after depth ${stack.length}`);
      stack.push(m[1]!);
    } else if ((m = /^Program (\w+) (success|failed.*)$/.exec(line))) {
      if (stack.pop() !== m[1]) throw new CodecError(`log closes ${m[1]} out of order`);
    } else if (line.startsWith('Program data: ')) {
      const program = stack.at(-1);
      if (program !== QF_CURVE && program !== QF_POOL) continue;
      const parts = line.slice('Program data: '.length).split(' ');
      if (parts.length !== 1) throw new CodecError('engine events are one data slice');
      events.push({ ...decodeEvent(program === QF_CURVE ? CURVE_IDL : POOL_IDL, base64Bytes(parts[0]!)), program, depth: stack.length } as EngineEvent);
    } else if (line === 'Log truncated') {
      truncated = true;
      break;
    }
  }
  return { events, truncated };
}
