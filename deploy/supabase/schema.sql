-- The launchpad's own walled-off schema (apps/launchpad/src/store-pg.ts, schema version 1). Everything lives in qf_launchpad;
-- the gateway (qf-db) runs every statement as qf_launchpad_app, a role that can reach nothing else in this database.
-- qf_launchpad is not in the API's exposed schemas, and anon/authenticated get no rights on it.
create schema if not exists qf_launchpad;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'qf_launchpad_app') then create role qf_launchpad_app nologin; end if;
end $$;
grant qf_launchpad_app to postgres;
revoke all on schema qf_launchpad from public, anon, authenticated;
grant usage on schema qf_launchpad to qf_launchpad_app;

create table if not exists qf_launchpad.settings (k text primary key, v text not null);
create table if not exists qf_launchpad.secrets (k text primary key, v text not null);
create table if not exists qf_launchpad.coins (
  mint text primary key, quote_mint text not null, creator text not null, name text not null, symbol text not null,
  description text not null, website text, twitter text, telegram text, image_type text, image bytea, metadata_uri text not null,
  status text not null, created_at text not null, create_sig text, live_at text, pool text, graduate_sig text, graduated_at text,
  curve_cursor text, pool_cursor text);
create index if not exists coins_status on qf_launchpad.coins (status, created_at);
create table if not exists qf_launchpad.txs (
  sig text not null, mint text not null references qf_launchpad.coins (mint), venue text not null, slot bigint not null, status text not null,
  outcome text, attempts integer not null, next_try text not null, first_seen text not null, primary key (sig, mint));
create index if not exists txs_due on qf_launchpad.txs (status, next_try);
create table if not exists qf_launchpad.trades (
  sig text not null, ix integer not null, mint text not null references qf_launchpad.coins (mint), venue text not null, trader text not null,
  side text not null, quote_raw text not null, base_raw text not null, fee_mint text not null, trade_fee_raw text not null,
  platform_fee_raw text, creator_fee_raw text not null, slot bigint not null, block_time bigint, primary key (sig, ix));
create index if not exists trades_mint on qf_launchpad.trades (mint, slot);
create index if not exists trades_trader on qf_launchpad.trades (trader, slot);
create table if not exists qf_launchpad.payouts (
  sig text not null, ix integer not null, mint text not null references qf_launchpad.coins (mint), kind text not null, to_account text,
  amount_raw text not null, slot bigint not null, block_time bigint, primary key (sig, ix));
create index if not exists payouts_mint on qf_launchpad.payouts (mint, kind);
create table if not exists qf_launchpad.intents (
  id text primary key, kind text not null, mint text, "user" text not null, created_at text not null, expires_at text not null,
  message_hex text not null, terms_json text not null, last_valid_block_height text not null, status text not null, signature text, error text);
create table if not exists qf_launchpad.faucet_claims (wallet text not null, at text not null, signature text not null);
create index if not exists faucet_wallet on qf_launchpad.faucet_claims (wallet, at);

revoke all on all tables in schema qf_launchpad from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema qf_launchpad to qf_launchpad_app;
