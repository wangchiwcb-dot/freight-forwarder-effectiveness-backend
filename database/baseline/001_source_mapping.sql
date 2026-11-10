BEGIN;
ALTER TABLE freight.shipments
    ADD COLUMN IF NOT EXISTS transport_mode text NOT NULL DEFAULT 'unknown'
        CHECK (transport_mode IN ('unknown', 'sea', 'rail', 'other')),
    ADD COLUMN IF NOT EXISTS service_tier text,
    ADD COLUMN IF NOT EXISTS reported_delivery_date date;
COMMENT ON COLUMN freight.shipments.reported_delivery_date IS '提单或路由明确报告的实际送仓日，目的仓范围可能不明，不能据此认定所有送仓明细完成';
COMMENT ON COLUMN freight.shipments.service_tier IS '列表 line_type 原值：普线／快线／特快线，与航线名分开';
-- shipment_summary 早期 SELECT * 列表已固化；显式另建字段概览避免改动旧视图列顺序。
CREATE OR REPLACE VIEW freight.shipment_transport_info AS
SELECT id, transport_mode, service_tier, reported_delivery_date FROM freight.shipments;
COMMIT;
