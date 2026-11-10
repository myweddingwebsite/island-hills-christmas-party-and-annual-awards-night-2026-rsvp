-- Event RSVP — Island Hills Christmas Party & Annual Awards Night 2026
-- The app creates these tables automatically on the first request.
-- Run this in the Neon SQL Editor only if you prefer to create them yourself.

CREATE TABLE IF NOT EXISTS guests (               -- was the "Guests" sheet
  id               TEXT PRIMARY KEY,
  name1            TEXT NOT NULL,                  -- main guest
  status1          TEXT NOT NULL DEFAULT '',       -- 'Joyfully Accepts' | 'Regretfully Declines'
  companions       JSONB NOT NULL DEFAULT '[]'::jsonb, -- Name2..Name20: [{ "name": "...", "status": "..." }]
  companion_count  INTEGER NOT NULL DEFAULT 0,
  mode             TEXT NOT NULL DEFAULT 'Open',   -- 'Open' | 'Fixed'
  total_attending  INTEGER NOT NULL DEFAULT 0,
  submitted        BOOLEAN NOT NULL DEFAULT false,
  submitted_at     TIMESTAMPTZ,
  allergies        TEXT NOT NULL DEFAULT '',
  message          TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS guests_name1_lower_idx ON guests (lower(name1));

CREATE TABLE IF NOT EXISTS settings (              -- was Script Properties
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('rsvp_active', 'true') ON CONFLICT (key) DO NOTHING;
