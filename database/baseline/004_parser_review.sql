-- Preserve superseded interpretations alongside the source evidence.
BEGIN;
ALTER TABLE freight.tracking_events ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;
ALTER TABLE freight.tracking_events ADD COLUMN IF NOT EXISTS parser_version text NOT NULL DEFAULT '2026-11-08.1';
ALTER TABLE freight.tracking_events ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
ALTER TABLE freight.field_observations ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;
ALTER TABLE freight.field_observations ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='freight.field_observations'::regclass
   AND conname='selected_observation_is_current') THEN
  ALTER TABLE freight.field_observations ADD CONSTRAINT selected_observation_is_current CHECK (NOT is_selected OR is_current);
 END IF;
END $$;
CREATE OR REPLACE VIEW freight.current_tracking_events AS
SELECT * FROM freight.tracking_events WHERE is_current;
ALTER VIEW freight.current_tracking_events OWNER TO freight_app;
COMMENT ON VIEW freight.current_tracking_events IS '当前有效路由解释，含全部原始节点；历史错误解释保留在原表并标记 is_current=false';
COMMIT;
