-- The panel integration track needs two things the API could not do.
--
-- First, a session that a reloaded page can actually use. The CSRF token was
-- stored hashed, exactly like the session token, so it could only ever be
-- returned once — at login. Any screen that reloaded had no way to get it back
-- and every write refused. The two tokens are not the same kind of secret: the
-- session token *is* the credential and stays hashed; the CSRF token is only
-- meaningful when presented together with that cookie, and is useless to
-- anybody who cannot read a same-origin response. So it is stored as issued.
--
-- Second, a workspace to look at. Everything the build path produces —
-- inventory, mods, configuration, sandbox, release — starts from a directory
-- somebody imported, and there was no way to name one except by writing SQL.
--
-- What this file deliberately does not contain: nothing that lets the panel
-- send a path. The root is registered once, by an operator, and every later
-- request names the workspace by id. The same rule the authorized-file core
-- already follows, for the same reason.

ALTER TABLE sessions ADD COLUMN csrf_token TEXT;

CREATE TABLE panel_workspaces (
  workspace_id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  -- Absolute path on the host that runs the API. Registered by an operator,
  -- never sent by a screen.
  root_path TEXT NOT NULL CHECK (length(root_path) BETWEEN 2 AND 4096),
  -- What the workspace is for. A server and a client profile are inventoried
  -- the same way but mean different things in a release.
  kind TEXT NOT NULL CHECK (kind IN ('server', 'client-profile')),
  created_by JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);

-- One row per scan, never overwritten.
--
-- A scan is evidence with a time on it. Replacing the previous one in place
-- would make "what did this workspace look like before I changed it?"
-- unanswerable, which is the question the whole release path is built around.
CREATE TABLE workspace_inventories (
  inventory_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES panel_workspaces (workspace_id) ON DELETE CASCADE,
  -- Digest over the inventory's own content. Two scans of an unchanged tree
  -- produce the same value, which is what makes a diff meaningful.
  inventory_sha256 CHAR(64) NOT NULL,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanned_by JSONB NOT NULL,
  total_files INTEGER NOT NULL CHECK (total_files >= 0),
  total_bytes BIGINT NOT NULL CHECK (total_bytes >= 0),
  total_mods INTEGER NOT NULL CHECK (total_mods >= 0),
  -- The inventory document as produced by the scanner. Stored whole so the
  -- panel reads exactly what the engine wrote, rather than a second shape
  -- somebody maintains by hand.
  document JSONB NOT NULL
);

CREATE INDEX workspace_inventories_by_workspace
  ON workspace_inventories (workspace_id, scanned_at DESC);

-- The permissions themselves. Declaring one in TypeScript does not grant it:
-- the panel resolves what a user may do from these rows, so a permission that
-- exists only in the constant is a permission nobody has.
--
-- Reading is granted widely, including read-only, because a workspace scan is
-- structurally incapable of writing and holds no player data — an inventory
-- refuses worlds, logs and access lists by construction. Registering a root
-- and running a scan stay with owner and administrator: both name a directory
-- on the host, which is a different kind of decision from looking at one.
INSERT INTO permissions (id, description) VALUES
  ('workspace.view', 'View an imported workspace inventory, its mods and its configuration'),
  ('workspace.manage', 'Register a workspace root and run an inventory scan');

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'owner', id FROM permissions WHERE id IN ('workspace.view', 'workspace.manage');

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'administrator', id FROM permissions WHERE id IN ('workspace.view', 'workspace.manage');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role_id, 'workspace.view'
FROM (VALUES ('moderator'), ('support'), ('read-only')) AS roles (role_id);
