// Devnet launchpad UI. Talks only to the same-origin launchpad API (CSP connect-src 'self') and to the person's wallet
// through Wallet Standard. Every string that came from a creator or from chain data is rendered with textContent.
import { economicsDigest } from '@project-qf/policy';
import { addSignature, fromBase64, generateMintKey, toBase64, type ApprovedTerms } from '@project-qf/tx';
import { ago, compact, explorer, parseUnits, pct, price, short, units } from './format.ts';
import { checkBuiltTransaction, type Check, type Expectation } from './txcheck.ts';
import { connect, disconnect, listWallets, onWalletsChanged, signTransaction, startWalletDiscovery, type Connected } from './wallet.ts';

// ------------------------------------------------------------------ types from lp-api/1
interface Platform {
  ready: boolean; cluster: 'devnet'; operator: string | null; readiness: Record<string, string>;
  platform: null | { quote: { mint: string; decimals: number; symbol: string; label: string }; config: string; threshold: { rawQuoteThreshold: string };
    launchEconomics: any; launchEconomicsDigest: string; economicsVersion: string; templateVersion: string };
  faucet: { quoteUi: string; lamports: string; claimsPerDay: number };
}
interface Live { priceQuotePerBase: string; marketCapQuoteRaw: string; quoteReserve: string; migrationQuoteThreshold: string; progressBps: number;
  curveComplete: boolean; isMigrated: boolean; baseDecimals: number; quoteDecimals: number; totalSupplyRaw: string; creatorQuoteFee: string }
interface Token { mint: string; pool: string; name: string; symbol: string; description: string; imageUrl: string | null; creator: string; status: string;
  createdAt: string; liveAt: string | null; website: string | null; twitter: string | null; telegram: string | null; createSig: string | null;
  migrationSig: string | null; dammPool: string | null; live: Live | null; stats: { count: number; volumeQuoteRaw: string; traders: number } }
interface Trade { sig: string; trader: string; side: 'BUY' | 'SELL'; quoteRaw: string; baseRaw: string; slot: number; blockTime: number | null }

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

// ------------------------------------------------------------------ state
const state: { platform: Platform | null; wallet: Connected | null; balances: { lamports: string; tokens: Record<string, string> } | null; tokens: Token[]; sort: 'new' | 'mcap' | 'progress' } =
  { platform: null, wallet: null, balances: null, tokens: [], sort: 'new' };
const Q = () => state.platform?.platform?.quote ?? { mint: '', decimals: 6, symbol: 'qUSD', label: 'TEST_ONLY' };

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
  return h('div', { class: `avatar ${size} gen`, 'data-hue': String(x % 12), 'aria-hidden': 'true' }, t.symbol.slice(0, 2).toUpperCase());
}

// ------------------------------------------------------------------ wallet UI
async function refreshBalances(mint?: string) {
  if (!state.wallet || !state.platform?.ready) { state.balances = null; renderWallet(); return; }
  try { state.balances = await api(`/api/lp/wallet/${state.wallet.account.address}${mint ? `?mint=${mint}` : ''}`); } catch { state.balances = null; }
  renderWallet();
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
    b ? h('span', { class: 'bal', title: 'devnet balances' }, `${units(b.tokens[q.mint] ?? '0', q.decimals, 0)} ${q.symbol}`, h('span', { class: 'dim' }, ` · ${units(b.lamports, 9, 3)} SOL`)) : null,
    h('button', { class: 'btn ghost', onclick: claimFaucet, title: 'TEST_ONLY devnet tokens with no value' }, `Get test ${q.symbol}`),
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
  return { el: h('div', {}, h('ol', { class: 'steps' }, ...items), checks, msg), set, checks, msg };
}
function renderChecks(ul: HTMLElement, cs: Check[]) {
  ul.replaceChildren(...cs.map((c) => h('li', { class: c.ok ? 'ok' : 'bad' }, c.ok ? '✓ ' : '✗ ', c.label, c.detail && !c.ok ? h('span', { class: 'dim' }, ` (${c.detail})`) : null)));
}

interface Built { intentId: string; transaction: string; terms: ApprovedTerms }
/** build -> verify in browser -> (mint signature) -> wallet signature -> submit. Returns the submit response. */
async function runSigningFlow<T>(title: string, build: () => Promise<Built>, expect: (b: Built) => Expectation, extraSigner?: { address: string; key: CryptoKey }): Promise<T | null> {
  const w = requireWallet();
  if (!w) return null;
  const v = stepsView(['Build transaction on the server', 'Verify it in your browser', 'Sign in your wallet', 'Confirm on devnet']);
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
    v.msg.textContent = `Approve the transaction in ${w.wallet.name}.`;
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

function progressBar(bps: number, complete: boolean) {
  return h('div', { class: `bar${complete ? ' done' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(bps / 100)) },
    h('div', { class: 'fill', style: { width: `${Math.min(100, bps / 100)}%` } }));
}
function statusChip(t: Token) {
  if (t.status === 'MIGRATED' || t.live?.isMigrated) return h('span', { class: 'chip grad' }, 'Graduated');
  if (t.live?.curveComplete) return h('span', { class: 'chip warn' }, 'Migrating');
  return h('span', { class: 'chip live' }, 'Bonding');
}

function tokenCard(t: Token) {
  const q = Q();
  const l = t.live;
  return h('a', { class: 'tcard', href: `#/t/${t.mint}` },
    h('div', { class: 'tc-top' }, avatar(t), h('div', { class: 'tc-id' }, h('div', { class: 'tc-name' }, t.name), h('div', { class: 'tc-sym' }, `$${t.symbol}`)), statusChip(t)),
    t.description ? h('p', { class: 'tc-desc' }, t.description) : null,
    h('div', { class: 'tc-stats' },
      h('div', {}, h('span', { class: 'k' }, 'Market cap'), h('span', { class: 'v' }, l ? `${compact(l.marketCapQuoteRaw, q.decimals)} ${q.symbol}` : '—')),
      h('div', {}, h('span', { class: 'k' }, 'Volume'), h('span', { class: 'v' }, `${compact(t.stats.volumeQuoteRaw, q.decimals)} ${q.symbol}`))),
    l ? progressBar(l.progressBps, l.curveComplete || l.isMigrated) : null,
    h('div', { class: 'tc-foot' }, h('span', {}, !l ? '' : l.isMigrated || t.status === 'MIGRATED' ? 'Graduated to DAMM v2' : l.curveComplete ? 'Curve full, graduating' : `${pct(l.progressBps)} to graduation`), h('span', { class: 'dim' }, `${ago(t.liveAt ?? t.createdAt)} · by ${short(t.creator)}`)));
}

async function renderHome() {
  const main = $('#view');
  const q = Q();
  const grid = h('div', { class: 'grid' }, h('div', { class: 'empty' }, 'Loading tokens…'));
  const sortBtn = (k: typeof state.sort, label: string) => h('button', { class: `tab${state.sort === k ? ' on' : ''}`, onclick: () => { state.sort = k; renderHome(); } }, label);
  main.replaceChildren(
    h('section', { class: 'hero' },
      h('div', {}, h('h1', {}, 'Launch a coin on a bonding curve in one signature.'),
        h('p', { class: 'lead' }, `Every coin starts on a Meteora Dynamic Bonding Curve priced in ${q.symbol}. At ${state.platform?.platform ? units(state.platform.platform.threshold.rawQuoteThreshold, q.decimals, 0) : '—'} ${q.symbol} raised it graduates to a Meteora DAMM v2 pool with its liquidity locked for good.`),
        h('div', { class: 'cta' }, h('a', { class: 'btn primary lg', href: '#/create' }, 'Create a coin'), h('button', { class: 'btn ghost lg', onclick: claimFaucet }, `Get test ${q.symbol}`))),
      h('div', { class: 'hero-art', 'aria-hidden': 'true' }, h('div', { class: 'orb a' }), h('div', { class: 'orb b' }), h('div', { class: 'orb c' }))),
    h('div', { class: 'section-head' }, h('h2', {}, 'Coins'), h('div', { class: 'tabs' }, sortBtn('new', 'Newest'), sortBtn('mcap', 'Market cap'), sortBtn('progress', 'About to graduate'))),
    grid);
  try {
    const { tokens } = await api<{ tokens: Token[] }>('/api/lp/tokens');
    state.tokens = tokens;
    const key = (t: Token) => state.sort === 'mcap' ? BigInt(t.live?.marketCapQuoteRaw ?? '0') : state.sort === 'progress' ? BigInt(t.live?.isMigrated ? -1 : (t.live?.progressBps ?? 0)) : BigInt(Date.parse(t.liveAt ?? t.createdAt));
    const sorted = [...tokens].sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0));
    grid.replaceChildren(...(sorted.length ? sorted.map(tokenCard) : [h('div', { class: 'empty' }, 'No coins yet. ', h('a', { href: '#/create' }, 'Launch the first one.'))]));
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
  if (!p) { main.replaceChildren(h('div', { class: 'empty' }, 'The devnet platform is not set up yet.')); return; }
  let imageDataUrl: string | null = null;
  const name = h('input', { id: 'f-name', maxLength: 32, placeholder: 'Moon Cat', required: true, autocomplete: 'off' });
  const symbol = h('input', { id: 'f-symbol', maxLength: 10, placeholder: 'MCAT', required: true, autocomplete: 'off' });
  const desc = h('textarea', { id: 'f-desc', maxLength: 500, rows: 3, placeholder: 'What is this coin about?' });
  const web = h('input', { id: 'f-web', placeholder: 'https://', type: 'url' });
  const tw = h('input', { id: 'f-x', placeholder: 'https://x.com/…', type: 'url' });
  const tg = h('input', { id: 'f-tg', placeholder: 'https://t.me/…', type: 'url' });
  const file = h('input', { id: 'f-img', type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
  const consent = h('input', { id: 'f-consent', type: 'checkbox' });
  const preview = h('div', { class: 'preview' });
  const e = p.launchEconomics;
  const updatePreview = () => preview.replaceChildren(tokenCard({ mint: 'preview', pool: '', name: name.value || 'Your coin', symbol: (symbol.value || 'TICKER').toUpperCase(), description: desc.value,
    imageUrl: imageDataUrl, creator: state.wallet?.account.address ?? 'you', status: 'LIVE', createdAt: new Date().toISOString(), liveAt: null, website: null, twitter: null,
    telegram: null, createSig: null, migrationSig: null, dammPool: null, stats: { count: 0, volumeQuoteRaw: '0', traders: 0 },
    live: { priceQuotePerBase: '0', marketCapQuoteRaw: '0', quoteReserve: '0', migrationQuoteThreshold: p.threshold.rawQuoteThreshold, progressBps: 0, curveComplete: false, isMigrated: false,
      baseDecimals: 6, quoteDecimals: q.decimals, totalSupplyRaw: '0', creatorQuoteFee: '0' } }));
  for (const el of [name, symbol, desc]) el.addEventListener('input', updatePreview);
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try { imageDataUrl = await shrinkImage(f); updatePreview(); } catch (err) { toast(`Image: ${(err as Error).message}`, 'err'); }
  });
  updatePreview();
  const digestOk = economicsDigest(e) === p.launchEconomicsDigest;
  const econ = h('dl', { class: 'econ' },
    h('dt', {}, 'Total supply'), h('dd', {}, `${units(BigInt(e.totalSupply) * 10n ** BigInt(e.baseDecimals), e.baseDecimals, 0)} tokens, mint authority revoked at launch`),
    h('dt', {}, 'Trading fee'), h('dd', {}, `${e.economics.baseFeeBps / 100}% flat on every trade, paid in ${q.symbol}`),
    h('dt', {}, 'Your share'), h('dd', {}, `${e.economics.creatorTradingFeePct}% of trading fees (after the 20% Meteora protocol share)`),
    h('dt', {}, 'Graduation'), h('dd', {}, `at ${units(e.migrationQuoteThresholdRaw, q.decimals, 0)} ${q.symbol} raised → Meteora DAMM v2, ${e.percentageSupplyOnMigration}% of supply paired`),
    h('dt', {}, 'Liquidity'), h('dd', {}, `100% permanently locked after graduation (${e.economics.lp.creatorPermanentLockedPct}% creator / ${e.economics.lp.partnerPermanentLockedPct}% platform positions)`),
    h('dt', {}, 'Launch cost'), h('dd', {}, 'no platform fee; you pay devnet rent and network fees (~0.03 SOL)'),
    h('dt', {}, 'Policy'), h('dd', { class: 'mono' }, `${p.economicsVersion} · ${p.templateVersion} · digest ${p.launchEconomicsDigest.slice(0, 12)}…${digestOk ? '' : ' (MISMATCH)'}`));
  const submit = h('button', { class: 'btn primary lg', type: 'submit' }, 'Launch coin');
  const form = h('form', { class: 'create-form', novalidate: true },
    h('div', { class: 'two' }, h('label', {}, 'Name', name), h('label', {}, 'Ticker', symbol)),
    h('label', {}, 'Description', desc),
    h('label', { class: 'file' }, 'Image (PNG, JPEG, GIF or WebP; resized to 512 px)', file),
    h('details', {}, h('summary', {}, 'Links (optional)'), h('label', {}, 'Website', web), h('label', {}, 'X / Twitter', tw), h('label', {}, 'Telegram', tg)),
    h('div', { class: 'card econ-card' }, h('h3', {}, 'Launch economics'), econ),
    h('label', { class: 'consent' }, consent, h('span', {}, 'I reviewed the launch economics above. This is devnet: the coin and qUSD have no value.')),
    submit);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const sym = symbol.value.trim().toUpperCase();
    const errs: string[] = [];
    if (!name.value.trim()) errs.push('name is required');
    if (!/^[A-Z0-9]{1,10}$/.test(sym)) errs.push('ticker must be 1–10 letters or digits');
    if (!consent.checked) errs.push('tick the economics box');
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
  main.replaceChildren(h('div', { class: 'create' },
    h('div', {}, h('h1', {}, 'Create a coin'), h('p', { class: 'lead' }, 'One wallet signature creates the token, its metadata and its bonding curve. Nobody, including you, can mint more later.'), form),
    h('aside', {}, h('h4', {}, 'Preview'), preview)));
}

// ---------------- token page
function chart(trades: Trade[], live: Live | null, baseDecimals: number) {
  const pts = [...trades].reverse().map((t) => (BigInt(t.quoteRaw) * 10n ** BigInt(baseDecimals) * 10n ** 18n) / BigInt(t.baseRaw === '0' ? '1' : t.baseRaw));
  if (live) pts.push(BigInt(live.priceQuotePerBase));
  const W = 640, H = 220, pad = 8;
  if (pts.length < 2) return h('div', { class: 'chart empty' }, 'The price chart appears after the first trades.');
  const max = pts.reduce((a, b) => (b > a ? b : a)), min = pts.reduce((a, b) => (b < a ? b : a));
  const span = max - min || 1n;
  const xy = pts.map((v, i) => [pad + (i * (W - 2 * pad)) / (pts.length - 1), H - pad - Number(((v - min) * 1000n) / span) * (H - 2 * pad) / 1000]);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Price by trade');
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('d', `M${xy[0]![0]},${H} ${xy.map(([x, y]) => `L${x},${y}`).join(' ')} L${xy[xy.length - 1]![0]},${H} Z`); area.setAttribute('class', 'area');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', xy.map(([x, y]) => `${x},${y}`).join(' ')); line.setAttribute('class', 'line');
  svg.append(area, line);
  return svg;
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
  const graduated = t.status === 'MIGRATED' || !!l?.isMigrated;

  // trade panel
  let side: 'buy' | 'sell' = 'buy';
  const amount = h('input', { id: 'amt', inputMode: 'decimal', placeholder: '0.00', autocomplete: 'off' });
  const slip = h('select', { id: 'slip' }, ...[50, 100, 300, 500, 1000].map((b) => h('option', { value: String(b), selected: b === 100 }, `${b / 100}% slippage`)));
  const quoteBox = h('div', { class: 'quote' });
  const go = h('button', { class: 'btn primary lg wide', id: 'trade' }, 'Buy');
  const presets = h('div', { class: 'presets' });
  const tabs = h('div', { class: 'seg' });
  const unitOf = () => (side === 'buy' ? q.decimals : bd);
  let lastQuote: any = null, qTimer: number | undefined;
  const setSide = (s: typeof side) => {
    side = s; amount.value = ''; quoteBox.replaceChildren(); lastQuote = null;
    tabs.replaceChildren(h('button', { class: s === 'buy' ? 'on buy' : '', onclick: () => setSide('buy') }, 'Buy'), h('button', { class: s === 'sell' ? 'on sell' : '', onclick: () => setSide('sell') }, 'Sell'));
    go.textContent = s === 'buy' ? `Buy $${t.symbol}` : `Sell $${t.symbol}`;
    go.className = `btn lg wide ${s === 'buy' ? 'primary' : 'danger'}`;
    presets.replaceChildren(...(s === 'buy'
      ? ['100', '500', '1000', '5000'].map((v) => h('button', { class: 'chipbtn', onclick: () => { amount.value = v; requote(); } }, `${v} ${q.symbol}`))
      : [25, 50, 100].map((p) => h('button', { class: 'chipbtn', onclick: () => {
        const bal = BigInt(state.balances?.tokens[t.mint] ?? '0');
        amount.value = units((bal * BigInt(p)) / 100n, bd, bd).replace(/,/g, ''); requote();
      } }, `${p}%`))));
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
          h('dt', {}, 'Minimum received'), h('dd', {}, `${units(quote.minimumAmountOut, outDec, 2)} ${outSym}`),
          h('dt', {}, 'Fee'), h('dd', {}, `${units(BigInt(quote.tradingFee) + BigInt(quote.protocolFee), q.decimals, 4)} ${q.symbol}`),
          h('dt', {}, 'Price impact'), h('dd', { class: Number(quote.priceImpactBps) > 500 ? 'err' : '' }, pct(Number(quote.priceImpactBps)))));
      } catch (e) { quoteBox.replaceChildren(h('p', { class: 'err' }, (e as Error).message)); }
    }, 250);
  };
  amount.addEventListener('input', requote);
  slip.addEventListener('change', requote);
  go.addEventListener('click', async () => {
    const w = requireWallet();
    if (!w) return;
    if (!lastQuote) { toast('Enter an amount first', 'err'); return; }
    const shownQuote = lastQuote;
    const dir = side === 'buy' ? 'QUOTE_TO_BASE' : 'BASE_TO_QUOTE';
    go.disabled = true;
    const out = await runSigningFlow<{ trade: unknown }>(`${side === 'buy' ? 'Buy' : 'Sell'} $${t.symbol}`,
      () => api<Built>('/api/lp/swap', { mint: t.mint, user: w.account.address, side, amountIn: shownQuote.raw.toString(), slippageBps: Number(slip.value) }),
      () => ({ kind: 'SWAP', wallet: w.account.address, shown: { quote: { ...shownQuote, raw: shownQuote.raw.toString() } },
        fields: { user: w.account.address, pool: t.pool, baseMint: t.mint, quoteMint: q.mint, direction: dir, amountIn: shownQuote.raw.toString() },
        minimumAmountOutAtLeast: shownQuote.minimumAmountOut }));
    go.disabled = false;
    if (out) { toast('Trade confirmed', 'ok'); renderToken(t.mint); }
  });
  setSide('buy');

  const panel = graduated
    ? h('div', { class: 'card trade' }, h('h3', {}, 'Graduated 🎓'), h('p', {}, `This coin completed its bonding curve and now trades on a Meteora DAMM v2 pool with permanently locked liquidity.`),
      t.dammPool ? ext(explorer('address', t.dammPool), 'Open the DAMM v2 pool on Explorer', 'btn ghost wide') : null,
      t.migrationSig ? h('p', { class: 'dim' }, 'Migration tx: ', ext(explorer('tx', t.migrationSig), short(t.migrationSig, 8))) : null)
    : l?.curveComplete
      ? h('div', { class: 'card trade' }, h('h3', {}, 'Curve complete'), h('p', {}, 'The bonding curve is full. Migration to Meteora DAMM v2 runs automatically within a minute.'))
      : h('div', { class: 'card trade' }, tabs, h('label', {}, side === 'buy' ? `Amount (${q.symbol})` : `Amount ($${t.symbol})`, amount), presets, slip, quoteBox, go,
        state.balances ? h('p', { class: 'dim small' }, `Balance: ${units(state.balances.tokens[q.mint] ?? '0', q.decimals, 2)} ${q.symbol} · ${units(state.balances.tokens[t.mint] ?? '0', bd, 2)} $${t.symbol}`) : null);

  const links = [t.website && ext(t.website, 'Website'), t.twitter && ext(t.twitter, 'X'), t.telegram && ext(t.telegram, 'Telegram')].filter(Boolean) as HTMLElement[];
  const tradeRows = trades.map((x) => h('tr', {},
    h('td', { class: x.side === 'BUY' ? 'buy' : 'sell' }, x.side === 'BUY' ? 'Buy' : 'Sell'),
    h('td', {}, ext(explorer('address', x.trader), short(x.trader))),
    h('td', { class: 'num' }, units(x.quoteRaw, q.decimals, 2)),
    h('td', { class: 'num' }, compact(x.baseRaw, bd)),
    h('td', { class: 'dim' }, x.blockTime ? ago(x.blockTime) : `slot ${x.slot}`),
    h('td', {}, ext(explorer('tx', x.sig), short(x.sig, 4)))));

  main.replaceChildren(h('div', { class: 'token' },
    h('div', { class: 'tok-main' },
      h('div', { class: 'tok-head' }, avatar(t, 'lg'),
        h('div', {}, h('h1', {}, t.name, ' ', h('span', { class: 'sym' }, `$${t.symbol}`), ' ', statusChip(t)),
          h('p', { class: 'dim' }, 'Mint ', h('button', { class: 'copy', title: 'Copy', onclick: () => navigator.clipboard?.writeText(t.mint).then(() => toast('Mint address copied', 'ok')) }, short(t.mint, 6)),
            ' · created by ', ext(explorer('address', t.creator), short(t.creator)), ' · ', ago(t.liveAt ?? t.createdAt),
            ...(links.length ? [' · ', ...links.flatMap((a, k) => (k ? [' · ', a] : [a]))] : [])))),
      t.description ? h('p', { class: 'tok-desc' }, t.description) : null,
      h('div', { class: 'kpis' },
        h('div', {}, h('span', { class: 'k' }, 'Price'), h('span', { class: 'v' }, l ? `${price(l.priceQuotePerBase, q.decimals)} ${q.symbol}` : '—')),
        h('div', {}, h('span', { class: 'k' }, 'Market cap'), h('span', { class: 'v' }, l ? `${compact(l.marketCapQuoteRaw, q.decimals)} ${q.symbol}` : '—')),
        h('div', {}, h('span', { class: 'k' }, 'Volume'), h('span', { class: 'v' }, `${compact(t.stats.volumeQuoteRaw, q.decimals)} ${q.symbol}`)),
        h('div', {}, h('span', { class: 'k' }, 'Trades'), h('span', { class: 'v' }, String(t.stats.count)))),
      h('div', { class: 'card' }, chart(trades, l, bd)),
      l ? h('div', { class: 'card grad-card' },
        h('div', { class: 'grad-top' }, h('strong', {}, 'Bonding curve progress'), h('span', {}, pct(l.progressBps))),
        progressBar(l.progressBps, l.curveComplete || l.isMigrated),
        h('p', { class: 'dim small' }, graduated ? 'Graduated to Meteora DAMM v2.' : `${units(l.quoteReserve, q.decimals, 0)} of ${units(l.migrationQuoteThreshold, q.decimals, 0)} ${q.symbol} raised. When the curve fills, the coin graduates to Meteora DAMM v2 and its liquidity is locked forever.`)) : null,
      h('div', { class: 'card' }, h('h3', {}, 'Trades'), trades.length ? h('div', { class: 'scroll' }, h('table', { class: 'trades' },
        h('thead', {}, h('tr', {}, ...['Side', 'Trader', q.symbol, `$${t.symbol}`, 'When', 'Tx'].map((c) => h('th', {}, c)))), h('tbody', {}, ...tradeRows))) : h('p', { class: 'dim' }, 'No trades yet.'))),
    h('aside', {}, panel,
      h('div', { class: 'card small' }, h('h4', {}, 'On-chain'), h('dl', { class: 'mini' },
        h('dt', {}, 'Engine'), h('dd', {}, 'Meteora Dynamic Bonding Curve'),
        h('dt', {}, 'Pool'), h('dd', {}, ext(explorer('address', t.pool), short(t.pool, 6))),
        h('dt', {}, 'Launch tx'), h('dd', {}, t.createSig ? ext(explorer('tx', t.createSig), short(t.createSig, 6)) : '—'),
        h('dt', {}, 'Creator fees'), h('dd', {}, l ? `${units(l.creatorQuoteFee, q.decimals, 2)} ${q.symbol} unclaimed` : '—'))))));
  clearInterval(tokenTimer);
  tokenTimer = window.setInterval(() => { if (currentMint() === mint && !document.hidden && $('#modal').hidden) void api('/api/lp/refresh', { mint }).catch(() => {}); }, 20_000);
}

// ------------------------------------------------------------------ router + boot
async function route() {
  clearInterval(tokenTimer);
  if ($('.sheet .x')) closeModal(); // a finished or idle dialog never follows you to another page; a running signing flow has no close button
  const m = currentMint();
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === (m ? '' : location.hash || '#/')));
  if (m) await renderToken(m);
  else if (location.hash === '#/create') renderCreate();
  else await renderHome();
  document.body.dataset.ready = 'true';
}

async function boot() {
  startWalletDiscovery();
  onWalletsChanged(() => { if (!$('#modal').hidden && $('.wlist, .sheet p.dim')) openWalletPicker(); });
  try { state.platform = await api<Platform>('/api/lp/platform'); }
  catch (e) { $('#view').replaceChildren(h('div', { class: 'empty err' }, `Launchpad API unavailable: ${(e as Error).message}`)); return; }
  const q = Q();
  $('#netnote').textContent = state.platform.ready
    ? `Devnet test network. ${q.symbol} is a TEST_ONLY token with no value; coins launched here are worthless. Mainnet writes are disabled.`
    : 'Devnet platform not set up yet (the operator wallet needs devnet SOL). Browsing works; launching does not.';
  renderWallet();
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('.sheet .x')) closeModal(); });
  await route();
}
void boot();
