// Private read-only inspector and creator drafts (qf-api/1). Talks only to the same-origin API, renders every value with
// textContent (never innerHTML), and keeps the bearer token in sessionStorage for this tab only. It has no wallet, no
// signing and no RPC of its own: every chain read happens on the server and arrives as a stored, digest-bound report.
import { parseDraftInput, parseDraftUpdate, parseInspectionRequest, type ApiError, type DraftView, type InspectionSummary,
  type InspectionView, type PolicyRefs } from '@project-qf/contracts';

type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError['error'] };
type Child = Node | string | null | undefined | false;

const TOKEN_KEY = 'qf.token';
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// Check names as in QUOTE-ASSETS.md §2-4.
const CHECK_TITLES: Record<string, string> = {
  'IN.1': 'Evidence available', 'S1.1': 'Existence and owner', 'S1.2': 'Token-2022 native mint', 'S1.3': 'Decimals', 'S1.4': 'Extensions',
  'S1.5': 'Transfer fee', 'S1.6': 'DBC permissionless', 'S1.7': 'TokenBadge', 'S1.8': 'Freeze authority', 'S1.9': 'Mint authority',
  'S1.10': 'Supply', 'S1.11': 'Metadata', 'S1.12': 'Two-RPC agreement',
  'S2.1': 'Registry status', 'S2.2': 'Impersonation', 'S2.3': 'Wrapped or bridged provenance', 'S2.4': 'Legal asset class', 'S2.5': 'Compliance hooks',
  'S3.1': 'Exit liquidity', 'S3.2': 'Quote-market liquidity', 'S3.3': '24h volume', 'S3.4': 'Top-10 non-program holder share', 'S3.5': 'Oracle',
  'S3.6': 'Round-trip simulation', 'S3.7': 'Keeper eligibility', 'S3.8': 'Source disagreement',
};
const STAGES: [string, string][] = [['IN.', 'Evidence'], ['S1.', 'Stage 1: mint account'], ['S2.', 'Stage 2: registry and provenance'], ['S3.', 'Stage 3: market']];
const CLUSTER_NAMES: Record<string, string> = { 'mainnet-beta': 'Solana mainnet', devnet: 'Solana devnet', 'test-only': 'TEST_ONLY fixtures' };

let token: string | null = null;
let current: InspectionView | null = null;
let draft: DraftView | null = null;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('data-')) e.dataset[k.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = v; else e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}
const badge = (text: string, cls: string) => h('span', { class: `pill ${cls}` }, text);
const decisionBadge = (d: string) => badge(d, `d-${d}`);
const dl = (rows: [string, Child][], cls = '') => h('dl', cls ? { class: cls } : {}, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
const table = (head: string[], rows: Child[][], cls = '') =>
  h('div', { class: 'scroll' }, h('table', cls ? { class: cls } : {}, h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c)))))));
const when = (iso: string | null) => (iso ? new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'n/a');
const short = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
function setMsg(id: string, text: string, kind: 'ok' | 'err' | '' = '') { const e = byId(id); e.textContent = text; e.className = `msg ${kind}`; }

function store(k: string, v: string | null) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* storage blocked */ } }
function load(k: string): string | null { try { return sessionStorage.getItem(k); } catch { return null; } }

async function api<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers: { authorization: `Bearer ${token ?? ''}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), credentials: 'omit', cache: 'no-store' });
  } catch { return { ok: false, status: 0, error: { code: 'NETWORK', message: 'could not reach the QF server' } }; }
  const json = await res.json().catch(() => null);
  if (res.ok) return { ok: true, data: json as T };
  const err = (json as ApiError | null)?.error ?? { code: `HTTP_${res.status}`, message: res.statusText };
  if (res.status === 401) signOut('Your session token was not accepted. Sign in again.');
  return { ok: false, status: res.status, error: err };
}
const errText = (e: ApiError['error']) => `${e.code}: ${e.message}${e.details?.length ? ` (${e.details.join('; ')})` : ''}`;

// ---------- session ----------
async function signIn(t: string) {
  token = t;
  const r = await api<{ user: { id: string; name: string }; apiVersion: string; policies: PolicyRefs }>('GET', '/api/session');
  if (!r.ok) { if (r.status !== 401) setMsg('signin-msg', errText(r.error), 'err'); return; }
  store(TOKEN_KEY, t);
  byId('signin').hidden = true;
  byId('app').hidden = false;
  const who = byId('who');
  who.replaceChildren(h('span', {}, `Signed in as ${r.data.user.name}`), h('span', { class: 'muted' }, ` · ${r.data.apiVersion} · ${r.data.policies.validator} · ${r.data.policies.economics.version}`),
    h('button', { type: 'button', class: 'link', id: 'signout' }, 'Sign out'));
  byId('signout').addEventListener('click', () => signOut(''));
  document.body.dataset.signedIn = 'true';
  await Promise.all([loadFixtures(), refreshLists()]);
}
function signOut(message: string) {
  token = null; current = null; draft = null;
  store(TOKEN_KEY, null);
  byId('app').hidden = true;
  byId('signin').hidden = false;
  byId('who').replaceChildren();
  byId('report').hidden = true;
  byId('draft-card').hidden = true;
  document.body.dataset.signedIn = 'false';
  setMsg('signin-msg', message, message ? 'err' : '');
}

async function loadFixtures() {
  const r = await api<{ label: string; mints: { mint: string; label: string }[] }>('GET', '/api/fixtures');
  const ul = byId('fixtures');
  if (!r.ok) { ul.replaceChildren(h('li', {}, errText(r.error))); return; }
  ul.replaceChildren(...r.data.mints.map((m) => {
    const b = h('button', { type: 'button', class: 'link', 'data-mint': m.mint }, m.label);
    b.addEventListener('click', () => { byId<HTMLInputElement>('mint').value = m.mint; byId<HTMLSelectElement>('cluster').value = 'test-only'; byId('mint').focus(); });
    return h('li', {}, b, h('code', { class: 'muted' }, ` ${m.mint}`));
  }));
}

// ---------- inspection ----------
async function inspect(ev: Event) {
  ev.preventDefault();
  const parsed = parseInspectionRequest({ mint: byId<HTMLInputElement>('mint').value, cluster: byId<HTMLSelectElement>('cluster').value });
  if (!parsed.ok) { setMsg('inspect-msg', parsed.errors.join('; '), 'err'); return; }
  const btn = byId<HTMLButtonElement>('inspect-btn');
  btn.disabled = true;
  setMsg('inspect-msg', `Reading ${short(parsed.value.mint)} on ${CLUSTER_NAMES[parsed.value.cluster]}…`);
  try {
    const r = await api<InspectionView>('POST', '/api/inspections', parsed.value);
    if (!r.ok) { setMsg('inspect-msg', errText(r.error), 'err'); return; }
    setMsg('inspect-msg', `Saved inspection ${short(r.data.id)}.`, 'ok');
    showReport(r.data);
    draft = null;
    setMsg('draft-msg', '');
    showDraftForm();
    await refreshLists();
  } finally { btn.disabled = false; }
}

function showReport(v: InspectionView) {
  current = v;
  const sec = byId('report');
  sec.hidden = false;
  sec.dataset.label = v.label;
  sec.dataset.decision = v.inspection.aggregate.decision;
  sec.dataset.id = v.id;
  const test = v.label === 'TEST_ONLY_FIXTURE';
  const checks = v.inspection.checks;
  const skipped = checks.filter((c) => c.decision === 'SKIP' && !c.reason.startsWith('NOT_APPLICABLE'));   // a skip that needs no input is not missing
  const unavailable = v.features.components.filter((c) => c.status === 'UNAVAILABLE');
  const reasons = v.inspection.aggregate.reasons;

  sec.replaceChildren(
    h('h2', {}, 'Inspection report ', badge(test ? 'TEST_ONLY FIXTURE' : 'LIVE READ', test ? 'test-only' : 'live'), ' ', decisionBadge(v.inspection.aggregate.decision),
      ' ', badge(v.freshness, v.freshness === 'FRESH' ? 'fresh' : 'stale')),
    test ? h('p', { class: 'notice test-only', role: 'note' }, 'TEST_ONLY fixture data: synthetic accounts with no real asset behind them. A TEST_ONLY inspection is never PASS.') : '',
    h('p', { class: 'muted' }, v.inspection.aggregate.decision === 'PASS' ? 'All required checks passed on live evidence.'
      : `The aggregate is ${v.inspection.aggregate.decision} because of ${reasons.length} reason${reasons.length === 1 ? '' : 's'} below. Missing evidence never counts as a pass.`),
    dl([
      ['Mint', h('code', {}, v.mint)],
      ['Network', `${CLUSTER_NAMES[v.cluster]} (${v.inspection.cluster})`],
      ['Read at', when(v.createdAt)],
      ['Age', `${v.ageSeconds} s, ${v.freshness} (re-inspect after ${v.staleAfterSeconds} s)`],
      ['Policies', `${v.policies.validator}, ${v.policies.evidence}, ${v.policies.inspection}, ${v.policies.features}`],
      ['Evidence digest', h('code', {}, v.evidenceDigest)],
      ['Report digest', h('code', {}, v.reportDigest)],
      ['Report id', h('code', {}, v.id)],
    ], 'meta'),
    h('details', { class: 'reasons', ...(v.inspection.aggregate.decision === 'PASS' ? {} : { open: '' }) }, h('summary', {}, `Why ${v.inspection.aggregate.decision} (${reasons.length})`),
      h('ul', {}, ...reasons.map((x) => h('li', {}, x)))),
    h('h3', {}, 'Sources'),
    table(['Provider', 'Method', 'Status', 'Slot', 'Network proven', 'Observed', 'Reason'], v.reads.map((r) => [
      r.provider, r.method, badge(r.status, `s-${r.status}`), r.slot ?? 'n/a',
      r.genesisVerified === null ? 'n/a (fixture)' : r.genesisVerified ? 'genesis hash matched' : 'no', when(r.observedAt), r.reason ?? '',
    ]), 'reads'),
    h('h3', {}, `Checks (${v.inspection.coverage.evaluated} evaluated${v.inspection.coverage.notApplicable ? `, ${v.inspection.coverage.notApplicable} of them not applicable by an approved exception` : ''}, ${v.inspection.coverage.skipped} skipped of ${v.inspection.coverage.total})`),
    ...STAGES.map(([prefix, title]) => {
      const rows = checks.filter((c) => c.id.startsWith(prefix));
      return rows.length ? h('div', { class: 'stage', 'data-stage': prefix.replace('.', '') }, h('h4', {}, title),
        table(['Check', '', 'Result', 'Reason'], rows.map((c) => [h('code', {}, c.id), CHECK_TITLES[c.id] ?? '', decisionBadge(c.decision), c.reason]), 'checks')) : '';
    }),
    h('h3', {}, `Measured features (${v.features.coverage.measured} of ${v.features.coverage.total} measured)`),
    h('p', { class: 'muted' }, `No overall score. ${v.features.overallScoreReason.replace(/^NO_OVERALL_SCORE: /, 'Reason: ')}.`),
    table(['Feature', 'Group', 'Status', 'Value', 'Source', 'Note'], v.features.components.map((c) => [
      h('code', {}, c.id), c.group, badge(c.status, `s-${c.status}`), c.value === null ? '—' : `${String(c.value)}${c.unit === 'bps' ? ' bps' : ''}`, c.source ?? '', c.note,
    ]), 'features'),
    h('h3', {}, 'Missing inputs'),
    h('ul', { class: 'missing' },
      ...skipped.map((c) => h('li', {}, h('code', {}, c.id), ` ${CHECK_TITLES[c.id] ?? ''}: ${c.reason}`)),
      h('li', {}, `${unavailable.length} feature component${unavailable.length === 1 ? ' is' : 's are'} unavailable: ${[...new Set(unavailable.map((c) => c.note.split(':')[0]))].join(', ')}`)),
  );
}

async function openInspection(id: string) {
  const r = await api<InspectionView>('GET', `/api/inspections/${encodeURIComponent(id)}`);
  if (!r.ok) { setMsg('inspect-msg', errText(r.error), 'err'); return null; }
  showReport(r.data);
  return r.data;
}

// ---------- drafts ----------
function showDraftForm() {
  if (!current) return;
  byId('draft-card').hidden = false;
  byId('draft-state').textContent = draft ? `saved · version ${draft.version}` : 'new';
  byId('draft-state').className = `pill ${draft ? 'fresh' : ''}`;
  byId<HTMLButtonElement>('draft-save').textContent = draft ? 'Save changes' : 'Save draft';
  if (!draft) { byId<HTMLInputElement>('d-name').value = ''; byId<HTMLInputElement>('d-symbol').value = ''; byId<HTMLTextAreaElement>('d-desc').value = ''; }
  const rows: [string, Child][] = [
    ['Quote asset', h('code', {}, current.mint)],
    ['Network', CLUSTER_NAMES[current.cluster] ?? current.cluster],
    ['Checked against', h('span', {}, h('code', {}, short(current.id)), ' ', decisionBadge(current.inspection.aggregate.decision), current.label === 'TEST_ONLY_FIXTURE' ? ' TEST_ONLY' : '')],
  ];
  if (draft) {
    rows.push(['Planning status', h('span', { class: 'labels' }, ...draft.labels.map((l) => badge(l, l === 'PLANNING_DRAFT' ? 'planning' : 'stale')))]);
    if (draft.basis) rows.push(['Evidence basis', `report ${draft.basis.reportDigest.slice(0, 12)}… read ${when(draft.basis.observedAt)}, ${draft.basis.decision}, ${draft.basis.freshnessAtSave} when saved (${draft.basis.ageSecondsAtSave} s old)`]);
    rows.push(['Saved', `${when(draft.updatedAt)} (created ${when(draft.createdAt)})`]);
    rows.push(['Policies at save', `${draft.policyRefs.economics.version} (${draft.policyRefs.economics.digest.slice(0, 12)}…), ${draft.policyRefs.template.version}, ${draft.policyRefs.validator}, ${draft.policyRefs.inspection}, ${draft.policyRefs.features}`]);
    rows.push(['Policy status', draft.policyStale ? badge(`POLICY CHANGED: ${draft.policyChanges.join(', ')}`, 'stale') : badge('current', 'fresh')]);
    if (draft.inspectionId !== current.id) rows.push(['Note', 'This draft is linked to a different inspection than the one shown. Saving re-links it to the inspection shown.']);
  }
  byId('draft-bind').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  byId('draft-notice').textContent = draft ? draft.notice : 'Drafts are planning records. Saving does not refresh evidence and is not consent to launch.';
  byId('draft-card').dataset.draftId = draft?.id ?? '';
  byId('draft-card').dataset.version = draft ? String(draft.version) : '';
}

async function saveDraft(ev: Event) {
  ev.preventDefault();
  if (!current) return;
  const body = { name: byId<HTMLInputElement>('d-name').value, symbol: byId<HTMLInputElement>('d-symbol').value.toUpperCase(), description: byId<HTMLTextAreaElement>('d-desc').value,
    quoteMint: current.mint, cluster: current.cluster, inspectionId: current.id };
  const parsed = draft ? parseDraftUpdate({ ...body, expectedVersion: draft.version }) : parseDraftInput(body);
  if (!parsed.ok) { setMsg('draft-msg', parsed.errors.join('; '), 'err'); return; }
  const r = draft ? await api<DraftView>('PUT', `/api/drafts/${draft.id}`, parsed.value) : await api<DraftView>('POST', '/api/drafts', parsed.value);
  if (!r.ok) {
    setMsg('draft-msg', r.status === 409 ? 'Someone saved this draft since you opened it. Reopen it from Saved drafts and apply your change again.' : errText(r.error), 'err');
    return;
  }
  draft = r.data;
  setMsg('draft-msg', `Saved ${draft.name} (${draft.symbol}), version ${draft.version}.`, 'ok');
  showDraftForm();
  await refreshLists();
}

async function openDraft(id: string) {
  const r = await api<DraftView>('GET', `/api/drafts/${encodeURIComponent(id)}`);
  if (!r.ok) { setMsg('draft-msg', errText(r.error), 'err'); return; }
  const insp = await openInspection(r.data.inspectionId);
  if (!insp) return;
  draft = r.data;
  byId<HTMLInputElement>('d-name').value = draft.name;
  byId<HTMLInputElement>('d-symbol').value = draft.symbol;
  byId<HTMLTextAreaElement>('d-desc').value = draft.description;
  showDraftForm();
  setMsg('draft-msg', `Loaded ${draft.name} from the server.`, 'ok');
  byId('draft-card').scrollIntoView({ block: 'start' });
}

async function refreshLists() {
  const [d, i] = await Promise.all([api<{ drafts: DraftView[] }>('GET', '/api/drafts'), api<{ inspections: InspectionSummary[] }>('GET', '/api/inspections')]);
  const dul = byId('drafts');
  if (d.ok) {
    dul.replaceChildren(...(d.data.drafts.length ? d.data.drafts.map((x) => {
      const b = h('button', { type: 'button', class: 'link', 'data-draft-id': x.id }, `${x.name} (${x.symbol})`);
      b.addEventListener('click', () => { void openDraft(x.id); });
      return h('li', { 'data-draft-id': x.id }, b, ' ', h('span', { class: 'muted' }, `v${x.version} · ${when(x.updatedAt)} · quote ${short(x.quoteMint)} on ${CLUSTER_NAMES[x.cluster]} · inspection `),
        decisionBadge(x.inspectionDecision), badge('PLANNING', 'planning'), x.labels.includes('EVIDENCE_STALE_NOW') ? badge('STALE EVIDENCE', 'stale') : null,
        x.policyStale ? badge('POLICY CHANGED', 'stale') : null);
    }) : [h('li', { class: 'muted' }, 'No drafts yet.')]));
  } else dul.replaceChildren(h('li', {}, errText(d.error)));
  const iul = byId('inspections');
  if (i.ok) {
    iul.replaceChildren(...(i.data.inspections.length ? i.data.inspections.slice(0, 10).map((x) => {
      const b = h('button', { type: 'button', class: 'link' }, short(x.mint));
      b.addEventListener('click', () => { void openInspection(x.id).then((v) => { if (v) { draft = null; setMsg('draft-msg', ''); showDraftForm(); } }); });
      return h('li', {}, b, ' ', h('span', { class: 'muted' }, `${CLUSTER_NAMES[x.cluster]} · ${when(x.createdAt)} · ${x.label === 'TEST_ONLY_FIXTURE' ? 'TEST_ONLY' : 'live'} `), decisionBadge(x.decision));
    }) : [h('li', { class: 'muted' }, 'No inspections yet.')]));
  } else iul.replaceChildren(h('li', {}, errText(i.error)));
}

// ---------- wiring ----------
byId('signin-form').addEventListener('submit', (ev) => { ev.preventDefault(); void signIn(byId<HTMLInputElement>('token').value.trim()); });
byId('inspect-form').addEventListener('submit', (ev) => { void inspect(ev); });
byId('draft-form').addEventListener('submit', (ev) => { void saveDraft(ev); });
byId('draft-new').addEventListener('click', () => { draft = null; setMsg('draft-msg', ''); showDraftForm(); });
const saved = load(TOKEN_KEY);
(saved ? signIn(saved) : Promise.resolve()).finally(() => { document.body.dataset.ready = 'true'; });
