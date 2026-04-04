-- ============================================================
-- thumbs.store — Supabase Schema v3
-- Supports: XLS upload, per-client game access, multi-aggregator
-- ============================================================


-- ── 1. PROVIDERS (your Figma files) ──────────────────────────
create table if not exists providers (
  id             uuid primary key default gen_random_uuid(),
  slug           text unique not null,
  name           text not null,
  figma_file_key text not null,
  figma_frame_id text not null,
  created_at     timestamptz default now()
);


-- ── 2. FIGMA GAMES ───────────────────────────────────────────
create table if not exists figma_games (
  id            uuid primary key default gen_random_uuid(),
  provider_id   uuid references providers(id) on delete cascade,
  slug          text not null,
  figma_node_id text not null,
  storage_url   text,
  published_at  timestamptz,
  created_at    timestamptz default now(),
  unique(provider_id, slug)
);


-- ── 3. AGGREGATORS ───────────────────────────────────────────
-- Slotegrator, SoftSwiss, EveryMatrix, etc.
create table if not exists aggregators (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,   -- "slotegrator"
  name        text not null,          -- "Slotegrator"
  api_url     text,                   -- their catalog endpoint
  auth_header text,                   -- header name e.g. "x-p-key"
  auth_key    text,                   -- the actual key value
  created_at  timestamptz default now()
);


-- ── 4. CATALOG MAPPINGS ──────────────────────────────────────
-- All games from all aggregators, mapped to Figma thumbnails
create table if not exists catalog_mappings (
  id                uuid primary key default gen_random_uuid(),
  aggregator_id     uuid references aggregators(id),
  aggregator_uuid   text not null,      -- game UUID from the aggregator
  game_name         text not null,
  provider_id       uuid references providers(id),
  figma_game_id     uuid references figma_games(id),
  figma_node_id     text,
  figma_file_key    text,
  match_confidence  float default 0,
  game_type         text,
  original_image    text,
  image_status      text,
  synced_at         timestamptz default now(),
  unique(aggregator_id, aggregator_uuid)
);


-- ── 5. CLIENTS (casino operators) ────────────────────────────
create table if not exists clients (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text unique not null,
  api_key      text unique not null default concat('ts_', replace(gen_random_uuid()::text, '-', '')),
  is_active    boolean default true,
  notes        text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);


-- ── 6. CLIENT GAMES ──────────────────────────────────────────
-- The exact games each casino operator has access to
-- Populated when you upload their XLS file
create table if not exists client_games (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid references clients(id) on delete cascade,
  catalog_mapping_id uuid references catalog_mappings(id) on delete cascade,
  added_at         timestamptz default now(),
  unique(client_id, catalog_mapping_id)
);


-- ── 7. PUBLISH LOG ───────────────────────────────────────────
create table if not exists publish_log (
  id           uuid primary key default gen_random_uuid(),
  provider_id  uuid references providers(id),
  total_games  int,
  exported     int,
  failed       int,
  published_at timestamptz default now()
);


-- ── 8. SUPABASE STORAGE ──────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('thumbnails', 'thumbnails', true)
on conflict do nothing;

create policy "public_read_thumbnails"
  on storage.objects for select
  using (bucket_id = 'thumbnails');

create policy "service_upload_thumbnails"
  on storage.objects for insert
  with check (bucket_id = 'thumbnails' and auth.role() = 'service_role');

create policy "service_update_thumbnails"
  on storage.objects for update
  using (bucket_id = 'thumbnails' and auth.role() = 'service_role');


-- ── 9. ROW LEVEL SECURITY ────────────────────────────────────
alter table providers        enable row level security;
alter table figma_games      enable row level security;
alter table aggregators      enable row level security;
alter table catalog_mappings enable row level security;
alter table clients          enable row level security;
alter table client_games     enable row level security;
alter table publish_log      enable row level security;

create policy "providers_public_read"    on providers        for select using (true);
create policy "figma_games_public_read"  on figma_games      for select using (true);
create policy "catalog_public_read"      on catalog_mappings for select using (true);
create policy "aggregators_service"      on aggregators      for all using (auth.role() = 'service_role');
create policy "clients_service"          on clients          for all using (auth.role() = 'service_role');
create policy "client_games_service"     on client_games     for all using (auth.role() = 'service_role');
create policy "publish_log_service"      on publish_log      for all using (auth.role() = 'service_role');


-- ── 10. SEED: Play'n Go provider ─────────────────────────────
insert into providers (slug, name, figma_file_key, figma_frame_id)
values ('play-n-go', 'Play''n Go', '0g6G8YKoCrQ9gxI9qUGZLl', '3002:164')
on conflict (slug) do nothing;

with p as (select id from providers where slug = 'play-n-go')
insert into figma_games (provider_id, slug, figma_node_id)
select p.id, g.slug, g.node_id from p, (values
  ('great-rhino',                   '3001:52409'),
  ('blades-blessings',              '7007:415'),
  ('rise-olympus',                  '7010:5730'),
  ('piggy-casino-gold',             '7011:10410'),
  ('barn-busters',                  '7012:11209'),
  ('mole-digger',                   '7014:11820'),
  ('tome-of-madness',               '7015:930'),
  ('peggy-heist',                   '7016:1801'),
  ('building-bucks',                '7017:1963'),
  ('ras-reckoning',                 '7017:2640'),
  ('fangs-and-fire',                '7017:3395'),
  ('bannana-rush',                  '7017:7122'),
  ('stadium-of-riches',             '7019:7347'),
  ('rings-of-prosperity',           '7019:7628'),
  ('lawn-disorder',                 '7020:10358'),
  ('static-nightmare',              '7020:11663'),
  ('divinia-commedia',              '7020:12979'),
  ('reactoonz-100',                 '7020:14236'),
  ('bubblin-riches',                '7021:14957'),
  ('bao-shi',                       '7021:15649'),
  ('fate-of-dead',                  '7023:15943'),
  ('bullion-xpress',                '7026:16595'),
  ('lab-of-madness',                '7026:17257'),
  ('rosy-orbit',                    '7026:17773'),
  ('fire-toad',                     '7027:18433'),
  ('fire-joker-blitz',              '7027:18858'),
  ('diamond-dig',                   '7027:19700'),
  ('spinning-records',              '7027:20092'),
  ('hercules',                      '7027:20735'),
  ('destiny-spins',                 '7030:21118'),
  ('buffalo',                       '7030:21373'),
  ('thorns',                        '7031:21636'),
  ('cashin-joker',                  '7031:21998'),
  ('rise-of-orpheus',               '7032:22230'),
  ('moon-princess',                 '7032:22384'),
  ('tomb-of-gold',                  '7032:22618'),
  ('big-win-cat',                   '7033:23073'),
  ('viper-city',                    '7034:23304'),
  ('king-of-sweets',                '7035:23891'),
  ('city-of-sounds',                '7035:24128'),
  ('fire-joker-100',                '7035:24287'),
  ('dragon-fate',                   '7035:24526'),
  ('treats-of-terror',              '7093:24740'),
  ('crabbys-gold',                  '7093:25020'),
  ('boat-bonanza',                  '7096:3889'),
  ('tome-of-dead',                  '7096:4233'),
  ('genie-fortuness',               '7096:4819'),
  ('loot-and-labyrinths',           '7096:5122'),
  ('mystery-egg',                   '7097:5299'),
  ('trinity-impact',                '7097:5481'),
  ('medusa',                        '7098:5649'),
  ('legion-gold-victory',           '7114:4342'),
  ('myth-of-dead',                  '7115:4728'),
  ('crystal-hall',                  '7117:4932'),
  ('revenge-on-mars',               '7117:5078'),
  ('potion-of-madenss',             '7117:5375'),
  ('tower-quest-legacy',            '7117:5698'),
  ('treasure-of-kongar',            '7117:5894'),
  ('midnight-gold',                 '7117:6113'),
  ('jolly-roger-wild',              '7117:6371'),
  ('hotdog-heist',                  '7117:6795'),
  ('lion-saga-odyssey',             '7118:7089'),
  ('godly-spins',                   '7119:7300'),
  ('wildest-gambit',                '7120:7499'),
  ('bonanza-christmas',             '7120:7644'),
  ('rich-wild',                     '7120:7950'),
  ('disco-gold',                    '7122:8246'),
  ('sphinx-of-dead',                '7122:8558'),
  ('beasts-of-fire',                '7122:9020'),
  ('baron',                         '7122:9281'),
  ('stepping-diamonds',             '7122:9654'),
  ('kingdom-below',                 '7130:9919'),
  ('divine-divas',                  '7130:10059'),
  ('mirror-joker',                  '7130:10341'),
  ('gemix',                         '7130:10488'),
  ('ankh-of-anubis',                '7130:10633'),
  ('scourge-of-rome',               '7130:10826'),
  ('joker-flip',                    '7130:11073'),
  ('mafia-gold',                    '7130:11229'),
  ('kings-mask',                    '7130:11368'),
  ('whispering-winds',              '7130:11577'),
  ('dans-band',                     '7137:11773'),
  ('oasis-of-dead',                 '7137:12000'),
  ('journey-to-paris',              '7137:12172'),
  ('temple-of-tollan',              '7137:12353'),
  ('merlin-realm-of-charm',         '7137:12556'),
  ('gold-of-fortune-god',           '7137:12712'),
  ('tome-of-insanity',              '7137:12997'),
  ('colt-lightning',                '7137:13285'),
  ('spark-of-genius',               '7138:13528'),
  ('wild-of-survivor',              '7138:13707'),
  ('fullong88',                     '7171:6833'),
  ('swordandthegrail',              '7171:7110'),
  ('down-under',                    '7171:7433'),
  ('tomb-of-gold-1',                '7171:7622'),
  ('mystery-genie1',                '7171:8239'),
  ('easter-egspedition',            '7171:8506'),
  ('piranha-pays',                  '7171:8804'),
  ('chamber-of-ancients',           '7171:9133'),
  ('banquet-of-dead',               '7171:9451'),
  ('legion-gold-unleashed',         '7171:9749'),
  ('undefeated-xerxes',             '7171:10035'),
  ('incan-quest',                   '7171:10302'),
  ('moon-princess-power-of-love',   '7171:10898'),
  ('3clown-monty2',                 '7171:11158'),
  ('pandastic-adventure',           '7171:11403'),
  ('syns-fortune',                  '7171:11685'),
  ('viking-runecraft-100',          '7171:11984'),
  ('megadon-feeding',               '7171:12251'),
  ('gargantoonz',                   '7171:12483'),
  ('lastchristmas-alien',           '7171:12681'),
  ('legacy-of-dinasties',           '7171:12873'),
  ('sherwood-gold',                 '7171:13122'),
  ('monkey-battle-for-the-scrolls', '7171:13430'),
  ('ruff-heist',                    '7171:13749'),
  ('raging-rex-3',                  '7191:8376'),
  ('return-of-the-green-knight',    '7191:8571'),
  ('piggy-blitz',                   '7191:8870'),
  ('temple-of-prosperity',          '7191:9154'),
  ('scales-of-dead',                '7191:9407'),
  ('colossal-catch',                '7192:9704')
) as g(slug, node_id)
on conflict (provider_id, slug) do nothing;


-- ── 11. SEED: Slotegrator aggregator ─────────────────────────
insert into aggregators (slug, name, api_url, auth_header, auth_key)
values (
  'slotegrator',
  'Slotegrator',
  'https://api-dev.beat.gg/api/partner/catalog/games',
  'x-p-key',
  '1ZWz8VWDPPdVszhV51jdNHv1/0ONLXKssCll3Vfg4Lo='
) on conflict (slug) do nothing;
