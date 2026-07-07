-- Record which summarizer agent produced each run's summary. Additive and idempotent.
-- Values: 'fixture' (string-concat fallback) or a pooled SDK-agent label
-- (e.g. 'anthropic:claude-opus-4-8', 'openai:gpt-4o'), so the DB / dashboard shows how
-- summarization work spread across the agent pool.

ALTER TABLE run ADD COLUMN IF NOT EXISTS summary_agent text;
