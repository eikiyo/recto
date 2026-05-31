-- Add minimal first-run identity. `name` is captured at first-time onboarding;
-- `onboarded_at` is the single flag that gates the onboarding card in the UI.
-- Both nullable so existing rows (pre-launch test users) keep working — they'll
-- see the onboarding card on their next workbench load and fill it in once.

ALTER TABLE users ADD COLUMN name TEXT;
ALTER TABLE users ADD COLUMN onboarded_at INTEGER;
