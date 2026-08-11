-- Least-privilege panel authority for requesting an effective datapack-order
-- observation. This is a control-plane permission only: it does not grant a
-- Minecraft group and it does not grant the Server Agent capability. The
-- agent's allowlisted grant remains an independent operational decision.

INSERT INTO permissions (id, description) VALUES
  ('datapacks.observe', 'Request a bounded offline observation of effective datapack load order');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role_id, 'datapacks.observe'
FROM (VALUES ('owner'), ('administrator')) AS roles (role_id);
