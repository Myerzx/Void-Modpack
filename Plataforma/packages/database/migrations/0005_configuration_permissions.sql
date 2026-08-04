-- Phase 7.3 grants least-privilege panel permissions for authorized
-- configuration operations. Reading a configuration can expose reviewed
-- operational values, so no read-only, support or moderator role receives it
-- by default; the grant stays with owner and administrator only.
--
-- These permissions govern the VoidFall panel exclusively. Minecraft
-- permission groups remain a separate domain and are never derived from them.

INSERT INTO permissions (id, description) VALUES
  ('configuration.view', 'View authorized configuration schemas, redacted values and revisions'),
  ('configuration.validate', 'Validate a configuration change without applying it'),
  ('configuration.apply', 'Apply a reviewed configuration change'),
  ('configuration.rollback', 'Roll back a configuration to an eligible applied revision');

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'owner', id FROM permissions
WHERE id IN (
  'configuration.view', 'configuration.validate', 'configuration.apply', 'configuration.rollback'
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT 'administrator', id FROM permissions
WHERE id IN (
  'configuration.view', 'configuration.validate', 'configuration.apply', 'configuration.rollback'
);
