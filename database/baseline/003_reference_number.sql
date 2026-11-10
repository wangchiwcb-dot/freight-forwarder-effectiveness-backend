ALTER TABLE freight.shipments ADD COLUMN IF NOT EXISTS reference_no text;
COMMENT ON COLUMN freight.shipments.reference_no IS '源列表提单号第二行及详情参考号，独立于主提单号保存';
