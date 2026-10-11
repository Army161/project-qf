// Wallet Standard discovery and signing, hand-rolled from the published protocol (no wallet SDK in the bundle).
// A wallet announces itself with `wallet-standard:register-wallet`; the app announces itself with `wallet-standard:app-ready`.
// We use only `standard:connect` and `solana:signTransaction`; the wallet signs the exact bytes the page verified.

export interface WalletAccount { address: string; publicKey: Uint8Array; chains: readonly string[]; features: readonly string[] }
export interface StandardWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly WalletAccount[];
  features: Record<string, any>;
}

export const DEVNET_CHAIN = 'solana:devnet';
let CHAIN = DEVNET_CHAIN;
/** The Wallet Standard chain the page signs for: the network the launchpad server runs on (set once at boot). */
export const setWalletCluster = (cluster: 'devnet' | 'localnet') => { CHAIN = `solana:${cluster}`; };
const wallets = new Set<StandardWallet>();
const listeners = new Set<() => void>();
const usable = (w: StandardWallet) => !!w.features['standard:connect'] && !!w.features['solana:signTransaction'];

const api = Object.freeze({
  register(...ws: StandardWallet[]) {
    for (const w of ws) if (usable(w)) wallets.add(w);
    listeners.forEach((f) => f());
    return () => { for (const w of ws) wallets.delete(w); listeners.forEach((f) => f()); };
  },
});

let started = false;
export function startWalletDiscovery() {
  if (started) return;
  started = true;
  window.addEventListener('wallet-standard:register-wallet', ((e: CustomEvent<(a: typeof api) => void>) => {
    try { e.detail(api); } catch { /* a misbehaving wallet must not break the page */ }
  }) as EventListener);
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
}
export const listWallets = () => [...wallets];
export const onWalletsChanged = (f: () => void) => { listeners.add(f); return () => listeners.delete(f); };

export interface Connected { wallet: StandardWallet; account: WalletAccount }

export async function connect(w: StandardWallet): Promise<Connected> {
  const r = await w.features['standard:connect'].connect();
  const accounts: WalletAccount[] = (r?.accounts ?? w.accounts) as WalletAccount[];
  const account = accounts.find((a) => a.chains.includes(CHAIN)) ?? accounts[0];
  if (!account) throw new Error('the wallet returned no account');
  return { wallet: w, account };
}
export async function disconnect(c: Connected) {
  try { await c.wallet.features['standard:disconnect']?.disconnect(); } catch { /* ignore */ }
}

/** Asks the wallet to sign exactly `tx` (wire bytes) for the server's network and returns the signed wire bytes. */
export async function signTransaction(c: Connected, tx: Uint8Array): Promise<Uint8Array> {
  const out = await c.wallet.features['solana:signTransaction'].signTransaction({ account: c.account, transaction: tx, chain: CHAIN });
  const signed = Array.isArray(out) ? out[0]?.signedTransaction : out?.signedTransaction;
  if (!(signed instanceof Uint8Array)) throw new Error('the wallet did not return a signed transaction');
  return signed;
}
