// Devnet launchpad UI. Talks only to the same-origin launchpad API (CSP connect-src 'self') and to the person's wallet
// through Wallet Standard. Every string that came from a creator or from chain data is rendered with textContent.
import { economicsDigest } from '@project-qf/policy';
import { addSignature, fromBase64, generateMintKey, toBase64, type ApprovedTerms } from '@project-qf/tx';
import { ago, compact, explorer, parseUnits, pct, price, setExplorerCluster, short, units } from './format.ts';
import { checkBuiltTransaction, type Check, type Expectation } from './txcheck.ts';
import { connect, disconnect, listWallets, onWalletsChanged, signTransaction, startWalletDiscovery, type Connected } from './wallet.ts';

// ------------------------------------------------------------------ types from lp-api/1
interface ChainCheck { address: string; label: string; status: 'MATCH' | 'MISMATCH' | 'MISSING' | 'SINGLE_PROVIDER' | 'UNAVAILABLE'; value: unknown; slots: number[]; detail?: string }
interface Platform {
  ready: boolean; cluster: 'devnet' | 'mainnet-beta'; mode: 'DEVNET' | 'MAINNET_READ_ONLY'; writesEnabled: boolean; writesLockedBecause: string[]; label: string;
  operator: string | null; readiness: Record<string, string>; mainnetBlockers: string[];
  mainnetQuote: { mint: string; decimals: number; symbol: string } | null;
  chainChecks: { at: string; crossChecked: boolean; ok: boolean; items: ChainCheck[]; problems: string[] } | null;
  platform: null | { quote: { mint: string; decimals: number; symbol: string; label: string }; config: string; threshold: { rawQuoteThreshold: string };
    launchEconomics: any; launchEconomicsDigest: string; economicsVersion: string; templateVersion: string };
  faucet: { quoteUi: string; lamports: string; claimsPerDay: number } | null;
}
interface Live { priceQuotePerBase: string | null; marketCapQuoteRaw: string | null; priceUnavailable?: boolean; launchPriceQuotePerBase?: string; lockedBps?: number | null; quoteReserve: string; migrationQuoteThreshold: string; progressBps: number;
  curveComplete: boolean; isMigrated: boolean; baseDecimals: number; quoteDecimals: number; totalSupplyRaw: string; creatorQuoteFee: string; venue?: 'CURVE' | 'DAMM_V2' }
interface Token { mint: string; pool: string; name: string; symbol: string; description: string; imageUrl: string | null; creator: string; status: string;
  createdAt: string; liveAt: string | null; website: string | null; twitter: string | null; telegram: string | null; createSig: string | null;
  migrationSig: string | null; dammPool: string | null; live: Live | null; stats: { count: number; volumeQuoteRaw: string; traders: number };
  /** transactions the indexer has listed but not read yet (pending) or could not read after many tries (unavailable) */
  history?: { complete: boolean; pending: number; unavailable: number } }
interface Fees { isCreator: boolean; curve: { quoteRaw: string; baseRaw: string } | null;
  positions: { position: string; nftMint: string; feeBaseRaw: string; feeQuoteRaw: string; permanentlyLocked: boolean }[] }
/** What a trade paid in fees, from the swap event in its own transaction (PENDING = not read yet, UNKNOWN = could not be proven). */
interface TradeFee { status: 'RESOLVED' | 'UNKNOWN' | 'PENDING'; evidence: string | null; totalRaw: string | null; creatorRaw: string | null; platformRaw: string | null;
  lpRaw: string | null; protocolRaw: string | null; referralRaw: string | null; compoundingRaw: string | null }
interface Trade { sig: string; trader: string; side: 'BUY' | 'SELL'; quoteRaw: string; baseRaw: string; slot: number; blockTime: number | null; venue?: 'CURVE' | 'DAMM_V2' | null; fees?: TradeFee }

class ApiError extends Error { code: string; details: string[]; constructor(code: string, m: string, d: string[] = []) { super(m); this.code = code; this.details = d; } }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j?.error?.code ?? `HTTP_${r.status}`, j?.error?.message ?? r.statusText, j?.error?.details ?? []);
  return j as T;
}

// ------------------------------------------------------------------ tiny DOM helper (text only, no innerHTML)
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v); // CSSOM, not a style attribute: the page CSP has no 'unsafe-inline'
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const ext = (href: string, text: string, cls = '') => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
/** Stroke icon from path data (no innerHTML). */
function icon(paths: string[], size = 18, color = 'currentColor') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
  for (const d of paths) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}
const ICON = {
  shield: ['M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z', 'm9 12 2 2 4-4'],
  copy: ['M9 9h11v11H9z', 'M5 15V5a2 2 0 0 1 2-2h8'],
  image: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'm21 15-5-5L5 21', 'M9 7.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z'],
};

// ------------------------------------------------------------------ state
type Sort = 'traded' | 'new' | 'progress' | 'graduated';
const state: { platform: Platform | null; wallet: Connected | null; balances: { lamports: string; tokens: Record<string, string> } | null; tokens: Token[]; sort: Sort; query: string } =
  { platform: null, wallet: null, balances: null, tokens: [], sort: 'traded', query: '' };
const Q = () => state.platform?.platform?.quote ?? (state.platform?.mainnetQuote ? { ...state.platform.mainnetQuote, label: 'mainnet' } : { mint: '', decimals: 6, symbol: 'qUSD', label: 'TEST_ONLY' });
const isMainnet = () => state.platform?.cluster === 'mainnet-beta';
const hasFaucet = () => !!state.platform?.faucet;
/** Market cap text; after graduation it is unknown (not the old curve's) while the DAMM v2 pool cannot be read. */
const mcapText = (l: Live | null) => (l?.marketCapQuoteRaw ? `${compact(l.marketCapQuoteRaw, Q().decimals)} ${Q().symbol}` : '—');
const lockedText = (l: Live | null) => (l?.lockedBps == null ? null : `${(l.lockedBps / 100).toFixed(2)}%`);

function toast(msg: string, kind: 'ok' | 'err' | 'info' = 'info') {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 9000 : 5000);
  return () => t.remove();
}

function avatar(t: Pick<Token, 'mint' | 'symbol' | 'imageUrl'>, size = 'md') {
  if (t.imageUrl) return h('img', { class: `avatar ${size}`, src: t.imageUrl, alt: '' });
  let x = 0;
  for (const c of t.mint) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return h('div', { class: `avatar ${size} gen`, 'data-hue': String(x % 8), 'aria-hidden': 'true' }, t.symbol.slice(0, 2).toUpperCase());
}

// ------------------------------------------------------------------ wallet UI
// The token page's "Balance:" line repaints itself whenever balances are refreshed.
let paintBalance: () => void = () => {};
async function refreshBalances(mint?: string) {
  if (!state.wallet || !state.platform?.ready) { state.balances = null; renderWallet(); return; }
  try { state.balances = await api(`/api/lp/wallet/${state.wallet.account.address}${mint ? `?mint=${mint}` : ''}`); } catch { state.balances = null; }
  renderWallet();
  paintBalance();
}
function renderWallet() {
  const box = $('#wallet');
  box.replaceChildren();
  if (!state.wallet) {
    box.append(h('button', { class: 'btn primary', id: 'connect', onclick: openWalletPicker }, 'Connect wallet'));
    return;
  }
  const q = Q();
  const b = state.balances;
  box.append(...[
    b ? h('span', { class: 'bal', title: `${isMainnet() ? 'mainnet' : 'devnet'} balances` }, `${units(b.tokens[q.mint] ?? '0', q.decimals, 0)} ${q.symbol}`, h('span', { class: 'dim' }, ` · ${units(b.lamports, 9, 3)} SOL`)) : null,
    hasFaucet() ? h('button', { class: 'btn ghost', onclick: claimFaucet, title: 'TEST_ONLY devnet tokens with no value' }, `Get test ${q.symbol}`) : null,
    h('button', { class: 'btn wallet', onclick: async () => { if (state.wallet) await disconnect(state.wallet); state.wallet = null; renderWallet(); } , title: 'Disconnect' },
      h('img', { src: state.wallet.wallet.icon, alt: '', class: 'wicon' }), short(state.wallet.account.address)),
  ].filter((x): x is HTMLElement => !!x));
}
function openWalletPicker() {
  const ws = listWallets();
  const body = ws.length
    ? h('div', { class: 'wlist' }, ...ws.map((w) => h('button', { class: 'wopt', onclick: async () => {
      try { state.wallet = await connect(w); closeModal(); renderWallet(); await refreshBalances(currentMint()); toast(`Connected ${short(state.wallet.account.address)}`, 'ok'); }
      catch (e) { toast(`Wallet: ${(e as Error).message}`, 'err'); }
    } }, h('img', { src: w.icon, alt: '' }), w.name)))
    : h('p', { class: 'dim' }, 'No Solana wallet found. Install a Wallet Standard wallet (for example Phantom, Solflare or Backpack), switch it to devnet, and reload.');
  openModal('Connect a wallet', body);
}
async function claimFaucet() {
  if (!state.wallet) return openWalletPicker();
  const q = Q();
  let pending: (() => void) | undefined;
  try {
    pending = toast(`Requesting test ${q.symbol}…`);
    const r = await api<{ signature: string; quoteRaw: string; lamports: string }>('/api/lp/faucet', { wallet: state.wallet.account.address });
    toast(`Received ${units(r.quoteRaw, q.decimals, 0)} ${q.symbol}${BigInt(r.lamports) > 0n ? ` and ${units(r.lamports, 9, 3)} SOL for fees` : ''}`, 'ok');
    await refreshBalances(currentMint());
  } catch (e) { toast(`Faucet: ${(e as Error).message}`, 'err'); } finally { pending?.(); }
}
const requireWallet = (): Connected | null => { if (!state.wallet) { openWalletPicker(); return null; } return state.wallet; };

// ------------------------------------------------------------------ modal + signing flow
function openModal(title: string, body: Node, opts: { dismissable?: boolean } = {}) {
  const m = $('#modal');
  m.replaceChildren(h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h3', {}, title), opts.dismissable === false ? null : h('button', { class: 'x', onclick: closeModal, 'aria-label': 'Close' }, '×')), body));
  m.hidden = false;
}
function closeModal() { $('#modal').hidden = true; $('#modal').replaceChildren(); }

type StepState = 'todo' | 'run' | 'ok' | 'err';
function stepsView(labels: string[]) {
  const items = labels.map((l) => h('li', { class: 'step todo' }, h('span', { class: 'dot' }), h('span', {}, l)));
  const checks = h('ul', { class: 'checks' });
  const msg = h('p', { class: 'flowmsg' });
  const set = (k: number, s: StepState) => { items[k]!.className = `step ${s}`; };
  return { el: h('div', { class: 'flow' }, h('ol', { class: 'steps' }, ...items), h('div', { class: 'checks-box' }, h('span', { class: 'eyebrow' }, 'Checked in your browser'), checks), msg), set, checks, msg };
}
function renderChecks(ul: HTMLElement, cs: Check[]) {
  ul.replaceChildren(...cs.map((c) => h('li', { class: c.ok ? 'ok' : 'bad' }, h('span', {}, c.label, c.detail && !c.ok ? h('span', { class: 'dim' }, ` (${c.detail})`) : null))));
}

interface Built { intentId: string; transaction: string; terms: ApprovedTerms }
/** build -> verify in browser -> (mint signature) -> wallet signature -> submit. Returns the submit response. */
async function runSigningFlow<T>(title: string, build: () => Promise<Built>, expect: (b: Built) => Expectation, extraSigner?: { address: string; key: CryptoKey }): Promise<T | null> {
  const w = requireWallet();
  if (!w) return null;
  const v = stepsView(['Build the transaction', 'Check it in this browser', 'Sign in your wallet', 'Confirm on devnet']);
  openModal(title, v.el, { dismissable: false });
  let k = 0;
  try {
    v.set(k, 'run');
    const b = await build();
    v.set(k++, 'ok'); v.set(k, 'run');
    let bytes: Uint8Array = fromBase64(b.transaction);
    const r = await checkBuiltTransaction(bytes, b.terms, expect(b));
    renderChecks(v.checks, r.checks);
    if (!r.ok) throw new Error('The transaction did not match what you asked for, so it was not sent to your wallet.');
    v.set(k++, 'ok'); v.set(k, 'run');
    if (extraSigner) bytes = await addSignature(bytes, extraSigner.address, extraSigner.key);
    v.msg.replaceChildren('Approve the request in ', h('strong', {}, w.wallet.name), '. It should say devnet. If any check above had failed, we would have stopped before asking.');
    const signed = await signTransaction(w, bytes);
    v.set(k++, 'ok'); v.set(k, 'run');
    v.msg.textContent = 'Sending and waiting for devnet confirmation…';
    const out = await api<T & { signature: string }>('/api/lp/submit', { intentId: b.intentId, signedTransaction: toBase64(signed) });
    v.set(k, 'ok');
    v.msg.replaceChildren('Confirmed. ', ext(explorer('tx', out.signature), 'View on Solana Explorer'));
    setTimeout(closeModal, 1400);
    return out;
  } catch (e) {
    v.set(k, 'err');
    const err = e as ApiError;
    v.msg.replaceChildren(h('strong', {}, 'Stopped: '), err.message, err.details?.length ? h('span', { class: 'dim' }, ` (${err.details.slice(0, 3).join('; ')})`) : '');
    $('#modal .sheet-head')?.append(h('button', { class: 'x', onclick: closeModal, 'aria-label': 'Close' }, '×'));
    return null;
  }
}

// ------------------------------------------------------------------ views
const currentMint = () => (/^#\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(location.hash)?.[1]);
const isGraduated = (t: Token) => t.status === 'MIGRATED' || !!t.live?.isMigrated;

function progressBar(bps: number, complete: boolean, big = false) {
  return h('div', { class: `bar${complete ? ' done' : ''}${big ? ' big' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(bps / 100)) },
    h('div', { class: 'fill', style: { width: `${Math.min(100, bps / 100)}%` } }));
}
function statusChip(t: Token) {
  if (isGraduated(t)) return h('span', { class: 'chip grad' }, 'Graduated');
  if (t.live?.curveComplete) return h('span', { class: 'chip warn' }, 'Graduating');
  if ((t.live?.progressBps ?? 0) >= 8000) return h('span', { class: 'chip hot' }, 'Hot');
  return h('span', { class: 'chip live' }, 'Bonding');
}
function progressLabel(t: Token) {
  const l = t.live;
  if (!l) return '';
  return isGraduated(t) ? 'Trading on DAMM v2' : l.curveComplete ? 'Curve full, graduating' : `${pct(l.progressBps)} to graduation`;
}

function tokenCard(t: Token) {
  const q = Q();
  const l = t.live;
  return h('a', { class: 'tcard', href: `#/t/${t.mint}` },
    h('div', { class: 'tc-top' }, avatar(t), h('div', { class: 'tc-id' }, h('span', { class: 'tc-name' }, t.name), h('span', { class: 'tc-sym' }, `$${t.symbol}`, statusChip(t)))),
    t.description ? h('p', { class: 'tc-desc' }, t.description) : null,
    h('div', { class: 'tc-stats' },
      h('div', {}, h('span', { class: 'k' }, 'Market cap'), h('span', { class: 'v' }, mcapText(l))),
      h('div', {}, h('span', { class: 'k' }, 'Volume'), h('span', { class: 'v' }, `${compact(t.stats.volumeQuoteRaw, q.decimals)} ${q.symbol}`))),
    l ? progressBar(l.progressBps, l.curveComplete || l.isMigrated) : null,
    h('div', { class: 'tc-foot' }, h('b', {}, progressLabel(t)), h('span', {}, `${ago(t.liveAt ?? t.createdAt)} · by ${short(t.creator)}`)));
}

function featureCard(t: Token) {
  const q = Q();
  const l = t.live!;
  return h('a', { class: 'feature', href: `#/t/${t.mint}` },
    h('div', { class: 'feature-top' }, h('span', { class: 'eyebrow' }, 'Next to graduate'), h('span', { class: 'num dim small' }, `${t.stats.count} ${t.stats.count === 1 ? 'trade' : 'trades'} · ${t.stats.traders} ${t.stats.traders === 1 ? 'trader' : 'traders'}`)),
    h('div', { class: 'feature-id' }, avatar(t, 'xl'), h('div', { class: 'names' }, h('b', {}, t.name), h('span', { class: 'dim' }, `$${t.symbol}`)),
      h('div', { class: 'mcap' }, h('div', { class: 'num' }, mcapText(l)), h('div', { class: 'dim small' }, 'market cap'))),
    progressBar(l.progressBps, false, true),
    h('div', { class: 'tc-foot' }, h('span', {}, h('b', { class: 'num' }, units(l.quoteReserve, q.decimals, 0)), ` of ${units(l.migrationQuoteThreshold, q.decimals, 0)} ${q.symbol} raised`), h('b', { class: 'up' }, pct(l.progressBps))));
}

async function renderTape() {
  const box = $('#tape');
  if (location.hash !== '' && location.hash !== '#/') { box.hidden = true; return; }
  try {
    const { trades } = await api<{ trades: { sig: string; mint: string; symbol: string; trader: string; side: 'BUY' | 'SELL'; quoteRaw: string }[] }>('/api/lp/trades/recent');
    if (trades.length < 3) { box.hidden = true; return; }
    const q = Q();
    const item = (x: typeof trades[number]) => h('a', { class: 'tape-item', href: `#/t/${x.mint}` }, h('span', { class: `side ${x.side === 'BUY' ? 'buy' : 'sell'}` }, x.side === 'BUY' ? 'BUY' : 'SELL'),
      h('span', { class: 'dim' }, short(x.trader)), h('span', {}, `${units(x.quoteRaw, q.decimals, 2)} ${q.symbol}`), h('span', { class: 'up' }, `$${x.symbol}`));
    // two copies so the loop is seamless; the second copy is hidden from screen readers
    const run = h('div', { class: 'tape-run' }, ...trades.map(item), ...trades.map((x) => { const a = item(x); a.setAttribute('aria-hidden', 'true'); a.tabIndex = -1; return a; }));
    box.replaceChildren(run);
    box.hidden = false;
  } catch { box.hidden = true; }
}

function sortedTokens(): Token[] {
  const qy = state.query.trim().toLowerCase();
  let list = state.tokens.filter((t) => !qy || t.name.toLowerCase().includes(qy) || t.symbol.toLowerCase().includes(qy.replace(/^\$/, '')) || t.mint === state.query.trim());
  if (state.sort === 'graduated') list = list.filter(isGraduated);
  if (state.sort === 'progress') list = list.filter((t) => !isGraduated(t));
  const key = (t: Token) => state.sort === 'traded' ? BigInt(t.stats.volumeQuoteRaw) : state.sort === 'progress' ? BigInt(t.live?.progressBps ?? 0) : BigInt(Date.parse(t.liveAt ?? t.createdAt));
  return [...list].sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0));
}
let paintGrid: (() => void) | null = null;

async function renderHome() {
  const main = $('#view');
  const q = Q();
  const threshold = state.platform?.platform ? units(state.platform.platform.threshold.rawQuoteThreshold, q.decimals, 0) : null;
  const target = threshold ? `${threshold} ${q.symbol}` : 'its graduation target';
  const grid = h('div', { class: 'grid' }, h('div', { class: 'empty' }, 'Loading coins…'));
  const side = h('div', { class: 'how' }, h('span', { class: 'eyebrow' }, 'How it works'), h('ol', {},
    h('li', {}, h('span', {}, 'Make a coin with a name, a ticker and a picture. One signature.')),
    h('li', {}, h('span', {}, `Anyone can buy and sell it on its bonding curve, priced in ${q.symbol}.`)),
    h('li', {}, h('span', {}, `At ${target} raised it graduates to Meteora DAMM v2 and its liquidity is locked forever.`))));
  const hero = h('section', { class: 'hero' },
    h('div', { class: 'hero-copy' }, h('h1', {}, 'Launch a coin', h('br'), 'in one signature.'),
      h('p', { class: 'lead' }, `Every coin starts on a bonding curve priced in ${q.symbol}. When ${target} is raised it graduates to a Meteora DAMM v2 pool, and its liquidity is locked for good.`),
      h('div', { class: 'cta' }, state.platform?.writesEnabled ? h('a', { class: 'btn primary lg', href: '#/create' }, 'Create a coin') : h('a', { class: 'btn primary lg', href: '#/status' }, 'Why launching is locked'),
        hasFaucet() ? h('button', { class: 'btn ghost lg', onclick: claimFaucet }, `Get test ${q.symbol}`) : null)),
    side);
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Sort coins' });
  const paintTabs = () => tabs.replaceChildren(...([['traded', 'Most traded'], ['new', 'New'], ['progress', 'About to graduate'], ['graduated', 'Graduated']] as [Sort, string][])
    .map(([k, label]) => h('button', { class: `tab${state.sort === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(state.sort === k), onclick: () => { state.sort = k; paintTabs(); paintGrid?.(); } }, label)));
  paintTabs();
  main.replaceChildren(hero, h('section', {}, h('div', { class: 'section-head' }, h('h2', {}, 'Coins'), tabs), grid));
  paintGrid = () => {
    const list = sortedTokens();
    grid.replaceChildren(...(list.length ? list.map(tokenCard)
      : [h('div', { class: 'empty' }, state.tokens.length ? 'No coins match.' : 'No coins yet. ', state.tokens.length || !state.platform?.writesEnabled ? null : h('a', { href: '#/create' }, 'Launch the first one.'))]));
  };
  void renderTape();
  try {
    const { tokens } = await api<{ tokens: Token[] }>('/api/lp/tokens');
    state.tokens = tokens;
    const next = tokens.filter((t) => t.live && !isGraduated(t) && !t.live.curveComplete && t.live.progressBps > 0).sort((a, b) => b.live!.progressBps - a.live!.progressBps)[0];
    if (next) side.replaceWith(featureCard(next));
    paintGrid();
  } catch (e) { grid.replaceChildren(h('div', { class: 'empty err' }, `Could not load coins: ${(e as Error).message}`)); }
}

// ---------------- create
async function shrinkImage(file: File): Promise<string> {
  const raw = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
  if (file.size <= 200_000 && /^data:image\/(png|jpeg|gif|webp);/.test(raw)) return raw;
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('not an image')); img.src = raw; });
  const s = Math.min(1, 512 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', 0.85).startsWith('data:image/webp') ? c.toDataURL('image/webp', 0.85) : c.toDataURL('image/jpeg', 0.85);
}

function renderCreate() {
  const p = state.platform?.platform;
  const q = Q();
  const main = $('#view');
  if (!state.platform?.writesEnabled) { main.replaceChildren(lockedPanel('Launching is locked')); return; }
  if (!p) { main.replaceChildren(h('div', { class: 'empty' }, 'The devnet platform is not set up yet.')); return; }
  let imageDataUrl: string | null = null;
  const name = h('input', { id: 'f-name', maxLength: 32, placeholder: 'Moon Cat', required: true, autocomplete: 'off' });
  const symbol = h('input', { id: 'f-symbol', maxLength: 10, placeholder: 'MCAT', required: true, autocomplete: 'off', 'aria-label': 'Ticker' });
  const desc = h('textarea', { id: 'f-desc', maxLength: 500, rows: 3, placeholder: 'What is this coin about?' });
  const web = h('input', { id: 'f-web', placeholder: 'https://', type: 'url' });
  const tw = h('input', { id: 'f-x', placeholder: 'https://x.com/…', type: 'url' });
  const tg = h('input', { id: 'f-tg', placeholder: 'https://t.me/…', type: 'url' });
  const file = h('input', { id: 'f-img', type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
  const consent = h('input', { id: 'f-consent', type: 'checkbox' });
  const pic = h('span', { class: 'pic' }, icon(ICON.image, 32));
  const preview = h('div', { class: 'preview' });
  const e = p.launchEconomics;
  const submit = h('button', { class: 'btn primary lg wide', type: 'submit' }, 'Launch coin');
  const updatePreview = () => {
    const sym = (symbol.value.trim() || 'TICKER').toUpperCase();
    submit.textContent = symbol.value.trim() ? `Launch $${sym}` : 'Launch coin';
    preview.replaceChildren(tokenCard({ mint: 'preview', pool: '', name: name.value || 'Your coin', symbol: sym, description: desc.value,
      imageUrl: imageDataUrl, creator: state.wallet?.account.address ?? 'you', status: 'LIVE', createdAt: new Date().toISOString(), liveAt: null, website: null, twitter: null,
      telegram: null, createSig: null, migrationSig: null, dammPool: null, stats: { count: 0, volumeQuoteRaw: '0', traders: 0 },
      live: { priceQuotePerBase: '0', marketCapQuoteRaw: '0', priceUnavailable: false, launchPriceQuotePerBase: '0', lockedBps: null, quoteReserve: '0', migrationQuoteThreshold: p.threshold.rawQuoteThreshold, progressBps: 0, curveComplete: false, isMigrated: false,
        baseDecimals: 6, quoteDecimals: q.decimals, totalSupplyRaw: '0', creatorQuoteFee: '0' } }));
  };
  for (const el of [name, symbol, desc]) el.addEventListener('input', updatePreview);
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try { imageDataUrl = await shrinkImage(f); pic.replaceChildren(h('img', { src: imageDataUrl, alt: '' })); updatePreview(); } catch (err) { toast(`Image: ${(err as Error).message}`, 'err'); }
  });
  updatePreview();
  const digestOk = economicsDigest(e) === p.launchEconomicsDigest;
  const tile = (k: string, v: string) => h('div', {}, h('span', {}, k), h('b', {}, v));
  const econ = h('div', { class: 'econ-tiles' },
    tile('Supply', `${units(BigInt(e.totalSupply) * 10n ** BigInt(e.baseDecimals), e.baseDecimals, 0)}, fixed forever`),
    tile('Trading fee', `${e.economics.baseFeeBps / 100}% on every trade, paid in ${q.symbol}`),
    tile('Your cut', `${e.economics.creatorTradingFeePct}% of fees, after Meteora’s 20%`),
    tile('Graduates at', `${units(e.migrationQuoteThresholdRaw, q.decimals, 0)} ${q.symbol} raised`),
    tile('After graduation', `Meteora DAMM v2, ${e.percentageSupplyOnMigration}% of supply paired`),
    tile('Liquidity', `Locked forever (${e.economics.lp.creatorPermanentLockedPct}% creator, ${e.economics.lp.partnerPermanentLockedPct}% platform)`));
  const form = h('form', { class: 'create-form', novalidate: true },
    h('div', {}, h('h1', {}, 'Make a coin.'), h('p', { class: 'lead' }, 'One signature creates the token, its picture and its bonding curve. Nobody, including you, can mint more later.')),
    h('label', { class: 'drop' }, pic, h('span', {}, h('strong', {}, 'Drop a picture or tap to choose'), h('span', { class: 'dim small' }, 'PNG, JPEG, GIF or WebP. Resized to 512 px.')), file),
    h('div', { class: 'row3' }, h('label', { class: 'span2' }, 'Name', name), h('label', {}, 'Ticker', h('span', { class: 'prefixed' }, '$', symbol))),
    h('label', {}, 'Description', desc),
    h('details', {}, h('summary', {}, 'Links (optional)'), h('label', {}, 'Website', web), h('label', {}, 'X / Twitter', tw), h('label', {}, 'Telegram', tg)),
    h('div', { class: 'card econ-card' }, h('h3', {}, 'What you’re launching'), econ,
      h('span', { class: 'mono dim' }, `${p.economicsVersion} · ${p.templateVersion} · digest ${p.launchEconomicsDigest.slice(0, 12)}…${digestOk ? '' : ' (MISMATCH)'}`)),
    h('label', { class: 'consent' }, consent, h('span', {}, `I’ve read what I’m launching. This is devnet, so the coin and ${q.symbol} have no value.`)),
    submit,
    h('p', { class: 'dim small', style: { textAlign: 'center', margin: '0' } }, 'No platform fee. You pay devnet rent and network fees, about 0.03 SOL.'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const sym = symbol.value.trim().toUpperCase();
    const errs: string[] = [];
    if (!name.value.trim()) errs.push('name is required');
    if (!/^[A-Z0-9]{1,10}$/.test(sym)) errs.push('ticker must be 1–10 letters or digits');
    if (!consent.checked) errs.push('tick the box to confirm you read what you are launching');
    if (!digestOk) errs.push('the economics shown do not match their digest; reload');
    if (errs.length) { toast(errs.join(', '), 'err'); return; }
    const w = requireWallet();
    if (!w) return;
    submit.disabled = true;
    const mintKey = await generateMintKey();
    const body = { creator: w.account.address, baseMint: mintKey.address, name: name.value.trim(), symbol: sym, description: desc.value.trim(),
      imageDataUrl: imageDataUrl ?? undefined, website: web.value.trim() || undefined, twitter: tw.value.trim() || undefined, telegram: tg.value.trim() || undefined,
      economicsDigest: p.launchEconomicsDigest };
    let metadataUri = '';
    const out = await runSigningFlow<{ mint: string }>(`Launch $${sym}`, async () => {
      const r = await api<Built & { metadataUri: string }>('/api/lp/launch', body);
      metadataUri = r.metadataUri;
      return r;
    }, () => ({ kind: 'CREATE_POOL', wallet: w.account.address, shown: { body: { ...body, imageDataUrl: !!body.imageDataUrl }, economicsDigest: p.launchEconomicsDigest },
      fields: { name: body.name, symbol: body.symbol, uri: metadataUri, creator: w.account.address, baseMint: mintKey.address, config: p.config, quoteMint: q.mint } }),
    { address: mintKey.address, key: mintKey.privateKey });
    submit.disabled = false;
    if (out) { toast(`$${sym} is live`, 'ok'); location.hash = `#/t/${mintKey.address}`; }
  });
  main.replaceChildren(h('div', { class: 'create' }, form,
    h('aside', {}, h('span', { class: 'eyebrow' }, 'Preview'), preview,
      h('div', { class: 'steps-explain' }, h('b', {}, 'What happens when you press Launch'), h('ol', {},
        h('li', {}, 'Our server builds the launch transaction.'), h('li', {}, 'Your browser checks it against what you see here.'),
        h('li', {}, 'Your wallet asks you to sign once.'), h('li', {}, 'The coin is live and tradable right away.'))))));
}

// ---------------- token page
const tradePrice = (t: Trade, baseDecimals: number) => (BigInt(t.quoteRaw) * 10n ** BigInt(baseDecimals) * 10n ** 18n) / BigInt(t.baseRaw === '0' ? '1' : t.baseRaw);
/** Price by trade: each point is one trade's average fill price (quote paid / tokens received), oldest to newest at
 *  equal spacing (not a time axis); the last point is the current spot price. The labels say exactly that. */
function chart(trades: Trade[], live: Live | null, baseDecimals: number) {
  const q = Q();
  const pts = [...trades].reverse().map((t) => tradePrice(t, baseDecimals));
  const spot = live?.priceQuotePerBase ? BigInt(live.priceQuotePerBase) : null;
  if (spot !== null) pts.push(spot);
  const W = 800, H = 260, pad = 10;
  if (pts.length < 2) return h('div', { class: 'chart empty dim' }, 'The price chart appears after the first trades.');
  const max = pts.reduce((a, b) => (b > a ? b : a)), min = pts.reduce((a, b) => (b < a ? b : a));
  const span = max - min || 1n;
  const xy = pts.map((v, i) => [pad + (i * (W - 2 * pad)) / (pts.length - 1), H - pad - Number(((v - min) * 1000n) / span) * (H - 2 * pad) / 1000]);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Average fill price of the last ${trades.length} trades, oldest to newest${spot !== null ? ', then the current spot price' : ''}. Range ${price(min, q.decimals)} to ${price(max, q.decimals)} ${q.symbol}.`);
  for (const y of [H / 4, H / 2, (3 * H) / 4]) { const g = document.createElementNS(ns, 'path'); g.setAttribute('d', `M0 ${y} H${W}`); g.setAttribute('class', 'grid-l'); svg.append(g); }
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('d', `M${xy[0]![0]},${H} ${xy.map(([x, y]) => `L${x},${y}`).join(' ')} L${xy[xy.length - 1]![0]},${H} Z`); area.setAttribute('class', 'area');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', xy.map(([x, y]) => `${x},${y}`).join(' ')); line.setAttribute('class', 'line');
  svg.append(area, line);
  return h('figure', { class: 'chart-box' },
    h('div', { class: 'chart-plot' }, svg,
      h('span', { class: 'axis-y top num' }, `${price(max, q.decimals)} ${q.symbol}`), h('span', { class: 'axis-y bottom num' }, `${price(min, q.decimals)} ${q.symbol}`)),
    h('div', { class: 'axis-x dim small' }, h('span', {}, 'oldest trade'), h('span', {}, spot !== null ? 'now (spot price)' : 'latest trade')),
    h('figcaption', { class: 'dim small' }, `Each point is one trade's average fill price, in order, evenly spaced (not to time scale)${spot !== null ? '. The last point is the current pool price' : ''}.`));
}

let tokenTimer: number | undefined;
async function renderToken(mint: string) {
  const main = $('#view');
  const q = Q();
  main.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  let data: { token: Token; trades: Trade[] };
  try { data = await api(`/api/lp/tokens/${mint}?fresh=1`); } catch (e) { main.replaceChildren(h('div', { class: 'empty err' }, `Token not found (${(e as Error).message}).`)); return; }
  const { token: t, trades } = data;
  const l = t.live;
  const bd = l?.baseDecimals ?? 6;
  void refreshBalances(t.mint);
  const graduated = isGraduated(t);
  // After graduation the same panel trades on the coin's DAMM v2 pool (the server says which venue it priced).
  const onDamm = graduated && l?.venue === 'DAMM_V2' && !!t.dammPool;
  const tradeable = onDamm || (!graduated && !l?.curveComplete);

  // trade panel
  let side: 'buy' | 'sell' = 'buy';
  const amount = h('input', { id: 'amt', inputMode: 'decimal', placeholder: '0.00', autocomplete: 'off', 'aria-label': 'Amount to pay' });
  const payUnit = h('span', {});
  const slip = h('select', { id: 'slip', 'aria-label': 'Slippage' }, ...[50, 100, 300, 500, 1000].map((b) => h('option', { value: String(b), selected: b === 100 }, `${b / 100}%`)));
  const quoteBox = h('div', { class: 'quote' });
  const go = h('button', { class: 'btn primary lg wide', id: 'trade' }, 'Buy');
  const presets = h('div', { class: 'presets' });
  const tabs = h('div', { class: 'seg' });
  const balanceLine = h('p', { class: 'dim small', id: 'bal', style: { margin: '0' } });
  const panelCard = h('div', { class: 'card trade' });
  const unitOf = () => (side === 'buy' ? q.decimals : bd);
  let lastQuote: any = null, qTimer: number | undefined;
  const setSide = (s: typeof side) => {
    side = s; amount.value = ''; quoteBox.replaceChildren(); lastQuote = null;
    panelCard.classList.toggle('sell', s === 'sell');
    payUnit.textContent = s === 'buy' ? q.symbol : `$${t.symbol}`;
    tabs.replaceChildren(h('button', { class: s === 'buy' ? 'on buy' : '', onclick: () => setSide('buy') }, 'Buy'), h('button', { class: s === 'sell' ? 'on sell' : '', onclick: () => setSide('sell') }, 'Sell'));
    go.textContent = s === 'buy' ? `Buy $${t.symbol}` : `Sell $${t.symbol}`;
    go.className = `btn lg wide ${s === 'buy' ? 'primary' : 'sell'}`;
    presets.replaceChildren(...(s === 'buy'
      ? ['10', '50', '100', '500'].map((v) => h('button', { class: 'chipbtn', onclick: () => { amount.value = v; requote(); } }, `${v} ${q.symbol}`))
      : [25, 50, 75, 100].map((p) => h('button', { class: 'chipbtn', onclick: () => {
        const bal = BigInt(state.balances?.tokens[t.mint] ?? '0');
        amount.value = units((bal * BigInt(p)) / 100n, bd, bd).replace(/,/g, ''); requote();
      } }, p === 100 ? 'Max' : `${p}%`))));
  };
  const requote = () => {
    clearTimeout(qTimer);
    qTimer = window.setTimeout(async () => {
      lastQuote = null;
      let raw: bigint;
      try { raw = parseUnits(amount.value || '0', unitOf()); } catch (e) { quoteBox.replaceChildren(h('p', { class: 'err' }, (e as Error).message)); return; }
      if (raw === 0n) { quoteBox.replaceChildren(); return; }
      try {
        const { quote } = await api<{ quote: any }>('/api/lp/quote', { mint: t.mint, side, amountIn: raw.toString(), slippageBps: Number(slip.value) });
        lastQuote = { ...quote, raw };
        const outDec = side === 'buy' ? bd : q.decimals, outSym = side === 'buy' ? `$${t.symbol}` : q.symbol;
        quoteBox.replaceChildren(h('dl', {},
          h('dt', {}, 'You receive'), h('dd', { class: 'big' }, `${units(quote.expectedOut, outDec, 2)} ${outSym}`),
          h('dt', {}, 'At least'), h('dd', {}, `${units(quote.minimumAmountOut, outDec, 2)} ${outSym}`),
          h('dt', {}, 'Fee'), h('dd', {}, `${units(BigInt(quote.tradingFee) + BigInt(quote.protocolFee), q.decimals, 4)} ${q.symbol}`),
          h('dt', {}, 'Price impact'), h('dd', { class: Number(quote.priceImpactBps) > 500 ? 'err' : '' }, pct(Number(quote.priceImpactBps)))));
      } catch (e) {
        const max = e instanceof ApiError && e.code === 'AMOUNT_NOT_FILLABLE' ? e.details.find((d) => d.startsWith('maxAmountIn:'))?.slice(12) : undefined;
        if (max && side === 'buy') {
          const ui = units(max, q.decimals, q.decimals).replace(/,/g, '');
          quoteBox.replaceChildren(h('div', { class: 'fill-rest' },
            h('p', {}, `Only ${units(max, q.decimals, 2)} ${q.symbol} fits on the curve. That buy completes it and the coin graduates.`),
            h('button', { class: 'chipbtn', onclick: () => { amount.value = ui; requote(); } }, `Buy the rest · ${units(max, q.decimals, 2)} ${q.symbol}`)));
        } else quoteBox.replaceChildren(h('p', { class: 'err' }, (e as Error).message));
      }
    }, 250);
  };
  amount.addEventListener('input', requote);
  slip.addEventListener('change', requote);
  go.addEventListener('click', async () => {
    const w = requireWallet();
    if (!w) return;
    if (!lastQuote) { toast('Enter an amount first', 'err'); amount.focus(); return; }
    const shownQuote = lastQuote;
    const dir = side === 'buy' ? 'QUOTE_TO_BASE' : 'BASE_TO_QUOTE';
    go.disabled = true;
    const out = await runSigningFlow<{ trade: unknown }>(`${side === 'buy' ? 'Buy' : 'Sell'} $${t.symbol}`,
      () => api<Built>('/api/lp/swap', { mint: t.mint, user: w.account.address, side, amountIn: shownQuote.raw.toString(), slippageBps: Number(slip.value) }),
      () => ({ kind: onDamm ? 'DAMM_SWAP' : 'SWAP', wallet: w.account.address, shown: { quote: { ...shownQuote, raw: shownQuote.raw.toString() } },
        fields: { user: w.account.address, pool: onDamm ? t.dammPool : t.pool, baseMint: t.mint, quoteMint: q.mint, direction: dir, amountIn: shownQuote.raw.toString() },
        minimumAmountOutAtLeast: shownQuote.minimumAmountOut }));
    go.disabled = false;
    if (out) { toast('Trade confirmed', 'ok'); renderToken(t.mint); }
  });
  setSide('buy');
  // "Your earnings": the creator's share of curve fees, and after graduation the fees of any DAMM v2 position this wallet
  // holds (the creator's locked LP). Loaded for whichever wallet is connected; claimed by that wallet's own signature.
  const feesCard = h('div', { class: 'card fees', hidden: true });
  let feesFor: string | null = null;
  const amountLabel = (quoteRaw: string, baseRaw: string) => [BigInt(quoteRaw) > 0n || BigInt(baseRaw) === 0n ? `${units(quoteRaw, q.decimals, 2)} ${q.symbol}` : null,
    BigInt(baseRaw) > 0n ? `${units(baseRaw, bd, 2)} $${t.symbol}` : null].filter(Boolean).join(' + ');
  const claim = async (title: string, body: Record<string, string>, expect: (w: Connected) => Pick<Expectation, 'kind' | 'fields'>) => {
    const w = requireWallet();
    if (!w) return;
    const out = await runSigningFlow<{ signature: string }>(title, () => api<Built>('/api/lp/claim', { mint: t.mint, user: w.account.address, ...body }),
      () => ({ ...expect(w), wallet: w.account.address, shown: { claim: body, mint: t.mint } }));
    if (out) { toast('Fees claimed to your wallet', 'ok'); feesFor = null; await refreshBalances(t.mint); void paintFees(true); }
  };
  async function paintFees(fresh = false) {
    const w = state.wallet;
    if (!w) { feesCard.hidden = true; feesFor = null; return; }
    if (feesFor === w.account.address && !fresh) return;
    feesFor = w.account.address;
    let f: Fees;
    try { f = await api<Fees>(`/api/lp/fees/${t.mint}?wallet=${w.account.address}${fresh ? '&fresh=1' : ''}`); } catch { feesCard.hidden = true; feesFor = null; return; }
    if (currentMint() !== t.mint || state.wallet?.account.address !== w.account.address) return;
    const rows: HTMLElement[] = [];
    const row = (label: string, sub: string, quoteRaw: string, baseRaw: string, onClaim: () => void) => {
      const has = BigInt(quoteRaw) > 0n || BigInt(baseRaw) > 0n;
      rows.push(h('div', { class: 'fee-row' }, h('div', {}, h('b', {}, label), h('span', { class: 'dim small' }, sub)),
        h('div', { class: 'fee-amt' }, h('span', { class: 'num' }, amountLabel(quoteRaw, baseRaw)),
          h('button', { class: 'btn primary', disabled: !has, onclick: onClaim }, has ? 'Claim' : 'Nothing yet'))));
    };
    if (f.curve) row('Bonding curve', 'Your share of every trade on the curve', f.curve.quoteRaw, f.curve.baseRaw,
      () => claim(`Claim ${amountLabel(f.curve!.quoteRaw, f.curve!.baseRaw)}`, { venue: 'curve' },
        (w) => ({ kind: 'CLAIM_CREATOR_TRADING_FEE', fields: { creator: w.account.address, receiver: w.account.address, pool: t.pool, baseMint: t.mint, quoteMint: q.mint } })));
    for (const p of f.positions) row(p.permanentlyLocked ? 'Locked LP position' : 'LP position', 'Fees from trades on the DAMM v2 pool', p.feeQuoteRaw, p.feeBaseRaw,
      () => claim(`Claim ${amountLabel(p.feeQuoteRaw, p.feeBaseRaw)}`, { venue: 'damm', nftMint: p.nftMint },
        (w) => ({ kind: 'DAMM_CLAIM_POSITION_FEE', fields: { owner: w.account.address, pool: t.dammPool, positionNftMint: p.nftMint, baseMint: t.mint, quoteMint: q.mint } })));
    feesCard.replaceChildren(h('span', { class: 'eyebrow' }, f.isCreator ? 'Your creator earnings' : 'Your LP fees'), ...rows,
      h('p', { class: 'dim small', style: { margin: '0' } }, 'Claims pay this wallet directly. Your wallet signs; the server never holds your key.'));
    feesCard.hidden = rows.length === 0;
  }
  paintBalance = () => {
    if (state.balances) balanceLine.textContent = `Balance: ${units(state.balances.tokens[q.mint] ?? '0', q.decimals, 2)} ${q.symbol} · ${units(state.balances.tokens[t.mint] ?? '0', bd, 2)} $${t.symbol}`;
    void paintFees();
  };
  paintBalance();

  const trust = h('div', { class: 'trust' }, icon(ICON.shield, 18, 'var(--buy)'), h('span', {}, 'Your browser checks every account and amount in the transaction before your wallet is asked to sign.'));
  let panel: HTMLElement;
  if (onDamm) {
    panelCard.append(h('p', { class: 'venue' }, icon(ICON.shield, 16, 'var(--grad)'), h('span', {}, l?.priceUnavailable ? 'Graduated. Its Meteora DAMM v2 pool could not be read just now, so there is no current price. Try again in a moment.'
        : `Graduated. Trades on its Meteora DAMM v2 pool${lockedText(l) ? `, ${lockedText(l)} of liquidity permanently locked` : ''}.`)),
      tabs, h('label', {}, 'You pay', h('span', { class: 'payfield' }, amount, payUnit)), presets,
      h('div', { class: 'slip-row' }, h('span', {}, 'Slippage'), slip), quoteBox, go, balanceLine, trust);
    panel = panelCard;
  } else if (graduated) {
    panel = h('div', { class: 'card graduated-panel' }, h('h3', {}, 'Graduated'), h('p', { style: { margin: '0' } }, 'This coin filled its bonding curve and now trades on a Meteora DAMM v2 pool with permanently locked liquidity.'),
      t.dammPool ? ext(explorer('address', t.dammPool), 'Open the DAMM v2 pool on Explorer', 'btn wide') : null,
      t.migrationSig ? h('p', { class: 'dim small', style: { margin: '0' } }, 'Migration tx: ', ext(explorer('tx', t.migrationSig), short(t.migrationSig, 8))) : null);
  } else if (l?.curveComplete) {
    panel = h('div', { class: 'card graduated-panel' }, h('h3', {}, 'Curve full'), h('p', { style: { margin: '0' } }, 'The bonding curve is full. The move to Meteora DAMM v2 runs automatically within a minute.'));
  } else {
    panelCard.append(tabs, h('label', {}, 'You pay', h('span', { class: 'payfield' }, amount, payUnit)), presets,
      h('div', { class: 'slip-row' }, h('span', {}, 'Slippage'), slip), quoteBox, go, balanceLine, trust);
    panel = panelCard;
  }

  // header numbers
  // "Since launch" compares with the curve's fixed starting price, so it does not shift as more trades load.
  const launchPx = BigInt(l?.launchPriceQuotePerBase ?? '0');
  const changeBps = l?.priceQuotePerBase && launchPx > 0n ? Number(((BigInt(l.priceQuotePerBase) - launchPx) * 10000n) / launchPx) : null;
  const links = [t.website && ext(t.website, 'Website'), t.twitter && ext(t.twitter, 'X'), t.telegram && ext(t.telegram, 'Telegram')].filter(Boolean) as HTMLElement[];
  const tradeRows = trades.map((x) => h('tr', {},
    h('td', { class: x.side === 'BUY' ? 'buy' : 'sell' }, x.side === 'BUY' ? 'Buy' : 'Sell'),
    h('td', { class: 'mono' }, ext(explorer('address', x.trader), short(x.trader))),
    h('td', { class: 'num' }, units(x.quoteRaw, q.decimals, 2)),
    h('td', { class: 'num' }, compact(x.baseRaw, bd)),
    feeCell(x.fees, q.decimals),
    h('td', { class: 'dim' }, x.blockTime ? ago(x.blockTime) : `slot ${x.slot}`),
    h('td', { class: 'mono' }, ext(explorer('tx', x.sig), short(x.sig, 4)))));
  const kpi = (k: string, v: string) => h('div', {}, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
  const toGo = l ? BigInt(l.migrationQuoteThreshold) - BigInt(l.quoteReserve) : 0n;

  const mobileBar = !tradeable ? null : h('div', { class: 'mobile-trade' },
    h('button', { class: 'btn primary lg', onclick: () => { setSide('buy'); panel.scrollIntoView({ behavior: 'smooth', block: 'center' }); amount.focus({ preventScroll: true }); } }, 'Buy'),
    h('button', { class: 'btn sell lg', onclick: () => { setSide('sell'); panel.scrollIntoView({ behavior: 'smooth', block: 'center' }); amount.focus({ preventScroll: true }); } }, 'Sell'));

  main.replaceChildren(
    h('section', { class: 'tok-head' },
      h('div', { class: 'tok-id' }, avatar(t, 'lg'),
        h('div', {}, h('div', { class: 'tok-title' }, h('h1', {}, t.name), h('span', { class: 'sym' }, `$${t.symbol}`), statusChip(t)),
          h('div', { class: 'tok-meta' }, h('span', {}, 'by ', ext(explorer('address', t.creator), short(t.creator))), h('span', {}, `launched ${ago(t.liveAt ?? t.createdAt)}`),
            h('button', { class: 'copy', 'aria-label': 'Copy mint address', onclick: () => navigator.clipboard?.writeText(t.mint).then(() => toast('Mint address copied', 'ok')) }, short(t.mint, 4), icon(ICON.copy, 14)),
            ...links))),
      l ? h('div', { class: 'tok-price' }, h('div', { class: 'num' }, l.priceQuotePerBase ? price(l.priceQuotePerBase, q.decimals) : 'Price unavailable'),
        h('div', { class: 'dim' }, `${q.symbol} per ${t.symbol}`, changeBps === null ? '' : ' · ', changeBps === null ? null : h('span', { class: changeBps >= 0 ? 'up' : 'down' }, `${changeBps >= 0 ? '+' : '−'}${pct(Math.abs(changeBps))} since launch`))) : null),
    h('div', { class: 'token' },
      h('div', { class: 'tok-main' },
        h('div', { class: 'kpis' },
          kpi('Market cap', mcapText(l)),
          kpi('Volume', `${compact(t.stats.volumeQuoteRaw, q.decimals)} ${q.symbol}`),
          kpi('Traders', String(t.stats.traders)),
          kpi('Trades', String(t.stats.count))),
        h('div', { class: 'card' }, h('h3', {}, 'Price'), chart(trades, l, bd)),
        l ? h('div', { class: `card grad-card${graduated ? ' done' : ''}` },
          h('div', { class: 'grad-top' }, h('b', {}, 'Graduation'), h('span', { class: 'num' }, graduated ? 'Done' : pct(l.progressBps))),
          progressBar(l.progressBps, l.curveComplete || l.isMigrated, true),
          h('p', { class: 'dim small' }, graduated ? `Graduated to Meteora DAMM v2.${lockedText(l) ? ` ${lockedText(l)} of the pool's liquidity is permanently locked (read from the pool account). Locked liquidity cannot be withdrawn; it does not fix the price.` : ''}`
            : `${units(l.quoteReserve, q.decimals, 0)} of ${units(l.migrationQuoteThreshold, q.decimals, 0)} ${q.symbol} raised. At ${units(l.migrationQuoteThreshold, q.decimals, 0)} the coin moves to a Meteora DAMM v2 pool and its liquidity is locked forever.${toGo > 0n ? ` About ${units(toGo, q.decimals, 0)} ${q.symbol} of buying to go.` : ''}`)) : null,
        h('div', { class: 'card' }, h('h3', {}, 'Trades'), historyNote(t), trades.length ? h('div', { class: 'scroll' }, h('table', { class: 'trades' },
          h('thead', {}, h('tr', {}, ...[['Side', ''], ['Trader', ''], [q.symbol, 'num'], [`$${t.symbol}`, 'num'], ['Fee paid', 'num'], ['When', ''], ['Tx', '']].map(([c, cls]) => h('th', { class: cls }, c)))), h('tbody', {}, ...tradeRows))) : h('p', { class: 'dim', style: { margin: '0' } }, 'No trades yet. Be the first.'))),
      h('aside', {}, panel, feesCard,
        h('div', { class: 'card about' }, h('span', { class: 'eyebrow' }, 'About'), t.description ? h('p', {}, t.description) : null,
          h('dl', { class: 'facts' },
            h('dt', {}, 'Engine'), h('dd', {}, onDamm ? 'Meteora DAMM v2' : graduated ? 'Graduated to DAMM v2' : 'Meteora bonding curve'),
            ...(t.dammPool ? [h('dt', {}, 'DAMM v2 pool'), h('dd', { class: 'num' }, ext(explorer('address', t.dammPool), short(t.dammPool, 4)))] : []),
            h('dt', {}, t.dammPool ? 'Curve pool' : 'Pool'), h('dd', { class: 'num' }, ext(explorer('address', t.pool), short(t.pool, 4))),
            ...(t.migrationSig ? [h('dt', {}, 'Graduation tx'), h('dd', { class: 'num' }, ext(explorer('tx', t.migrationSig), short(t.migrationSig, 4)))] : []),
            h('dt', {}, 'Launch tx'), h('dd', { class: 'num' }, t.createSig ? ext(explorer('tx', t.createSig), short(t.createSig, 4)) : '—'),
            ...(lockedText(l) ? [h('dt', {}, 'Liquidity locked'), h('dd', { class: 'num', title: 'permanentLockLiquidity / liquidity, read from the DAMM v2 pool account' }, lockedText(l)!)] : []),
            h('dt', {}, 'Creator curve fees, unclaimed'), h('dd', { class: 'num' }, l ? `${units(l.creatorQuoteFee, q.decimals, 2)} ${q.symbol}` : '—'),
            ...(t.history ? [h('dt', {}, 'Trade history'), h('dd', {}, historyText(t.history))] : []))))),
    ...(mobileBar ? [mobileBar] : []));
  clearInterval(tokenTimer);
  // Keep the page honest without a reload: index new trades, and when the coin changes phase (curve full -> graduated,
  // or its venue switches to DAMM v2) re-render, since the trade panel for the old phase is no longer valid.
  const phase = (x: Token) => `${x.status}|${x.live?.venue}|${x.live?.curveComplete}|${x.live?.isMigrated}`;
  const idle = () => currentMint() === mint && !document.hidden && $('#modal').hidden;
  tokenTimer = window.setInterval(async () => {
    if (!idle()) return;
    await api('/api/lp/refresh', { mint }).catch(() => {});
    const n = await api<{ token: Token }>(`/api/lp/tokens/${mint}`).catch(() => null);
    if (n && phase(n.token) !== phase(t) && idle()) void renderToken(mint);
  }, l?.curveComplete && !graduated ? 6_000 : 20_000);
}

function historyText(x: NonNullable<Token['history']>): string {
  if (x.complete) return 'Complete';
  return [x.pending ? `${x.pending} ${x.pending === 1 ? 'transaction' : 'transactions'} still being read` : '',
    x.unavailable ? `${x.unavailable} could not be read` : ''].filter(Boolean).join(', ');
}
/** Said above the trade list when the indexer has transactions it has not been able to read yet. */
function historyNote(t: Token): HTMLElement | null {
  const x = t.history;
  if (!x || x.complete) return null;
  return h('p', { class: 'dim small hist-note' }, x.unavailable
    ? `${historyText(x)}. The RPC has not returned ${x.unavailable === 1 ? 'that transaction' : 'those transactions'} after many tries, so trades, volume and the chart may be missing some. They are still retried every few hours.`
    : `${historyText(x)}. Trades, volume and the chart may be missing ${x.pending === 1 ? 'it' : 'them'} for now; this fills in by itself.`);
}

// ------------------------------------------------------------------ earnings (read-only)
interface Unclaimed { creatorQuoteRaw: string | null; platformQuoteRaw: string | null }
interface Earnings {
  label: string; platformWallet: string; asOf: string;
  totals: { unclaimed: { creatorCurve: string; platformCurve: string; creatorLp: string; platformLp: string }; claimedThroughApp: string; incomplete: boolean;
    coverage: { unclaimedComplete: boolean; claimsComplete: boolean; unresolvedClaims: number } };
  coins: { mint: string; symbol: string; name: string; status: string; creator: string; curve: Unclaimed | null; lp: Unclaimed | 'UNAVAILABLE' | null;
    platformWallet: string; treasury: boolean; configRole?: 'CURRENT' | 'LEGACY'; checks?: { creatorCurve: FeeCheck; platformCurve: FeeCheck; lp: FeeCheck | null } }[];
  claims: { sig: string; mint: string; symbol: string; venue: 'CURVE' | 'DAMM_V2'; claimer: string; byCreator: boolean; byTreasury: boolean; quoteRaw: string | null; at: string;
    status: 'UNKNOWN' | 'RESOLVED' | 'FAILED_TX'; evidence: string | null }[];
  treasury: { multisig: string; vault: string; threshold: number; members: string[]; label: string; note: string; separationOfControl: boolean; paidToTreasuryQuoteRaw: string;
    unresolvedReceipts: number; openProposals: number;
    vaultCheck: { status: 'MATCH' | 'MISMATCH' | 'INCOMPLETE'; vaultQuoteRaw: string | null; receiptsRaw: string; differenceRaw: string | null; reasons: string[] } } | null;
}
/** Fees recorded trade by trade versus what the pool still holds plus what was claimed (lp-api earnings checks). */
interface FeeCheck { fromTradesRaw: string; onChainRaw: string | null; claimedRaw: string; differenceRaw: string | null; status: 'MATCH' | 'RESIDUAL' | 'MISMATCH' | 'INCOMPLETE'; reasons: string[];
  residual?: { raw: string; boundRaw: string; origin: string; note: string } }
/** Why a receipt's amount is not known yet, in words. */
const EVIDENCE: Record<string, string> = {
  NO_TX_DETAILS: 'the RPC has not returned its transaction yet',
  VAULT_NOT_IN_TX: "its transaction does not touch this claim's pool vaults",
  NO_BALANCE_OBSERVATION: 'no balance reading for the pool vaults in its transaction',
  VAULT_INFLOW: 'the pool vaults received funds, which a claim never does',
  NO_VAULT_IDENTITY: 'no record of which pool this claim was bound to',
  RECHECK_LEGACY: 'recorded before receipts were checked; being re-checked',
};
async function renderEarnings(fresh = false) {
  const main = $('#view');
  const q = Q();
  if (!fresh) main.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  let e: Earnings;
  try { e = await api<Earnings>(`/api/lp/earnings${fresh ? '?fresh=1' : ''}`); }
  catch (err) { if (!fresh) main.replaceChildren(h('div', { class: 'empty err' }, `Earnings unavailable (${(err as Error).message}).`)); else toast(`Refresh failed: ${(err as Error).message}`, 'err'); return; }
  if (location.hash !== '#/earnings') return;
  const amt = (raw: string | null | undefined) => (raw == null ? '—' : `${units(raw, q.decimals, 2)} ${q.symbol}`);
  const u = e.totals.unclaimed;
  const plat = BigInt(u.platformCurve) + BigInt(u.platformLp), crea = BigInt(u.creatorCurve) + BigInt(u.creatorLp);
  const kpi = (k: string, v: string, sub: string) => h('div', {}, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), h('span', { class: 'dim small' }, sub));
  const lpCell = (c: Earnings['coins'][number], who: keyof Unclaimed) => c.lp === null ? h('td', { class: 'num dim' }, 'not graduated')
    : c.lp === 'UNAVAILABLE' ? h('td', { class: 'num dim' }, 'pool unreadable') : h('td', { class: 'num' }, amt(c.lp[who]));
  const rows = e.coins.map((c) => h('tr', {},
    h('td', {}, h('a', { href: `#/t/${c.mint}` }, `$${c.symbol}`), h('span', { class: 'dim small' }, c.status === 'MIGRATED' ? ' graduated' : ' bonding'),
      c.treasury ? h('span', { class: 'chip grad pay-to', title: 'Platform fees of this coin go to the treasury vault' }, 'treasury')
        : c.configRole === 'LEGACY' ? h('span', { class: 'chip legacy pay-to', title: 'Launched on the earlier config. Its platform fees still go to the operator wallet, unchanged.' }, 'legacy config') : null),
    h('td', { class: 'num' }, amt(c.curve?.creatorQuoteRaw)), lpCell(c, 'creatorQuoteRaw'),
    h('td', { class: 'num' }, amt(c.curve?.platformQuoteRaw)), lpCell(c, 'platformQuoteRaw')));
  const paid = (c: Earnings['claims'][number]) => c.status === 'RESOLVED' ? h('td', { class: 'num' }, amt(c.quoteRaw))
    : c.status === 'FAILED_TX' ? h('td', { class: 'num dim' }, 'failed, nothing paid')
    : h('td', { class: 'num' }, h('span', {}, 'unknown'), h('span', { class: 'dim small reason' }, EVIDENCE[c.evidence ?? ''] ?? 'not checked yet'));
  const claimRows = e.claims.map((c) => h('tr', {},
    h('td', {}, h('a', { href: `#/t/${c.mint}` }, `$${c.symbol}`)), h('td', {}, c.venue === 'CURVE' ? 'Curve fees' : 'LP position fees'),
    h('td', {}, c.byCreator ? 'Creator' : c.byTreasury && e.treasury ? `Treasury (${e.treasury.threshold} of ${e.treasury.members.length})` : short(c.claimer)), paid(c),
    h('td', { class: 'dim' }, ago(Math.floor(Date.parse(c.at) / 1000))), h('td', { class: 'mono' }, ext(explorer('tx', c.sig), short(c.sig, 4)))));
  const table = (head: [string, string][], body: HTMLElement[], empty: string) => body.length
    ? h('div', {}, h('p', { class: 'scroll-hint dim small' }, 'Swipe the table sideways to see every column.'),
      h('div', { class: 'scroll' }, h('table', { class: 'trades' }, h('thead', {}, h('tr', {}, ...head.map(([c, cls]) => h('th', { class: cls }, c)))), h('tbody', {}, ...body))))
    : h('p', { class: 'dim', style: { margin: '0' } }, empty);
  const cov = e.totals.coverage, n = cov.unresolvedClaims;
  const refresh = h('button', { class: 'btn ghost sm', onclick: async () => { refresh.setAttribute('disabled', ''); await renderEarnings(true); } }, 'Refresh');
  main.replaceChildren(h('section', { class: 'earnings' },
    h('div', { class: 'earn-head' }, h('h1', {}, 'Earnings'), h('p', { class: 'dim' }, `Fees earned on every coin, read from the pools on devnet. ${e.label}. Read-only: nothing on this page can move funds.`),
      h('div', { class: 'asof' }, h('span', { class: 'dim small' }, `Read from the pools at ${new Date(e.asOf).toLocaleTimeString()} (${ago(e.asOf)}). Figures are kept for up to 30 seconds.`), refresh)),
    h('div', { class: 'kpis' },
      kpi('Platform, unclaimed', amt(plat.toString()), 'curve fees + locked LP fees'),
      kpi('Creators, unclaimed', amt(crea.toString()), 'curve fees + locked LP fees'),
      kpi('Claimed in the app', amt(e.totals.claimedThroughApp), n ? `${e.claims.length - n} of ${e.claims.length} claims confirmed` : `${e.claims.length} ${e.claims.length === 1 ? 'claim' : 'claims'}`),
      kpi('Coins', String(e.coins.length), `${e.coins.filter((c) => c.status === 'MIGRATED').length} graduated`)),
    cov.unclaimedComplete && !n ? null : h('div', { class: 'cov-notes' },
      cov.unclaimedComplete ? null : h('p', { class: 'err small' }, 'Some pools or positions could not be read just now, so the unclaimed totals are incomplete. Refresh in a moment.'),
      n ? h('p', { class: 'err small' }, `${n} claim ${n === 1 ? 'receipt is' : 'receipts are'} not confirmed from ${n === 1 ? 'its' : 'their'} transaction yet, so "Claimed in the app" leaves ${n === 1 ? 'it' : 'them'} out. Each refresh checks again.`) : null),
    h('div', { class: 'card' }, h('h3', {}, 'Unclaimed, per coin'), table([['Coin', ''], ['Creator · curve', 'num'], ['Creator · LP', 'num'], ['Platform · curve', 'num'], ['Platform · LP', 'num']], rows, 'No coins yet.')),
    e.treasury ? treasuryCard(e.treasury, amt) : null,
    checksCard(e, q.decimals, q.symbol),
    h('div', { class: 'card' }, h('h3', {}, 'Claims made in the app'), table([['Coin', ''], ['What', ''], ['By', ''], ['Paid out', 'num'], ['When', ''], ['Tx', '']], claimRows, 'No claims yet.')),
    h('div', { class: 'card about' }, h('span', { class: 'eyebrow' }, 'How to read this'),
      h('ul', { class: 'notes' },
        h('li', {}, 'Accrued is not claimed, and claimed is not kept revenue.'),
        h('li', {}, h('span', {}, 'Under the current test policy, half of the platform share is earmarked for ', h('a', { href: '#/rewards' }, 'holder rewards'), '. Earmarked means counted, not moved: nothing is transferred or distributed, because there is no rewards vault and payouts are not switched on.')),
        h('li', {}, 'Curve fees are the creator and platform counters in each bonding-curve pool. LP fees are what the locked DAMM v2 positions held by the creator and by the platform fee claimer have earned since their last claim.'),
        e.treasury
          ? h('li', {}, h('span', {}, 'Coins marked treasury pay their platform fees to the treasury vault. Coins marked legacy config launched on the earlier config and keep paying the operator wallet ',
            ext(explorer('address', e.platformWallet === e.treasury.vault ? (e.coins.find((c) => !c.treasury)?.platformWallet ?? e.platformWallet) : e.platformWallet), 'here'),
            ': a coin keeps the config it launched on, and a config\'s fee claimer cannot be changed.'))
          : h('li', {}, h('span', {}, 'Platform fees can only be claimed by the platform fee claimer ', ext(explorer('address', e.platformWallet), short(e.platformWallet)), '. Before mainnet that must be a multisig, so this page has no claim button.')),
        h('li', {}, 'Claims made outside this app are not listed. A claim\'s amount is what left that coin\'s own pool vaults in its own transaction; until that is confirmed it shows as unknown.')))));
}

/** Per coin: do the fees recorded trade by trade add up to what the pool still holds plus what was claimed? */
function checksCard(e: Earnings, decimals: number, symbol: string) {
  const fee = (raw: string | null) => (raw == null ? '—' : `${units(raw, decimals, 6)} ${symbol}`);
  const cell = (c: FeeCheck | null | undefined) => {
    if (!c) return h('td', { class: 'num dim' }, 'not graduated');
    const label = c.status === 'MATCH' ? h('span', { class: 'check-ok' }, 'adds up')
      : c.status === 'RESIDUAL' ? h('span', { class: 'check-residual', title: c.residual?.note ?? '' }, c.residual?.origin === 'PROVEN_ROUNDING'
        ? `${c.differenceRaw} raw residual: the pool's own rounding, proven` : `${c.differenceRaw} raw residual, origin not proven yet`)
      : c.status === 'MISMATCH' ? h('span', { class: 'check-bad' }, `off by ${fee(c.differenceRaw)}`) : h('span', { class: 'dim' }, 'not checkable yet');
    return h('td', { class: 'num', title: c.reasons.join('; ') }, h('span', {}, `${fee(c.fromTradesRaw)} from trades`), h('span', { class: 'dim small reason' }, label));
  };
  const rows = e.coins.filter((c) => c.checks).map((c) => h('tr', {}, h('td', {}, h('a', { href: `#/t/${c.mint}` }, `$${c.symbol}`)),
    cell(c.checks!.creatorCurve), cell(c.checks!.platformCurve), cell(c.checks!.lp)));
  if (!rows.length) return null;
  return h('div', { class: 'card' }, h('h3', {}, 'Do the trade fees add up?'),
    h('p', { class: 'dim small', style: { margin: '0 0 12px' } }, 'Each trade\'s fee is read from its own transaction (see ', h('a', { href: '#/fees' }, 'Fees'), '). Here the per-trade shares are added up and compared with what the pool still holds plus what was claimed through the app. A claim made outside the app would show as a difference. A residual is a few raw units of LP fees that are in no position. It stays listed with its amount. Once the pool\'s own fee accounting shows it is the program rounding each position\'s share down to whole units, it is marked proven (hover for the numbers).'),
    h('div', { class: 'scroll' }, h('table', { class: 'trades' }, h('thead', {}, h('tr', {}, ...[['Coin', ''], ['Creator · curve', 'num'], ['Platform · curve', 'num'], ['LP positions', 'num']].map(([x, cls]) => h('th', { class: cls }, x)))),
      h('tbody', {}, ...rows))));
}

/** The platform treasury: what reached its vault through executed proposals, and how it is controlled. Read-only. */
function treasuryCard(t: NonNullable<Earnings['treasury']>, amt: (raw: string | null) => string) {
  const stat = (k: string, v: string | HTMLElement, sub: string | HTMLElement) => h('div', {}, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), h('span', { class: 'dim small' }, sub));
  const vc = t.vaultCheck;
  const vcLabel = vc.status === 'MATCH' ? h('span', { class: 'check-ok' }, 'equals the receipts')
    : vc.status === 'MISMATCH' ? h('span', { class: 'check-bad', title: vc.reasons.join('; ') }, `off by ${amt(vc.differenceRaw)}`)
    : h('span', { title: vc.reasons.join('; ') }, 'not checkable yet');
  return h('div', { class: 'card treasury' },
    h('div', { class: 'tr-head' }, h('h3', {}, 'Platform treasury'), h('span', { class: 'chip warn' }, 'devnet stand-in'),
      t.separationOfControl ? null : h('span', { class: 'chip warn', title: t.note }, 'test signers, one operator')),
    h('div', { class: 'kpis' },
      stat('Paid to treasury', amt(t.paidToTreasuryQuoteRaw), t.unresolvedReceipts ? `${t.unresolvedReceipts} not confirmed yet` : 'part of "Claimed in the app", not added again'),
      stat('Vault holds', amt(vc.vaultQuoteRaw), vcLabel),
      stat('Approvals to move funds', `${t.threshold} of ${t.members.length}`, 'members sign for themselves'),
      stat('Open proposals', String(t.openProposals), 'waiting for approvals or to run'),
      stat('Vault', h('span', { class: 'mono' }, ext(explorer('address', t.vault), short(t.vault))), 'Squads v4 vault, receives platform fees')),
    h('p', { class: 'dim small', style: { margin: '12px 0 0' } },
      'Platform fees of coins launched since the treasury are claimed into this vault by a multisig proposal. Two of three members must approve before it runs. The server builds the transactions but holds no member key, so it cannot approve, run or spend anything.'),
    h('p', { class: 'err small', style: { margin: '8px 0 0' } }, t.note));
}

// ------------------------------------------------------------------ trading fees (read-only)
const FEE_EVIDENCE: Record<string, string> = {
  NO_TX_DETAILS: 'the RPC has not returned its transaction yet',
  NO_SWAP_EVENT: 'its transaction has no swap record for this pool',
  EVENT_DECODE_FAILED: 'its swap record could not be read exactly',
  FEE_NOT_IN_QUOTE: 'the pool took this fee in the coin, not in the quote token',
  NO_CREATOR_SHARE: "the curve's creator share could not be read",
};
/** A trade's fee, with where it went in the tooltip; never shown as 0 when it is not proven. */
function feeCell(f: TradeFee | undefined, decimals: number) {
  if (!f || f.status === 'PENDING') return h('td', { class: 'num dim' }, 'reading…');
  if (f.status !== 'RESOLVED') return h('td', { class: 'num dim', title: FEE_EVIDENCE[f.evidence ?? ''] ?? '' }, 'unknown');
  const u = (r: string | null) => units(r ?? '0', decimals, 6);
  const where = f.lpRaw !== null ? `LPs ${u(f.lpRaw)} · protocol ${u(f.protocolRaw)}` : `creator ${u(f.creatorRaw)} · platform ${u(f.platformRaw)} · protocol ${u(f.protocolRaw)}`;
  return h('td', { class: 'num', title: where }, u(f.totalRaw));
}
interface FeeTotals { trades: number; volumeQuoteRaw: string; feesRaw: string; creatorRaw: string; platformRaw: string; lpRaw: string; protocolRaw: string;
  referralRaw: string; compoundingRaw: string; unknownTrades: number }
interface WalletFees { wallet: string; totals: FeeTotals; notYetRead: number; coins: (FeeTotals & { mint: string; symbol: string })[];
  trades: (Trade & { mint: string; symbol: string })[] }
interface AllFees { totals: FeeTotals; coins: (FeeTotals & { mint: string; symbol: string })[]; wallets: (FeeTotals & { trader: string })[]; walletCount: number }
/** #/fees (everyone) or #/fees/<wallet>; undefined on any other page. */
const feesWallet = () => { const x = /^#\/fees(?:\/([1-9A-HJ-NP-Za-km-z]{32,44}))?$/.exec(location.hash); return x ? x[1] ?? null : undefined; };

async function renderFees(wallet: string | null) {
  const main = $('#view');
  const q = Q();
  main.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  let w: WalletFees | null = null, all: AllFees | null = null;
  try { if (wallet) w = await api<WalletFees>(`/api/lp/fees?wallet=${wallet}`); else all = await api<AllFees>('/api/lp/fees'); }
  catch (err) { main.replaceChildren(h('div', { class: 'empty err' }, `Fees unavailable (${(err as Error).message}).`)); return; }
  if (feesWallet() !== wallet) return;
  const fee = (raw: string | null | undefined) => (raw == null ? '—' : `${units(raw, q.decimals, 6)} ${q.symbol}`);
  const vol = (raw: string) => `${units(raw, q.decimals, 2)} ${q.symbol}`;
  const t = (w ?? all)!.totals;
  const kpi = (k: string, v: string, sub: string) => h('div', {}, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), h('span', { class: 'dim small' }, sub));
  const table = (head: [string, string][], body: HTMLElement[], empty: string) => body.length
    ? h('div', {}, h('p', { class: 'scroll-hint dim small' }, 'Swipe the table sideways to see every column.'),
      h('div', { class: 'scroll' }, h('table', { class: 'trades' }, h('thead', {}, h('tr', {}, ...head.map(([c, cls]) => h('th', { class: cls }, c)))), h('tbody', {}, ...body))))
    : h('p', { class: 'dim', style: { margin: '0' } }, empty);
  const unknownNote = (n: number) => n ? h('p', { class: 'err small' }, `${n} ${n === 1 ? 'trade has' : 'trades have'} fees not confirmed from ${n === 1 ? 'its' : 'their'} transaction yet. They are left out of the totals, not counted as zero, and are read again automatically.`) : null;
  const coinRow = (c: FeeTotals & { mint: string; symbol: string }) => h('tr', {},
    h('td', {}, h('a', { href: `#/t/${c.mint}` }, `$${c.symbol}`)), h('td', { class: 'num' }, String(c.trades)), h('td', { class: 'num' }, vol(c.volumeQuoteRaw)),
    h('td', { class: 'num' }, fee(c.feesRaw)), h('td', { class: 'num' }, fee(c.creatorRaw)), h('td', { class: 'num' }, fee(c.platformRaw)), h('td', { class: 'num' }, fee(c.lpRaw)),
    h('td', { class: 'num' }, fee(c.protocolRaw)), h('td', { class: 'num' }, c.unknownTrades ? String(c.unknownTrades) : '—'));
  const coinHead: [string, string][] = [['Coin', ''], ['Trades', 'num'], ['Volume', 'num'], ['Fees paid', 'num'], ['To creator', 'num'], ['To platform', 'num'], ['To LPs', 'num'], ['To Meteora', 'num'], ['Unconfirmed', 'num']];
  const input = h('input', { type: 'text', placeholder: 'Wallet address', value: wallet ?? state.wallet?.account.address ?? '', 'aria-label': 'Wallet address', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const go = (e: Event) => { e.preventDefault(); const v = input.value.trim(); if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) location.hash = `#/fees/${v}`; else toast('That is not a wallet address.', 'err'); };
  const lookup = h('form', { class: 'fee-lookup', onsubmit: go }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Look up'), wallet ? h('a', { class: 'btn ghost', href: '#/fees' }, 'All traders') : null);
  const head = h('div', { class: 'earn-head' }, h('h1', {}, wallet ? 'Fees paid by a wallet' : 'Trading fees'),
    h('p', { class: 'dim' }, 'Every fee is read from the swap record the pool program wrote in that trade\'s own transaction, so each figure links to a transaction anyone can check. Devnet test tokens with no value. Read-only.'), lookup);
  const notes = h('div', { class: 'card about' }, h('span', { class: 'eyebrow' }, 'How to read this'), h('ul', { class: 'notes' },
    h('li', {}, 'A fee is what a trader paid on a trade. On the bonding curve it is split between the coin\'s creator and the platform by the coin\'s fee settings, plus Meteora\'s protocol share. After graduation it goes to the pool\'s liquidity positions (the creator\'s and the platform\'s locked positions) plus Meteora\'s share.'),
    h('li', {}, h('span', {}, 'Fees paid are not owed back. This record sets how much is earmarked for ', h('a', { href: '#/rewards' }, 'holder rewards'),
      '. An earmark is not money: only rewards deposited into the rewards vault are paid, and who receives them is set by balances over time, not by trading.')),
    h('li', {}, 'Earnings checks that these per-trade figures add up to what the pools hold plus what was claimed.')));
  if (w) {
    const rows = w.trades.map((x) => h('tr', {},
      h('td', {}, h('a', { href: `#/t/${x.mint}` }, `$${x.symbol}`)), h('td', { class: x.side === 'BUY' ? 'buy' : 'sell' }, x.side === 'BUY' ? 'Buy' : 'Sell'),
      h('td', {}, x.venue === 'DAMM_V2' ? 'DAMM v2' : x.venue === 'CURVE' ? 'Curve' : '—'), h('td', { class: 'num' }, vol(x.quoteRaw)), feeCell(x.fees, q.decimals),
      h('td', { class: 'dim' }, x.blockTime ? ago(x.blockTime) : `slot ${x.slot}`), h('td', { class: 'mono' }, ext(explorer('tx', x.sig), short(x.sig, 4)))));
    main.replaceChildren(h('section', { class: 'earnings' }, head,
      h('p', { class: 'mono small' }, ext(explorer('address', w.wallet), w.wallet)),
      h('div', { class: 'kpis' }, kpi('Fees paid', fee(t.feesRaw), `${t.trades} ${t.trades === 1 ? 'trade' : 'trades'}, ${vol(t.volumeQuoteRaw)}`),
        kpi('To creators', fee(t.creatorRaw), 'bonding-curve share'), kpi('To the platform', fee(t.platformRaw), 'bonding-curve share'),
        kpi('To liquidity positions', fee(t.lpRaw), 'after graduation')),
      unknownNote(t.unknownTrades),
      h('div', { class: 'card' }, h('h3', {}, 'Per coin'), table(coinHead, w.coins.map(coinRow), 'This wallet has no trades on the launchpad.')),
      h('div', { class: 'card' }, h('h3', {}, 'Every trade'), table([['Coin', ''], ['Side', ''], ['Venue', ''], ['Amount', 'num'], ['Fee paid', 'num'], ['When', ''], ['Tx', '']], rows, 'No trades.')),
      notes));
    return;
  }
  const a = all!;
  const walletRows = a.wallets.map((x) => h('tr', {}, h('td', { class: 'mono' }, h('a', { href: `#/fees/${x.trader}` }, short(x.trader))),
    h('td', { class: 'num' }, String(x.trades)), h('td', { class: 'num' }, vol(x.volumeQuoteRaw)), h('td', { class: 'num' }, fee(x.feesRaw)),
    h('td', { class: 'num' }, x.unknownTrades ? String(x.unknownTrades) : '—')));
  main.replaceChildren(h('section', { class: 'earnings' }, head,
    h('div', { class: 'kpis' }, kpi('Fees paid by all traders', fee(t.feesRaw), `${t.trades} trades by ${a.walletCount} ${a.walletCount === 1 ? 'wallet' : 'wallets'}`),
      kpi('To creators', fee(t.creatorRaw), 'bonding-curve share'), kpi('To the platform', fee(t.platformRaw), 'bonding-curve share'),
      kpi('To liquidity positions', fee(t.lpRaw), 'after graduation')),
    unknownNote(t.unknownTrades),
    h('div', { class: 'card' }, h('h3', {}, 'Per coin'), table(coinHead, a.coins.map(coinRow), 'No trades yet.')),
    h('div', { class: 'card' }, h('h3', {}, a.walletCount > a.wallets.length ? `Per wallet (top ${a.wallets.length} of ${a.walletCount})` : 'Per wallet'),
      table([['Wallet', ''], ['Trades', 'num'], ['Volume', 'num'], ['Fees paid', 'num'], ['Unconfirmed', 'num']], walletRows, 'No trades yet.')),
    notes));
}

// ------------------------------------------------------------------ holder rewards (read-only)
interface CoverageCheck { id: string; ok: boolean; detail: string }
interface HolderCoverage { status: 'COMPLETE' | 'CATCHING_UP' | 'MISMATCH'; checkedAtSlot: number; checkedAt: string; accounts: number; transactions: number; pending: number;
  failed: number; changes: number; checks: CoverageCheck[]; providers: 'SINGLE_PROVIDER' }
interface EpochFunding { earmarkedRaw: string; earmarkTrades: number; unknownFeeTrades: number; fundedRaw: string; poolCarryInRaw: string; deposits: { sig: string; amountRaw: string }[];
  lateDeposits?: { sig: string; amountRaw: string }[] }
type SettlementStatus = 'NOTHING_TO_PAY' | 'NOT_PAID' | 'PAID' | 'PARTLY_PAID' | 'MISMATCH';
interface SettlementView { status: SettlementStatus; adapter: string; paidRaw: string; reasons: string[];
  txs: { sig: string; slot: number; blockTime: number | null; artifactHash: string; paidRaw: string; transfers: { owner: string; amountRaw: string }[] }[] }
interface RewardsVaultView { multisig: string; vault: string; quoteAccount: string; balanceRaw: string | null; checkedToSlot: number | null; caughtUp: boolean;
  untagged: { sig: string; deltaRaw: string }[]; threshold: number; members: number }
interface EpochWindowView { startSec: number; endSec: number; startSlot: number | null; endSlot: number | null; nextStartSlot: number | null; slots: number }
type EpochStatus = 'FINAL' | 'OPEN' | 'INCOMPLETE';
interface Frozen { hash: string; finalizedAt: string; reproduced: boolean }
interface RewardRules { strategy: string; funding: string; allocation: string; settlement: { mainnet: boolean; devnet: string; note: string } }
interface RewardsOverview { cluster: string; label: string; rules: RewardRules; rewardsVault: RewardsVaultView | null;
  policies: { exclusion: { version: string }; allocation: { version: string }; earmark: { economicsVersion: string; partnerRewardsSplitPct: number; label: string } };
  coins: { mint: string; symbol: string; status: string; coverage: HolderCoverage | null; totals: { earmarkedRaw: string; depositedRaw: string; allocatedRaw: string };
    epochs: { epochId: string; status: EpochStatus; reasons: string[]; window: EpochWindowView; holders: number; excluded: number; funding: EpochFunding;
      totalAllocatedRaw: string; merkleRoot: string | null; artifactHash: string | null; frozen: Frozen | null; settlement: { status: SettlementStatus; paidRaw: string; txs: string[] } }[] }[] }
interface EpochDetailView { mint: string; symbol: string; label: string; rules: RewardRules; coverage: HolderCoverage | null;
  epoch: { epochId: string; status: EpochStatus; reasons: string[]; window: EpochWindowView; funding: EpochFunding; poolRollForwardRaw: string; merkleRoot: string | null;
    holders: { owner: string; balanceUnits: string; averageRaw: string; shareBps: number; allocationRaw: string; carryOutRaw: string }[];
    excluded: { owner: string; reason: string; balanceUnits: string }[];
    payouts: { owner: string; amountRaw: string; leaf: string; proof: string[] }[]; artifactHash: string | null; frozen: Frozen | null; settlement: SettlementView } }
/** #/rewards/<mint>/<YYYY-MM-DD>, or null on any other page. */
const rewardsEpoch = () => { const x = /^#\/rewards\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(\d{4}-\d{2}-\d{2})$/.exec(location.hash); return x ? { mint: x[1]!, epochId: x[2]! } : null; };
const baseDecimals = () => Number(state.platform?.platform?.launchEconomics?.baseDecimals ?? 6);
const EXCLUSION_TEXT: Record<string, string> = {
  QF_OPERATOR: 'platform operator wallet', QF_PLATFORM_FEE_CLAIMER: 'platform fee claimer', QF_TREASURY_MULTISIG: 'treasury multisig', QF_TREASURY_VAULT: 'treasury vault',
  DBC_POOL_AUTHORITY: 'bonding-curve pool', DAMM_V2_POOL_AUTHORITY: 'graduated pool', BURN_ADDRESS: 'burn address',
};
const exclusionText = (r: string) => EXCLUSION_TEXT[r] ?? (r.startsWith('OFF_CURVE_OWNER') ? 'program account (a pool, vault or program, not a wallet)' : r);
function epochStatusLabel(s: EpochStatus) {
  return s === 'FINAL' ? h('span', { class: 'check-ok' }, 'final') : s === 'OPEN' ? h('span', { class: 'check-residual' }, 'running') : h('span', { class: 'check-bad' }, 'not final');
}
function coverageLabel(c: HolderCoverage | null) {
  if (!c) return h('span', { class: 'dim' }, 'not read yet');
  return c.status === 'COMPLETE' ? h('span', { class: 'check-ok' }, 'complete') : c.status === 'CATCHING_UP' ? h('span', { class: 'check-residual' }, 'catching up') : h('span', { class: 'check-bad' }, 'does not match the chain');
}
const COVERAGE_CHECK_TEXT: Record<string, string> = {
  ALL_TRANSACTIONS_READ: 'Every transaction that touched a holder account is read',
  REPLAYS_CLEANLY: 'Every account replays from its creation without a gap',
  REPLAY_EQUALS_CHAIN: 'Replayed balances equal the chain (closed accounts replay to zero)',
  ACCOUNTS_ADD_UP_TO_SUPPLY: 'The accounts on chain add up to the supply',
};
const utcDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
function settlementLabel(st: SettlementStatus) {
  return st === 'PAID' ? h('span', { class: 'check-ok' }, 'paid') : st === 'NOT_PAID' ? h('span', { class: 'check-residual' }, 'not paid yet')
    : st === 'PARTLY_PAID' ? h('span', { class: 'check-residual' }, 'partly paid') : st === 'MISMATCH' ? h('span', { class: 'check-bad' }, 'does not match the record') : h('span', { class: 'dim' }, '—');
}
/** The rewards vault: where deposits land and payouts leave, and how far its history is read. */
function rewardsVaultCard(v: RewardsVaultView, amt: (raw: string) => string) {
  const stat = (k: string, val: string | HTMLElement, sub: string) => h('div', {}, h('span', { class: 'k' }, k), h('span', { class: 'v' }, val), h('span', { class: 'dim small' }, sub));
  return h('div', { class: 'card treasury' },
    h('div', { class: 'tr-head' }, h('h3', {}, 'Rewards vault'), h('span', { class: 'chip warn' }, 'devnet stand-in'), h('span', { class: 'chip warn' }, 'test signers, one operator')),
    h('div', { class: 'kpis' },
      stat('Holds', v.balanceRaw === null ? '—' : amt(v.balanceRaw), 'deposited and not yet paid'),
      stat('Approvals to move funds', `${v.threshold} of ${v.members}`, 'the treasury members'),
      stat('History read to', v.checkedToSlot === null ? '—' : `slot ${v.checkedToSlot.toLocaleString()}`, v.caughtUp ? 'every transaction read' : 'catching up'),
      stat('Vault', h('span', { class: 'mono' }, ext(explorer('address', v.vault), short(v.vault))), 'treasury multisig, vault index 1')),
    h('p', { class: 'dim small', style: { margin: '12px 0 0' } }, 'Deposits and payouts are read from this vault\'s own transactions. Each carries a memo naming the coin and day. A deposit funds that day only if it lands before the day ends. A payout must pay exactly what the day\'s frozen record allocates.'),
    v.untagged.length ? h('p', { class: 'err small', style: { margin: '8px 0 0' } }, `${v.untagged.length} transfer(s) without a rewards memo: listed, never counted.`) : null);
}
/** The funding rule and the payout switch, in the server's words; on every rewards page. */
function rewardsRulesCard(r: RewardRules) {
  return h('div', { class: 'card treasury' },
    h('div', { class: 'tr-head' }, h('h3', {}, 'Where rewards come from'), h('span', { class: 'chip warn' }, r.settlement.devnet === 'ONE_TEST_ROUND' ? 'one devnet test round' : 'no payouts'),
      h('span', { class: 'chip legacy' }, r.settlement.mainnet ? 'mainnet on' : 'mainnet off')),
    h('ul', { class: 'notes' }, h('li', {}, r.funding), h('li', {}, r.allocation), h('li', { class: 'err' }, r.settlement.note)));
}

async function renderRewards(fresh = false) {
  const main = $('#view');
  const q = Q();
  if (!fresh) main.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  let o: RewardsOverview;
  try { o = await api<RewardsOverview>(`/api/lp/rewards${fresh ? '?fresh=1' : ''}`); }
  catch (err) { if (!fresh) main.replaceChildren(h('div', { class: 'empty err' }, `Rewards unavailable (${(err as Error).message}).`)); else toast(`Refresh failed: ${(err as Error).message}`, 'err'); return; }
  if (location.hash !== '#/rewards') return;
  const amt = (raw: string) => `${units(raw, q.decimals, 6)} ${q.symbol}`;
  const kpi = (k: string, v: string, sub: string) => h('div', {}, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), h('span', { class: 'dim small' }, sub));
  const sum = (f: (c: RewardsOverview['coins'][number]) => string) => o.coins.reduce((s, c) => s + BigInt(f(c)), 0n).toString();
  const complete = o.coins.filter((c) => c.coverage?.status === 'COMPLETE').length;
  const refresh = h('button', { class: 'btn ghost sm', onclick: async () => { refresh.setAttribute('disabled', ''); await renderRewards(true); } }, 'Refresh');
  const coinCard = (c: RewardsOverview['coins'][number]) => {
    const cov = c.coverage;
    const rows = [...c.epochs].reverse().map((e) => h('tr', {},
      h('td', {}, e.window.slots ? h('a', { href: `#/rewards/${c.mint}/${e.epochId}` }, e.epochId) : e.epochId),
      h('td', {}, epochStatusLabel(e.status), e.reasons.length ? h('span', { class: 'dim small reason' }, e.reasons[0]!) : null),
      h('td', { class: 'num' }, String(e.holders), e.excluded ? h('span', { class: 'dim small reason' }, `${e.excluded} excluded`) : null),
      h('td', { class: 'num' }, amt(e.funding.earmarkedRaw), e.funding.earmarkTrades ? h('span', { class: 'dim small reason' }, `from ${e.funding.earmarkTrades} ${e.funding.earmarkTrades === 1 ? 'trade' : 'trades'}`) : null),
      h('td', { class: 'num' }, amt(e.funding.fundedRaw)),
      h('td', { class: 'num' }, amt(e.totalAllocatedRaw)),
      h('td', {}, settlementLabel(e.settlement.status), e.settlement.txs[0] ? h('span', { class: 'small reason' }, ext(explorer('tx', e.settlement.txs[0]), short(e.settlement.txs[0], 4))) : null),
      h('td', { class: 'mono' }, e.frozen ? h('span', { title: `frozen ${e.frozen.finalizedAt}; artifact sha256 ${e.frozen.hash}` }, short(e.frozen.hash, 6),
        h('span', { class: `small reason ${e.frozen.reproduced ? 'check-ok' : 'check-bad'}` }, e.frozen.reproduced ? 'frozen, recomputed identically' : 'recomputed differently')) : h('span', { class: 'dim' }, e.status === 'OPEN' ? 'after it ends' : '—'))));
    return h('div', { class: 'card' },
      h('div', { class: 'tr-head rw-head' }, h('h3', {}, h('a', { href: `#/t/${c.mint}` }, `$${c.symbol}`)), h('span', { class: 'dim small' }, c.status === 'MIGRATED' ? 'graduated' : 'bonding'),
        h('span', { class: 'small' }, 'Holder history: ', coverageLabel(cov))),
      cov ? h('details', { class: 'rw-checks' }, h('summary', { class: 'dim small' },
        `${cov.accounts} token ${cov.accounts === 1 ? 'account' : 'accounts'}, ${cov.transactions} ${cov.transactions === 1 ? 'transaction' : 'transactions'}, checked against the chain at slot ${cov.checkedAtSlot} (${ago(cov.checkedAt)}), one RPC provider`),
        h('ul', { class: 'notes' }, ...cov.checks.map((x) => h('li', {}, h('span', { class: x.ok ? 'check-ok' : 'check-bad' }, x.ok ? 'Yes' : 'No'), ` ${COVERAGE_CHECK_TEXT[x.id] ?? x.id}. `, h('span', { class: 'small' }, x.detail))))) : null,
      h('p', { class: 'scroll-hint dim small' }, 'Swipe the table sideways to see every column.'),
      h('div', { class: 'scroll' }, h('table', { class: 'trades' },
        h('thead', {}, h('tr', {}, ...[['Epoch (UTC day)', ''], ['Status', ''], ['Holders', 'num'], ['Earmarked', 'num'], ['Funded', 'num'], ['Allocated', 'num'], ['Paid', ''], ['Artifact', '']].map(([x, cls]) => h('th', { class: cls }, x)))),
        h('tbody', {}, ...rows))));
  };
  main.replaceChildren(h('section', { class: 'earnings' },
    h('div', { class: 'earn-head' }, h('h1', {}, 'Holder rewards'),
      h('p', { class: 'dim' }, `Each coin's holders, day by day, from every wallet's balance over time. ${o.label}. Read-only: nothing on this page moves funds.`),
      h('div', { class: 'asof' }, h('span', { class: 'dim small' }, `Recomputed from the stored history (${complete} of ${o.coins.length} coins' history proven); kept for up to 30 seconds.`), refresh)),
    h('div', { class: 'kpis' },
      kpi('Earmarked', amt(sum((c) => c.totals.earmarkedRaw)), `${o.policies.earmark.partnerRewardsSplitPct}% of platform fees · not money`),
      kpi('Deposited', amt(sum((c) => c.totals.depositedRaw)), o.rewardsVault ? 'into the rewards vault, counted' : 'no rewards vault yet'),
      kpi('Allocated to holders', amt(sum((c) => c.totals.allocatedRaw)), 'only deposits are allocated · includes running days'),
      kpi('Paid to holders', amt(o.coins.reduce((t, c) => t + c.epochs.reduce((x, e) => x + BigInt(e.settlement.paidRaw), 0n), 0n).toString()), 'read back from the vault\'s own transactions')),
    rewardsRulesCard(o.rules),
    o.rewardsVault ? rewardsVaultCard(o.rewardsVault, amt) : null,
    ...(o.coins.length ? o.coins.map(coinCard) : [h('div', { class: 'card' }, h('p', { class: 'dim', style: { margin: '0' } }, 'No coins yet.'))]),
    h('div', { class: 'card about' }, h('span', { class: 'eyebrow' }, 'How to read this'), h('ul', { class: 'notes' },
      h('li', {}, 'An epoch is one UTC day, from the first finalized slot of that day to the first slot of the next.'),
      h('li', {}, 'A holder\'s weight is their balance averaged over every slot of the epoch. Buys, sells and direct transfers between wallets all count, each read from its own transaction.'),
      h('li', {}, `Pools, vaults, program accounts, the platform's own wallets and burn addresses are excluded (${o.policies.exclusion.version}). Allocation policy ${o.policies.allocation.version}.`),
      h('li', {}, 'Earmarked is what the fee ledger sets aside for holder rewards from the platform\'s share of each epoch\'s trading fees. It is a count, not money. Funded is what was deposited into the rewards vault for that epoch, plus any remainder carried from the epoch before. Only funded amounts are allocated.'),
      h('li', {}, 'An epoch becomes final once it has ended and its holder history is proven complete through its last slot. Its result is then frozen with a hash, and every later recomputation must give the same hash.')))));
}

/** Funding (deposits, read from the vault) and settlement (payouts, read from the vault) of one epoch. */
function settlementCard(d: EpochDetailView, amt: (raw: string) => string) {
  const e = d.epoch, st = e.settlement, f = e.funding;
  const paidTo = new Map<string, bigint>();
  for (const t of st.txs) for (const x of t.transfers) paidTo.set(x.owner, (paidTo.get(x.owner) ?? 0n) + BigInt(x.amountRaw));
  // largest first, like the holders table (the payout transaction itself pays in the record's order)
  const rows = [...e.payouts].sort((a, b) => (BigInt(b.amountRaw) > BigInt(a.amountRaw) ? 1 : BigInt(b.amountRaw) < BigInt(a.amountRaw) ? -1 : 0)).map((p) => {
    const got = paidTo.get(p.owner);
    return h('tr', {}, h('td', { class: 'mono' }, ext(explorer('address', p.owner), short(p.owner))), h('td', { class: 'num' }, amt(p.amountRaw)),
      h('td', { class: 'num' }, got === undefined ? h('span', { class: 'dim' }, '—') : h('span', { class: got === BigInt(p.amountRaw) ? 'check-ok' : 'check-bad' }, amt(got.toString()))));
  });
  const txLink = (sig: string) => ext(explorer('tx', sig), short(sig, 6));
  return h('div', { class: 'card' }, h('h3', {}, 'Funding and payout'),
    h('ul', { class: 'notes' },
      f.deposits.length ? h('li', {}, h('span', {}, `Deposited ${amt(f.deposits.reduce((t, x) => t + BigInt(x.amountRaw), 0n).toString())} into the rewards vault for this day: `), ...f.deposits.map((x) => txLink(x.sig)))
        : h('li', {}, 'Nothing was deposited for this day, so nothing is allocated.'),
      BigInt(f.poolCarryInRaw) ? h('li', {}, `${amt(f.poolCarryInRaw)} carried in from the day before (rounding remainder).`) : null,
      f.lateDeposits?.length ? h('li', { class: 'err' }, `${f.lateDeposits.length} deposit(s) tagged for this day landed after it ended. They stay in the vault and fund nothing.`) : null,
      h('li', {}, h('span', {}, 'Payout: '), e.status === 'OPEN' && !st.txs.length ? h('span', { class: 'dim' }, 'after the day ends and its record is frozen') : settlementLabel(st.status), st.txs.length ? h('span', {}, ' in ', ...st.txs.map((t) => txLink(t.sig))) : null,
        st.status === 'NOT_PAID' ? h('span', { class: 'dim' }, '. A payout needs 2 of 3 treasury approvals and pays exactly the amounts below.') : null),
      ...st.reasons.map((r) => h('li', { class: 'err' }, r))),
    rows.length ? h('p', { class: 'scroll-hint dim small' }, 'Swipe the table sideways to see every column.') : null,
    rows.length ? h('div', { class: 'scroll', style: { marginTop: '12px' } }, h('table', { class: 'trades' }, h('thead', {}, h('tr', {}, h('th', {}, 'Wallet'), h('th', { class: 'num' }, 'Allocated'), h('th', { class: 'num' }, 'Received'))),
      h('tbody', {}, ...rows))) : null);
}

async function renderRewardEpoch(mint: string, epochId: string) {
  const main = $('#view');
  const q = Q();
  main.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  let d: EpochDetailView;
  try { d = await api<EpochDetailView>(`/api/lp/rewards/${mint}/${epochId}`); }
  catch (err) { main.replaceChildren(h('div', { class: 'empty err' }, `This epoch is unavailable (${(err as Error).message}).`), h('p', {}, h('a', { href: '#/rewards' }, 'All coins'))); return; }
  const cur = rewardsEpoch();
  if (!cur || cur.mint !== mint || cur.epochId !== epochId) return;
  const e = d.epoch, w = e.window;
  const amt = (raw: string) => `${units(raw, q.decimals, 6)} ${q.symbol}`;
  const bal = (raw: string) => `${units(raw, baseDecimals(), 2)} $${d.symbol}`;
  const avg = (u: string) => (w.slots ? bal((BigInt(u) / BigInt(w.slots)).toString()) : '—');
  const kpi = (k: string, v: string | HTMLElement, sub: string) => h('div', {}, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), h('span', { class: 'dim small' }, sub));
  const table = (head: [string, string][], body: HTMLElement[], empty: string) => body.length
    ? h('div', {}, h('p', { class: 'scroll-hint dim small' }, 'Swipe the table sideways to see every column.'),
      h('div', { class: 'scroll' }, h('table', { class: 'trades' }, h('thead', {}, h('tr', {}, ...head.map(([c, cls]) => h('th', { class: cls }, c)))), h('tbody', {}, ...body))))
    : h('p', { class: 'dim', style: { margin: '0' } }, empty);
  const holderRows = e.holders.map((x) => h('tr', {}, h('td', { class: 'mono' }, ext(explorer('address', x.owner), short(x.owner))),
    h('td', { class: 'num' }, bal(x.averageRaw)), h('td', { class: 'num' }, x.shareBps === 0 && BigInt(x.balanceUnits) > 0n ? 'under 0.01%' : pct(x.shareBps)), h('td', { class: 'num' }, amt(x.allocationRaw)),
    h('td', { class: 'num' }, BigInt(x.carryOutRaw) ? amt(x.carryOutRaw) : '—')));
  const excludedRows = e.excluded.map((x) => h('tr', {}, h('td', { class: 'mono' }, ext(explorer('address', x.owner), short(x.owner))),
    h('td', {}, exclusionText(x.reason)), h('td', { class: 'num' }, avg(x.balanceUnits))));
  const artifactHref = `/api/lp/rewards/${mint}/${epochId}/artifact.json`;
  const f = e.funding;
  main.replaceChildren(h('section', { class: 'earnings' },
    h('div', { class: 'earn-head' }, h('p', { class: 'small' }, h('a', { href: '#/rewards' }, 'Holder rewards')),
      h('h1', { class: 'rw-title' }, h('span', {}, `$${d.symbol}`), h('span', { class: 'dim' }, ` · ${e.epochId}`)),
      h('p', { class: 'dim' }, w.startSlot === null ? `${utcDay(w.startSec)} UTC. The chain has not reached this day yet.`
        : `${utcDay(w.startSec)} UTC, slots ${w.startSlot.toLocaleString()} to ${w.endSlot === null ? 'now' : w.endSlot.toLocaleString()} (${w.slots.toLocaleString()} slots${w.nextStartSlot === null ? ', still running' : ''}). ${d.label}.`)),
    h('div', { class: 'kpis' },
      kpi('Status', epochStatusLabel(e.status), e.status === 'FINAL' ? 'frozen, cannot change' : e.status === 'OPEN' ? 'a preview until the day ends' : 'ended, not proven yet'),
      kpi('Holders', String(e.holders.length), `${e.excluded.length} excluded`),
      kpi('Earmarked', amt(f.earmarkedRaw), `from ${f.earmarkTrades} ${f.earmarkTrades === 1 ? 'trade' : 'trades'} · not money`),
      kpi('Funded', amt(f.fundedRaw), f.deposits.length ? `${f.deposits.length} ${f.deposits.length === 1 ? 'deposit' : 'deposits'}` : 'nothing deposited')),
    e.reasons.length ? h('div', { class: 'cov-notes' }, h('p', { class: 'small' }, 'Why this epoch is not final:'), h('ul', { class: 'notes err small' }, ...e.reasons.map((r) => h('li', {}, r)))) : null,
    rewardsRulesCard(d.rules),
    h('div', { class: 'card' }, h('h3', {}, 'Holders and their share'),
      h('p', { class: 'dim small', style: { margin: '0 0 12px' } }, 'Average balance over every slot of the epoch, from the coin\'s full transfer history. The share is of all eligible holders. The allocation divides only what was funded, so it is zero while nothing is deposited.'),
      table([['Wallet', ''], ['Average balance', 'num'], ['Share', 'num'], ['Allocation', 'num'], ['Carried to next epoch', 'num']], holderRows, 'No eligible holders in this epoch.')),
    settlementCard(d, amt),
    h('div', { class: 'card' }, h('h3', {}, 'Excluded'),
      table([['Owner', ''], ['Why', ''], ['Average balance', 'num']], excludedRows, 'Nothing excluded.')),
    h('div', { class: 'card about' }, h('span', { class: 'eyebrow' }, 'Result record'),
      e.artifactHash ? h('ul', { class: 'notes' },
        h('li', { class: 'mono small' }, `sha256 ${e.artifactHash}`),
        e.frozen ? h('li', {}, `Frozen ${new Date(e.frozen.finalizedAt).toLocaleString()}. `, h('span', { class: e.frozen.reproduced ? 'check-ok' : 'check-bad' }, e.frozen.reproduced ? 'Recomputed just now with the same hash.' : 'Recomputed just now with a different hash.'))
          : h('li', {}, 'Not frozen: the epoch is not final.'),
        e.merkleRoot ? h('li', { class: /^0+$/.test(e.merkleRoot) ? 'small' : 'mono small' }, /^0+$/.test(e.merkleRoot) ? 'Merkle root: empty, nothing was allocated.' : `Merkle root ${e.merkleRoot}`) : null,
        h('li', {}, h('a', { href: artifactHref, target: '_blank', rel: 'noopener' }, 'Open the record (JSON)'), ': inputs hash, window, policies, funding, exclusions and allocation.'))
        : h('p', { class: 'dim' }, 'A record is written once the epoch has ended.'))));
}

// ------------------------------------------------------------------ network status (read-only)
/** Why sending is locked on this network, in the server's own words. */
function lockedPanel(title: string) {
  const p = state.platform!;
  return h('section', { class: 'status' }, h('div', { class: 'card' }, h('h1', {}, title),
    h('p', { class: 'dim' }, `This server runs on ${isMainnet() ? 'mainnet' : 'devnet'} and cannot build or send transactions there yet.`),
    h('ul', { class: 'notes' }, ...p.writesLockedBecause.map((w) => h('li', {}, w))),
    h('p', {}, h('a', { href: '#/status' }, 'See the full network status'))));
}
function renderStatus() {
  const p = state.platform!;
  const ch = p.chainChecks;
  const stat = (k: string, v: string | HTMLElement, sub: string) => h('div', {}, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), h('span', { class: 'dim small' }, sub));
  const statusCell = (c: ChainCheck) => h('span', { class: c.status === 'MATCH' ? 'check-ok' : c.status === 'SINGLE_PROVIDER' ? 'check-residual' : 'check-bad', title: c.detail ?? '' },
    c.status === 'MATCH' ? 'both providers agree' : c.status === 'SINGLE_PROVIDER' ? 'one provider only' : c.status.toLowerCase().replace('_', ' '));
  const rows = (ch?.items ?? []).map((c) => h('tr', {}, h('td', {}, c.label), h('td', { class: 'mono' }, ext(explorer('address', c.address), short(c.address))), h('td', {}, statusCell(c)),
    h('td', { class: 'num dim' }, c.slots.join(' / '))));
  main_(h('section', { class: 'status earnings' },
    h('div', { class: 'earn-head' }, h('h1', {}, 'Network status'), h('p', { class: 'dim' }, `${p.label}.`)),
    h('div', { class: 'kpis' },
      stat('Network', p.cluster === 'devnet' ? 'devnet' : 'mainnet', p.mode === 'DEVNET' ? 'test network, valueless tokens' : 'real network'),
      stat('Sending', p.writesEnabled ? 'on' : 'locked', p.writesEnabled ? 'launch, trade, claim, treasury' : 'this server cannot send'),
      stat('Quote token', Q().symbol, Q().mint ? short(Q().mint) : '—'),
      stat('Mainnet readiness', p.readiness.MAINNET ?? '—', `${p.mainnetBlockers.length} open items`)),
    p.writesLockedBecause.length ? h('div', { class: 'card' }, h('h3', {}, 'Why sending is locked'), h('ul', { class: 'notes' }, ...p.writesLockedBecause.map((w) => h('li', {}, w)))) : null,
    ch ? h('div', { class: 'card' }, h('h3', {}, 'What this server reads from chain'),
      h('p', { class: 'dim small', style: { margin: '0 0 12px' } }, ch.crossChecked
        ? `Read at ${new Date(ch.at).toLocaleTimeString()} from two RPC providers at finalized commitment and compared.`
        : `Read at ${new Date(ch.at).toLocaleTimeString()} from one RPC provider. A second provider is needed before any mainnet decision.`),
      ch.problems.length ? h('ul', { class: 'notes err' }, ...ch.problems.map((x) => h('li', {}, x))) : null,
      h('div', { class: 'scroll' }, h('table', { class: 'trades' }, h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', {}, 'Address'), h('th', {}, 'Check'), h('th', { class: 'num' }, 'Slot'))), h('tbody', {}, ...rows)))) : null,
    h('div', { class: 'card' }, h('h3', {}, 'Before mainnet can go live'), h('p', { class: 'dim small', style: { margin: '0 0 8px' } }, 'From the readiness record in the code. Each item is closed by the owner or a reviewer, not by this server.'),
      h('ul', { class: 'notes' }, ...p.mainnetBlockers.map((b) => h('li', {}, b))))));
}
const main_ = (...c: HTMLElement[]) => $('#view').replaceChildren(...c);

// ------------------------------------------------------------------ router + boot
async function route() {
  clearInterval(tokenTimer);
  if ($('.sheet .x')) closeModal(); // a finished or idle dialog never follows you to another page; a running signing flow has no close button
  const m = currentMint();
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === (m ? '' : location.hash || '#/')));
  const fw = feesWallet();
  if (fw !== undefined) document.querySelector('nav a[href="#/fees"]')?.classList.add('on');
  const re = rewardsEpoch();
  if (re) document.querySelector('nav a[href="#/rewards"]')?.classList.add('on');
  if (m || fw !== undefined || re || location.hash === '#/create' || location.hash === '#/earnings' || location.hash === '#/rewards' || location.hash === '#/status') $('#tape').hidden = true;
  if (m) await renderToken(m);
  else if (fw !== undefined) await renderFees(fw);
  else if (re) await renderRewardEpoch(re.mint, re.epochId);
  else if (location.hash === '#/rewards') await renderRewards();
  else if (location.hash === '#/status') renderStatus();
  else if (location.hash === '#/create') renderCreate();
  else if (location.hash === '#/earnings') await renderEarnings();
  else await renderHome();
  document.body.dataset.ready = 'true';
}

async function boot() {
  startWalletDiscovery();
  onWalletsChanged(() => { if (!$('#modal').hidden && $('.wlist, .sheet p.dim')) openWalletPicker(); });
  try { state.platform = await api<Platform>('/api/lp/platform'); }
  catch (e) { $('#view').replaceChildren(h('div', { class: 'empty err' }, `Launchpad API unavailable: ${(e as Error).message}`)); return; }
  const q = Q();
  setExplorerCluster(state.platform.cluster);
  if (isMainnet()) {
    $('#netbar').classList.add('mainnet');
    $('#netbar .pill').textContent = 'MAINNET · READ-ONLY';
    $('#netnote').replaceChildren('Real network, read-only. Launching, trading and claiming are locked until mainnet is approved. ', h('a', { href: '#/status' }, 'Why'));
    document.title = 'QF Launchpad (mainnet, read-only)';
    $('.foot').textContent = 'Meteora Dynamic Bonding Curve to DAMM v2 · mainnet read-only build · this server cannot send transactions';
  } else $('#netnote').textContent = state.platform.ready
    ? `Test network. ${q.symbol} and every coin here have no value. Mainnet is off.`
    : 'Devnet platform not set up yet (the operator wallet needs devnet SOL). Browsing works; launching does not.';
  renderWallet();
  window.addEventListener('hashchange', route);
  const search = $('#q') as HTMLInputElement;
  search.addEventListener('input', () => {
    state.query = search.value;
    if (location.hash !== '' && location.hash !== '#/') location.hash = '#/';
    else paintGrid?.();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('.sheet .x')) closeModal(); });
  await route();
}
void boot();
