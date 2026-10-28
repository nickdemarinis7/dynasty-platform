create table if not exists public.saved_trades (
  id uuid primary key,
  user_id text not null,
  saved_at bigint not null,
  league text not null,
  team_a text not null,
  team_b text not null,
  sends text not null,
  receives text not null,
  fairness double precision not null,
  lineup_change double precision not null,
  offer_fit integer not null,
  verdict text not null
);

create index if not exists saved_trades_user_saved_at
  on public.saved_trades (user_id, saved_at desc);

alter table public.saved_trades enable row level security;

create table if not exists public.decision_journal (
  id uuid primary key,
  user_id text not null,
  saved_at bigint not null,
  league_id text not null,
  decision_type text not null,
  title text not null,
  status text not null,
  feedback text,
  outcome jsonb not null default '{}'::jsonb,
  payload jsonb not null
);

create index if not exists decision_journal_user_league_saved_at
  on public.decision_journal (user_id, league_id, saved_at desc);

alter table public.decision_journal enable row level security;

-- The Streamlit server uses a service-role secret and always scopes reads,
-- writes, and deletes to the authenticated OIDC subject. Do not expose that
-- service-role key in client code or commit it to the repository.
