-- Phase 10.1 follow-up: carry the console command to the agent.
--
-- The console route accepted a command from the closed catalogue and then
-- dropped it: the job payload carried only the server and a version, so an
-- agent had no way to know which command it had been asked to run.
--
-- The command lives on the durable operation rather than in the job payload.
-- It is auditable there, it is constrained to the reviewed catalogue by the
-- database itself, and the queue keeps carrying nothing but an opaque
-- reference — a free-form command still cannot cross it.

ALTER TABLE server_operations
  ADD COLUMN console_command TEXT
  CHECK (console_command IS NULL OR console_command IN ('list-players', 'save-all'));

-- A command belongs to a console operation and to nothing else: a start that
-- carried one, or a console operation that carried none, would both be
-- meaningless.
-- Named distinctly from the column's own inline CHECK, which PostgreSQL
-- already auto-names `server_operations_console_command_check`.
ALTER TABLE server_operations
  ADD CONSTRAINT server_operations_console_command_kind_check
  CHECK ((kind = 'server.command') = (console_command IS NOT NULL));
