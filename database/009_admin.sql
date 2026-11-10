-- Additive management schema. Apply once, explicitly, after a verified backup.
-- Existing freight business records and their publication flags are not rewritten.
BEGIN;
CREATE SCHEMA IF NOT EXISTS freight_admin;
CREATE TABLE IF NOT EXISTS freight_admin.migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
DO $$ BEGIN IF EXISTS(SELECT 1 FROM freight_admin.migrations WHERE version=9) THEN RAISE EXCEPTION 'Admin migration 9 is already installed'; END IF; END $$;
CREATE TABLE freight_admin.routes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant text NOT NULL, source_key text,
 name text NOT NULL DEFAULT '', channel text NOT NULL DEFAULT '', carrier text NOT NULL DEFAULT '',
 origin text NOT NULL DEFAULT '', destination text NOT NULL DEFAULT '', estimated_days integer CHECK(estimated_days BETWEEN 1 AND 365),
 enabled boolean NOT NULL DEFAULT true, published boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz, UNIQUE(tenant,source_key), UNIQUE(tenant,id)
);
CREATE TABLE freight_admin.warehouses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant text NOT NULL, source_key text,
 code text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '', region text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '',
 enabled boolean NOT NULL DEFAULT true, published boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz, UNIQUE(tenant,source_key), UNIQUE(tenant,id)
);
CREATE TABLE freight_admin.containers (
 shipment_id uuid PRIMARY KEY REFERENCES freight.shipments(id), tenant text NOT NULL,
 route_id uuid NOT NULL, container_type text NOT NULL DEFAULT '', owner_name text NOT NULL DEFAULT '', loaded_at date,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 FOREIGN KEY(tenant,route_id) REFERENCES freight_admin.routes(tenant,id), UNIQUE(tenant,shipment_id)
);
CREATE TABLE freight_admin.deliveries (
 delivery_id uuid PRIMARY KEY REFERENCES freight.deliveries(id), shipment_id uuid NOT NULL,
 tenant text NOT NULL, warehouse_id uuid NOT NULL,
 pieces integer CHECK(pieces>=0), cbm numeric(12,3) CHECK(cbm>=0), published boolean NOT NULL DEFAULT false,
 batch_no text NOT NULL, deleted_at timestamptz,
 FOREIGN KEY(shipment_id,delivery_id) REFERENCES freight.deliveries(shipment_id,id),
 FOREIGN KEY(tenant,warehouse_id) REFERENCES freight_admin.warehouses(tenant,id),
 FOREIGN KEY(tenant,shipment_id) REFERENCES freight_admin.containers(tenant,shipment_id)
);
CREATE INDEX admin_deliveries_shipment_idx ON freight_admin.deliveries(shipment_id);
CREATE INDEX admin_deliveries_warehouse_idx ON freight_admin.deliveries(warehouse_id);
CREATE INDEX admin_containers_route_idx ON freight_admin.containers(route_id);
CREATE TABLE freight_admin.inspections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shipment_id uuid NOT NULL, tenant text NOT NULL,
 source_exception_id uuid UNIQUE REFERENCES freight.shipment_exceptions(id),
 type text NOT NULL DEFAULT '海关查验', started_at date, ended_at date,
 status text NOT NULL DEFAULT 'unknown' CHECK(status IN('unknown','open','resolved')),
 notes text NOT NULL DEFAULT '', deleted_at timestamptz,
 FOREIGN KEY(tenant,shipment_id) REFERENCES freight_admin.containers(tenant,shipment_id)
);
CREATE INDEX admin_inspections_shipment_idx ON freight_admin.inspections(shipment_id);
CREATE TABLE freight_admin.audit_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant text NOT NULL, entity text NOT NULL, entity_id uuid NOT NULL,
 label text NOT NULL, action text NOT NULL, actor text NOT NULL, reason text,
 before_record jsonb, after_record jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_tenant_time_idx ON freight_admin.audit_logs(tenant,created_at DESC);

-- Exact source tuples include NULL values; unknown fields are never filled with guessed business values.
INSERT INTO freight_admin.routes(id,tenant,source_key,name,channel,carrier,origin,destination,enabled,published)
SELECT md5('route:'||source_tenant||':'||route_key)::uuid,source_tenant,route_key,
 coalesce(service_name,''),coalesce(channel_name,''),coalesce(carrier_name,''),coalesce(origin_port_name,''),coalesce(destination_port_name,''),true,true
FROM (SELECT DISTINCT source_tenant,service_name,channel_name,carrier_name,origin_port_name,destination_port_name,
 jsonb_build_array(channel_name,service_name,carrier_name,origin_port_name,destination_port_name)::text route_key FROM freight.shipments) q;
INSERT INTO freight_admin.containers(shipment_id,tenant,route_id,created_at,updated_at)
SELECT id,source_tenant,md5('route:'||source_tenant||':'||jsonb_build_array(channel_name,service_name,carrier_name,origin_port_name,destination_port_name)::text)::uuid,created_at,updated_at FROM freight.shipments;
INSERT INTO freight_admin.warehouses(id,tenant,source_key,code,name,enabled,published)
SELECT md5('warehouse:'||tenant||':'||warehouse_key)::uuid,tenant,warehouse_key,coalesce(warehouse_code,''),coalesce(warehouse_name,''),true,true
FROM (SELECT DISTINCT s.source_tenant tenant,d.warehouse_code,d.warehouse_name,jsonb_build_array(d.warehouse_code,d.warehouse_name)::text warehouse_key
 FROM freight.deliveries d JOIN freight.shipments s ON s.id=d.shipment_id
 WHERE d.delivery_scope='amazon_warehouse' AND d.amazon_timing_eligible IS TRUE AND NOT d.is_aggregate) q;
INSERT INTO freight_admin.deliveries(delivery_id,shipment_id,tenant,warehouse_id,published,batch_no)
SELECT d.id,d.shipment_id,s.source_tenant,
 md5('warehouse:'||s.source_tenant||':'||jsonb_build_array(d.warehouse_code,d.warehouse_name)::text)::uuid,true,d.delivery_key
FROM freight.deliveries d JOIN freight.shipments s ON s.id=d.shipment_id
WHERE d.delivery_scope='amazon_warehouse' AND d.amazon_timing_eligible IS TRUE AND NOT d.is_aggregate;
INSERT INTO freight_admin.inspections(id,shipment_id,tenant,source_exception_id,type,started_at,ended_at,status,notes)
SELECT e.id,e.shipment_id,s.source_tenant,e.id,coalesce(nullif(e.reason_code,''),'海关查验'),e.started_date,e.resolved_date,e.status,e.description
FROM freight.shipment_exceptions e JOIN freight.shipments s ON s.id=e.shipment_id
WHERE e.exception_type='inspection' AND e.confirmation_status='confirmed';
-- An existing inspected assessment without an exception is a known fact with unknown dates, not an invented event.
INSERT INTO freight_admin.inspections(id,shipment_id,tenant,type,status,notes)
SELECT md5('inspection-assessment:'||s.id::text)::uuid,s.id,s.source_tenant,'历史查验记录','unknown','原运输记录已确认查验，起止日期未记录。'
FROM freight.shipments s WHERE s.inspection_assessment='inspected'
AND NOT EXISTS(SELECT 1 FROM freight_admin.inspections i WHERE i.shipment_id=s.id);

-- Soft cancellation retains the known actual delivery date and historical evidence.
DO $$ DECLARE constraint_row record; BEGIN
 FOR constraint_row IN SELECT conname FROM pg_constraint WHERE conrelid='freight.deliveries'::regclass
 AND contype='c' AND pg_get_constraintdef(oid) LIKE '%actual_delivery_date IS NULL%'
 AND pg_get_constraintdef(oid) LIKE '%delivery_status%' LOOP
  EXECUTE format('ALTER TABLE freight.deliveries DROP CONSTRAINT %I',constraint_row.conname);
 END LOOP;
END $$;
ALTER TABLE freight.deliveries ADD CONSTRAINT deliveries_actual_date_status
 CHECK(actual_delivery_date IS NULL OR delivery_status IN('delivered','cancelled'));

-- Source changes made outside this UI also invalidate an open editor's revision.
CREATE FUNCTION freight_admin.bump_shipment_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freight_admin AS $$
BEGIN
 UPDATE freight_admin.containers SET version=version+1,updated_at=now() WHERE shipment_id=NEW.id;
 RETURN NEW;
END $$;
CREATE TRIGGER admin_shipment_revision AFTER UPDATE ON freight.shipments FOR EACH ROW EXECUTE FUNCTION freight_admin.bump_shipment_revision();
CREATE FUNCTION freight_admin.bump_child_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,freight_admin AS $$
BEGIN
 UPDATE freight_admin.containers SET version=version+1,updated_at=now() WHERE shipment_id=NEW.shipment_id;
 RETURN NEW;
END $$;
CREATE TRIGGER admin_delivery_revision AFTER INSERT OR UPDATE ON freight.deliveries FOR EACH ROW EXECUTE FUNCTION freight_admin.bump_child_revision();
CREATE TRIGGER admin_exception_revision AFTER INSERT OR UPDATE ON freight.shipment_exceptions FOR EACH ROW EXECUTE FUNCTION freight_admin.bump_child_revision();

-- Stable public gates; no internal records are granted to the read-only public application.
CREATE FUNCTION freight_admin.shipment_visible(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,freight_admin,freight AS $$
 SELECT EXISTS(SELECT 1 FROM freight.shipments s JOIN freight_admin.containers c ON c.shipment_id=s.id
 JOIN freight_admin.routes r ON r.id=c.route_id AND r.tenant=c.tenant
 WHERE s.id=p_id AND s.is_published AND c.deleted_at IS NULL AND r.deleted_at IS NULL AND r.enabled AND r.published);
$$;
CREATE FUNCTION freight_admin.delivery_visible(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,freight_admin,freight AS $$
 SELECT EXISTS(SELECT 1 FROM freight_admin.deliveries d JOIN freight_admin.warehouses w ON w.id=d.warehouse_id AND w.tenant=d.tenant
 WHERE d.delivery_id=p_id AND d.deleted_at IS NULL AND d.published AND w.deleted_at IS NULL AND w.enabled AND w.published AND freight_admin.shipment_visible(d.shipment_id));
$$;
CREATE OR REPLACE VIEW freight.valid_container_metrics AS
 SELECT * FROM freight.container_lifecycle WHERE is_valid_data AND record_status='active' AND freight_admin.shipment_visible(id);
CREATE OR REPLACE VIEW freight.valid_amazon_delivery_metrics AS
 SELECT * FROM freight.amazon_delivery_metrics WHERE is_valid_data AND amazon_timing_eligible
 AND (departure_to_amazon_delivery_days IS NOT NULL OR devanning_to_amazon_delivery_days IS NOT NULL) AND freight_admin.delivery_visible(id);
ALTER VIEW freight.valid_container_metrics OWNER TO freight_app;
ALTER VIEW freight.valid_amazon_delivery_metrics OWNER TO freight_app;
GRANT USAGE ON SCHEMA freight_admin TO freight_app;
GRANT EXECUTE ON FUNCTION freight_admin.shipment_visible(uuid),freight_admin.delivery_visible(uuid) TO freight_app;
REVOKE ALL ON FUNCTION freight_admin.shipment_visible(uuid),freight_admin.delivery_visible(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='freight_public_api') THEN
 GRANT USAGE ON SCHEMA freight_admin TO freight_public_api;
 GRANT EXECUTE ON FUNCTION freight_admin.shipment_visible(uuid),freight_admin.delivery_visible(uuid) TO freight_public_api;
END IF; END $$;
INSERT INTO freight_admin.migrations(version) VALUES(9);
COMMIT;
