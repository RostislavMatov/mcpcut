/**
 * The schema, in order (ADR-0020 §6). An ordered TS array rather than `.sql`
 * files: the package ships only `dist/**\/*.js`. Tables are unqualified — the
 * connection's `search_path` is the schema.
 */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

const FILE_EVENTS_SQL = `
CREATE TABLE ingest_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  last_seq bigint NOT NULL,
  -- the journal row at last_seq: tells a replaced journal from the one the cursor was taken in
  last_record_id text,
  -- journal records the index refused even one by one: while any is still in the journal, audits read the journal
  skipped_seqs bigint[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ingest_state (id, last_seq) VALUES (1, 0);

CREATE TABLE file_events (
  journal_seq bigint PRIMARY KEY,
  record_id text COLLATE "C" NOT NULL,
  session_id text NOT NULL,
  ts text COLLATE "C" NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('agent', 'admin')),
  actor_name text,
  actor_via text,
  action text NOT NULL,
  outcome text,
  rule text,
  subject_kind text CHECK (subject_kind IN ('agent', 'group')),
  subject_name text,
  agent_key text,
  paths text[] NOT NULL
);
CREATE INDEX file_events_newest ON file_events (ts DESC, record_id DESC);
CREATE INDEX file_events_agent ON file_events (agent_key, ts DESC);

CREATE TABLE file_event_paths (
  journal_seq bigint NOT NULL REFERENCES file_events (journal_seq) ON DELETE CASCADE,
  ord smallint NOT NULL,
  path_key text COLLATE "C" NOT NULL,
  key_prefix text COLLATE "C" NOT NULL,
  is_tree boolean NOT NULL,
  PRIMARY KEY (journal_seq, ord)
);
-- key_prefix is the first 600 code points of path_key: a long path never exceeds the btree row limit.
CREATE INDEX file_event_paths_key ON file_event_paths (key_prefix);

CREATE TABLE catalog (
  root text NOT NULL,
  rel_path text COLLATE "C" NOT NULL,
  kind text NOT NULL CHECK (kind IN ('file', 'dir')),
  size bigint NOT NULL,
  mtime_ms bigint NOT NULL,
  sha256 text,
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (root, rel_path)
);
`

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'file events and catalog', sql: FILE_EVENTS_SQL }]
