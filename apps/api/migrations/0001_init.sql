-- 0001_init.sql — Atlas Household initial schema (slice 1)
--
-- Hand-written on purpose: three tables, applied once, easy to read end to end.
-- From 0002 onward Alembic owns migrations (that slice alters chore_instances
-- and adds chore_definitions / chore_assignments / chore_subtask_templates).
--
-- This repo is PUBLIC. Nothing secret goes in a migration file.
-- Relies on gen_random_uuid(), which is core Postgres since v13 (Neon is fine).

begin;

create table households (
    id          uuid        primary key default gen_random_uuid(),
    name        text        not null,
    created_at  timestamptz not null default now()
);

create table members (
    id            uuid        primary key default gen_random_uuid(),
    household_id  uuid        not null references households (id) on delete cascade,
    name          text        not null,
    role          text        not null check (role in ('adult', 'kid', 'dependent')),
    color         text        not null,                       -- tile color (hex)
    created_at    timestamptz not null default now()
);

create table chore_instances (
    id            uuid        primary key default gen_random_uuid(),
    household_id  uuid        not null references households (id) on delete cascade,

    -- Whose chore. RESTRICT, not CASCADE: deleting a member must be refused,
    -- never allowed to silently take their chore history with it. Deactivation
    -- (a future is_active flag) is the right way to retire a person, not delete.
    assignee_id   uuid        not null references members (id) on delete restrict,

    title         text        not null,   -- chore text, denormalized (no chore_definitions this slice)
    due_on        date        not null,   -- the day this instance is "for"

    -- NULL = not done. "missed" stays derivable: due_on < today and completed_at is null.
    completed_at  timestamptz,

    -- Who tapped complete. Left non-cascading on purpose: same protection as
    -- assignee_id — a member with recorded completions can't be hard-deleted.
    completed_by  uuid        references members (id),

    created_at    timestamptz not null default now()
);

-- The board's only query: today's instances for a household.
create index on chore_instances (household_id, due_on);

commit;
