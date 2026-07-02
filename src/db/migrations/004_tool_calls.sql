-- Phase 03 / p3-T04: persist agent-loop tool calls on assistant messages.
--
-- tool_calls is JSON-encoded Array<ToolCallRecord>. Nullable.
-- Existing rows get NULL (the ALTER ADD COLUMN with NULL default
-- doesn't rewrite the table — better-sqlite3 stores NULL inline
-- for existing rows without a migration copy).
--
-- ToolCallRecord shape:
--   { name: string, arguments: object, result: unknown,
--     truncated: boolean, iteration: number }
--
-- `result` is whatever JSON the LLM saw — could be a chunk list,
-- document metadata, or a not-found error. The client renders it
-- via the ToolResultChip.

ALTER TABLE messages ADD COLUMN tool_calls TEXT;