import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuditEntry, BaseRecord, Container, Delivery, EntityKind, EntityMap, Inspection, ShippingRoute, Snapshot, Warehouse } from '../shared/types.js';
import { containerVisible, deliveryVisible } from '../shared/types.js';
import { ApiError } from './store.js';
import type { Repository } from './repository.js';
import { parseInput, parseUpdateInput } from './validation.js';

type Row = Record<string, unknown>;
type RecordValue = EntityMap[EntityKind];
export interface Queryable { query<T extends Row = Row>(sql: string, values?: unknown[]): Promise<{rows:T[]}> }
export interface DatabaseClient extends Queryable { release(): void }
export interface DatabasePool extends Queryable { connect(): Promise<DatabaseClient>; end(): Promise<void> }
export interface PostgresOptions { connectionString?: string; tenant: string; actor?: string; pool?: DatabasePool }
const text=(value:unknown)=>value == null ? '' : String(value);
const nullableDate=(value:unknown):string|null=>value == null ? null : String(value).slice(0,10);
const numberOrNull=(value:unknown)=>value == null ? null : Number(value);
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const dateNow=()=>new Date().toISOString();
const asRecord=(value:unknown)=>value as Row;
const base=(r:Row,id=text(r.id)):BaseRecord=>({id,version:Number(r.version),createdAt:text(r.created_at),updatedAt:text(r.updated_at)});
const identifier=(value:string)=>{if(!/^[a-z_]+$/.test(value)) throw new Error('Invalid internal SQL identifier');return `"${value}"`;};
const routeFields: Record<string,string>={name:'service_name',channel:'channel_name',carrier:'carrier_name',origin:'origin_port_name',destination:'destination_port_name'};
const sourceFields: Record<string,string>={containerNo:'container_no',referenceNo:'waybill_no',vessel:'vessel_name',voyage:'voyage_no',notes:'notes_internal',
  etd:'etd_date',eta:'eta_date',departedAt:'atd_date',arrivedAt:'ata_date',dischargedAt:'discharged_date',availableAt:'available_for_pickup_date',pickedUpAt:'picked_up_date',devannedAt:'devanned_date'};
interface Operation {id:string;actor:string;reason:string;runId?:string}

export class PostgresRepository implements Repository {
  readonly source='postgres' as const;
  private pool: DatabasePool;
  private tenant: string;
  private defaultActor: string;
  constructor(options: PostgresOptions) {
    if(!options.pool && !options.connectionString) throw new Error('PostgreSQL connection is required');
    this.tenant=options.tenant; this.defaultActor=options.actor ?? '管理员';
    if(options.pool) this.pool=options.pool;
    else {
      const pool=new pg.Pool({connectionString:options.connectionString,max:6,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,statement_timeout:30000,application_name:'freight-admin-api'});
      pool.on('error',()=>process.stderr.write('Management database connection unavailable\n'));
      this.pool=pool as unknown as DatabasePool;
    }
  }
  async ready() {
    const result=await this.pool.query('SELECT version FROM freight_admin.migrations WHERE version=9');
    if(!result.rows.length) throw new Error('Management database migration 9 is required');
    const tenant=await this.pool.query('SELECT count(*)::int n FROM freight.shipments WHERE source_tenant=$1',[this.tenant]);
    if(!Number(tenant.rows[0]?.n)) throw new Error('Configured source tenant does not exist');
  }
  async close(){await this.pool.end();}
  private async transaction<T>(fn:(client:DatabaseClient)=>Promise<T>,readOnly=false):Promise<T>{
    const client=await this.pool.connect();
    try{
      await client.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
      const result=await fn(client); await client.query('COMMIT'); return result;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});
      if(error && typeof error==='object' && 'code' in error){
        if(error.code==='23505') throw new ApiError(409,'记录编号已存在，请刷新后检查');
        if(error.code==='23503') throw new ApiError(409,'记录已被引用或关联对象已发生变化');
        if(error.code==='40001'||error.code==='40P01') throw new ApiError(409,'数据正在被其他操作更新，请刷新后重试');
      }
      throw error;
    }finally{client.release();}
  }
  private async snapshotFrom(db:Queryable,onlyContainer?:string):Promise<Snapshot>{
    const routes=(await db.query('SELECT to_jsonb(r) value FROM freight_admin.routes r WHERE tenant=$1 AND deleted_at IS NULL ORDER BY updated_at DESC,id',[this.tenant])).rows.map(({value})=>{
      const r=asRecord(value); return {...base(r),name:text(r.name),channel:text(r.channel),carrier:text(r.carrier),origin:text(r.origin),destination:text(r.destination),estimatedDays:numberOrNull(r.estimated_days),enabled:Boolean(r.enabled),published:Boolean(r.published)};
    });
    const warehouses=(await db.query('SELECT to_jsonb(w) value FROM freight_admin.warehouses w WHERE tenant=$1 AND deleted_at IS NULL ORDER BY code,name,id',[this.tenant])).rows.map(({value})=>{
      const r=asRecord(value); return {...base(r),code:text(r.code),name:text(r.name),region:text(r.region),address:text(r.address),enabled:Boolean(r.enabled),published:Boolean(r.published)};
    });
    const params:unknown[]=[this.tenant]; if(onlyContainer)params.push(onlyContainer);
    const filter=onlyContainer?' AND c.shipment_id=$2::uuid':'';
    const deliveriesResult=await db.query(`SELECT to_jsonb(d) source,to_jsonb(a) extra,
      (d.is_valid_data AND d.delivery_status='delivered' AND d.delivery_scope='amazon_warehouse' AND d.amazon_timing_eligible IS TRUE
       AND NOT d.is_aggregate AND d.actual_delivery_date<=(now() AT TIME ZONE 'Asia/Shanghai')::date
       AND (m.departure_to_amazon_delivery_days IS NOT NULL OR m.devanning_to_amazon_delivery_days IS NOT NULL)) eligible,
      CASE WHEN d.actual_delivery_date<=(now() AT TIME ZONE 'Asia/Shanghai')::date THEN m.departure_to_amazon_delivery_days END total_days,
      CASE WHEN d.actual_delivery_date<=(now() AT TIME ZONE 'Asia/Shanghai')::date THEN m.devanning_to_amazon_delivery_days END tail_days
      FROM freight_admin.deliveries a JOIN freight.deliveries d ON d.id=a.delivery_id
      JOIN freight.amazon_delivery_metrics m ON m.id=d.id
      JOIN freight.shipments s ON s.id=d.shipment_id JOIN freight_admin.containers c ON c.shipment_id=s.id
      WHERE a.tenant=$1 AND c.tenant=$1 AND s.source_tenant=$1 AND a.deleted_at IS NULL AND c.deleted_at IS NULL${filter}
      ORDER BY d.created_at,d.id`,params);
    const deliveryMap=new Map<string,Delivery[]>();
    for(const row of deliveriesResult.rows){const d=asRecord(row.source),a=asRecord(row.extra); const shipmentId=text(d.shipment_id);
      const entry:Delivery={id:text(d.id),warehouseId:text(a.warehouse_id),batchNo:text(a.batch_no),pieces:numberOrNull(a.pieces),cbm:numberOrNull(a.cbm),plannedAt:nullableDate(d.estimated_delivery_date),deliveredAt:nullableDate(d.actual_delivery_date),published:Boolean(a.published),notes:text(d.notes_internal),recordStatus:text(d.delivery_status),isValidData:Boolean(d.is_valid_data),eligibleForPublic:Boolean(row.eligible),publicTiming:{totalDays:numberOrNull(row.total_days),tailDays:numberOrNull(row.tail_days)}};
      deliveryMap.set(shipmentId,[...(deliveryMap.get(shipmentId)??[]),entry]);
    }
    const inspectionsResult=await db.query(`SELECT to_jsonb(i) value FROM freight_admin.inspections i
      JOIN freight_admin.containers c ON c.shipment_id=i.shipment_id WHERE i.tenant=$1 AND c.tenant=$1 AND i.deleted_at IS NULL AND c.deleted_at IS NULL${filter}
      ORDER BY i.started_at NULLS LAST,i.id`,params);
    const inspectionMap=new Map<string,Inspection[]>();
    for(const {value} of inspectionsResult.rows){const i=asRecord(value),shipmentId=text(i.shipment_id);
      inspectionMap.set(shipmentId,[...(inspectionMap.get(shipmentId)??[]),{id:text(i.id),type:text(i.type),startedAt:nullableDate(i.started_at),endedAt:nullableDate(i.ended_at),status:text(i.status) as Inspection['status'],notes:text(i.notes)}]);
    }
    const containerRows=await db.query(`SELECT to_jsonb(s) source,to_jsonb(c) extra,
      (s.is_valid_data AND s.record_status='active' AND s.transport_mode='sea' AND s.atd_date IS NOT NULL
       AND s.atd_date<=(now() AT TIME ZONE 'Asia/Shanghai')::date AND NOT freight.has_metric_issue(s.id,ARRAY['atd_date'])) eligible,
      CASE WHEN s.atd_date<=(now() AT TIME ZONE 'Asia/Shanghai')::date AND NOT freight.has_metric_issue(s.id,ARRAY['atd_date']) THEN s.atd_date::text END public_departed,
      CASE WHEN s.ata_date<=(now() AT TIME ZONE 'Asia/Shanghai')::date AND NOT freight.has_metric_issue(s.id,ARRAY['ata_date']) THEN s.ata_date::text END public_arrived,
      CASE WHEN s.discharged_date<=(now() AT TIME ZONE 'Asia/Shanghai')::date AND NOT freight.has_metric_issue(s.id,ARRAY['discharged_date']) THEN s.discharged_date::text END public_discharged,
      CASE WHEN s.available_for_pickup_date<=(now() AT TIME ZONE 'Asia/Shanghai')::date AND NOT freight.has_metric_issue(s.id,ARRAY['available_for_pickup_date']) THEN s.available_for_pickup_date::text END public_available,
      CASE WHEN s.picked_up_date<=(now() AT TIME ZONE 'Asia/Shanghai')::date AND NOT freight.has_metric_issue(s.id,ARRAY['picked_up_date']) THEN s.picked_up_date::text END public_picked,
      CASE WHEN s.devanned_date<=(now() AT TIME ZONE 'Asia/Shanghai')::date AND NOT freight.has_metric_issue(s.id,ARRAY['devanned_date']) THEN s.devanned_date::text END public_devanned,
      CASE WHEN s.devanned_date<=(now() AT TIME ZONE 'Asia/Shanghai')::date THEN m.departure_to_devanning_days END total_days
      FROM freight.shipments s JOIN freight_admin.containers c ON c.shipment_id=s.id
      JOIN freight.container_lifecycle m ON m.id=s.id
      WHERE s.source_tenant=$1 AND c.tenant=$1 AND c.deleted_at IS NULL${filter} ORDER BY c.updated_at DESC,s.id`,params);
    const containers:Container[]=containerRows.rows.map(row=>{
      const s=asRecord(row.source),c=asRecord(row.extra),id=text(s.id),inspections=inspectionMap.get(id)??[];
      return {...base(c,id),containerNo:text(s.container_no),referenceNo:text(s.waybill_no??s.reference_no??s.source_waybill_id),sourceReferenceNo:text(s.reference_no),
        routeId:text(c.route_id),vessel:text(s.vessel_name),voyage:text(s.voyage_no),containerType:text(c.container_type),owner:text(c.owner_name),notes:text(s.notes_internal),
        etd:nullableDate(s.etd_date),eta:nullableDate(s.eta_date),loadedAt:nullableDate(c.loaded_at),departedAt:nullableDate(s.atd_date),arrivedAt:nullableDate(s.ata_date),
        dischargedAt:nullableDate(s.discharged_date),availableAt:nullableDate(s.available_for_pickup_date),pickedUpAt:nullableDate(s.picked_up_date),devannedAt:nullableDate(s.devanned_date),
        inspectionDisposition:inspections.length||s.inspection_assessment==='inspected'?'recorded':s.inspection_basis==='default_no_evidence'?'unknown':'clear',
        inspections,deliveries:deliveryMap.get(id)??[],manifestComplete:s.delivery_manifest_status==='complete',published:Boolean(s.is_published),
        transportMode:text(s.transport_mode),recordStatus:text(s.record_status),isValidData:Boolean(s.is_valid_data),eligibleForPublic:Boolean(row.eligible),
        publicTiming:{departedAt:nullableDate(row.public_departed),arrivedAt:nullableDate(row.public_arrived),dischargedAt:nullableDate(row.public_discharged),
          availableAt:nullableDate(row.public_available),pickedUpAt:nullableDate(row.public_picked),devannedAt:nullableDate(row.public_devanned),totalDays:numberOrNull(row.total_days)}};
    });
    const audit:AuditEntry[]=onlyContainer?[]:(await db.query(`SELECT to_jsonb(a) value FROM freight_admin.audit_logs a WHERE tenant=$1 ORDER BY created_at DESC,id DESC LIMIT 200`,[this.tenant])).rows.map(({value})=>{
      const a=asRecord(value); return {id:text(a.id),entity:text(a.entity) as EntityKind,entityId:text(a.entity_id),label:text(a.label),action:text(a.action) as AuditEntry['action'],actor:text(a.actor),at:text(a.created_at),before:a.before_record,after:a.after_record};
    });
    return {source:'postgres',routes,warehouses,containers,audit};
  }
  async snapshot(){return this.transaction(db=>this.snapshotFrom(db),true);}
  async publicPreview(){
    const s=await this.snapshot();
    return {source:'postgres',routes:s.routes.filter(r=>r.enabled&&r.published).map(({id,name,channel,carrier,origin,destination,estimatedDays})=>({id,name,channel,carrier,origin,destination,estimatedDays})),
      warehouses:s.warehouses.filter(w=>w.enabled&&w.published).map(({id,code,name,region})=>({id,code,name,region})),
      containers:s.containers.filter(c=>containerVisible(c,s.routes)).map(c=>({id:c.id,containerNo:c.containerNo,routeId:c.routeId,vessel:c.vessel,voyage:c.voyage,
        departedAt:c.publicTiming!.departedAt,arrivedAt:c.publicTiming!.arrivedAt,dischargedAt:c.publicTiming!.dischargedAt,availableAt:c.publicTiming!.availableAt,pickedUpAt:c.publicTiming!.pickedUpAt,devannedAt:c.publicTiming!.devannedAt,totalDays:c.publicTiming!.totalDays,publicTiming:c.publicTiming,
        inspections:c.inspections.map(({id,type,startedAt,endedAt,status})=>({id,type,startedAt,endedAt,status})),
        deliveries:c.deliveries.filter(d=>deliveryVisible(c,d,s.routes,s.warehouses)).map(({id,warehouseId,plannedAt,deliveredAt,publicTiming})=>({id,warehouseId,plannedAt,deliveredAt,totalDays:publicTiming?.totalDays??null,tailDays:publicTiming?.tailDays??null,publicTiming}))}))};
  }
  private async get(db:Queryable,kind:EntityKind,id:string):Promise<RecordValue>{
    if(kind==='containers'){
      const record=(await this.snapshotFrom(db,id)).containers[0];
      if(!record)throw new ApiError(404,'该记录不存在，可能已归档');return record;
    }
    const row=(await db.query(`SELECT to_jsonb(r) value FROM freight_admin.${kind} r WHERE tenant=$1 AND id=$2 AND deleted_at IS NULL`,[this.tenant,id])).rows[0];
    if(!row)throw new ApiError(404,'该记录不存在，可能已归档');const r=asRecord(row.value);
    if(kind==='routes')return {...base(r),name:text(r.name),channel:text(r.channel),carrier:text(r.carrier),origin:text(r.origin),destination:text(r.destination),estimatedDays:numberOrNull(r.estimated_days),enabled:Boolean(r.enabled),published:Boolean(r.published)};
    return {...base(r),code:text(r.code),name:text(r.name),region:text(r.region),address:text(r.address),enabled:Boolean(r.enabled),published:Boolean(r.published)};
  }
  private async lock(db:Queryable,kind:EntityKind,id:string,version:number){
    if(!z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).safeParse(id).success)throw new ApiError(404,'记录不存在');
    const table=kind==='containers'?'containers':kind;
    const key=kind==='containers'?'shipment_id':'id';
    const rows=(await db.query(`SELECT version FROM freight_admin.${table} WHERE tenant=$1 AND ${key}=$2 AND deleted_at IS NULL FOR UPDATE`,[this.tenant,id])).rows;
    if(!rows.length)throw new ApiError(404,'该记录不存在，可能已归档');
    if(Number(rows[0]!.version)!==version)throw new ApiError(409,'记录已被其他操作更新，请刷新后重试');
  }
  private operation(body:unknown,actor?:string,defaultReason='后台维护'):Operation{
    const reason=typeof body==='object'&&body&&'correctionReason'in body?text(body.correctionReason).trim():'';
    if(reason.length>1000)throw new ApiError(400,'更正原因最多 1000 个字符');
    return {id:randomUUID(),actor:actor??this.defaultActor,reason:reason||defaultReason};
  }
  private requireReason(body:unknown){
    const reason=typeof body==='object'&&body&&'correctionReason'in body?text(body.correctionReason).trim():'';
    if(reason.length<2)throw new ApiError(400,'修改已有业务数据需要填写更正原因（至少 2 个字符）');
  }
  private async writeSource(db:Queryable,table:'shipments'|'deliveries'|'shipment_exceptions',id:string,changes:Row){
    if(!Object.keys(changes).length)return;
    const entries=Object.entries(changes);entries.push(['updated_at',dateNow()]);
    await db.query(`UPDATE freight.${table} SET ${entries.map(([key],i)=>`${identifier(key)}=$${i+1}`).join(',')} WHERE id=$${entries.length+1}`,[...entries.map(([,value])=>value),id]);
  }
  private async sourceEvidence(db:Queryable,operation:Operation,shipmentId:string,table:string,entityId:string,changes:Record<string,{before:unknown;after:unknown}>,deliveryId:string|null=null){
    if(!Object.keys(changes).length)return;
    if(!operation.runId){operation.runId=randomUUID();await db.query(`INSERT INTO freight.import_runs(id,source_type,status,parameters,processed_count,started_at,finished_at) VALUES($1,'manual','completed',$2::jsonb,1,now(),now())`,[operation.runId,JSON.stringify({operation:operation.id,actor:operation.actor,reason:operation.reason})]);}
    const payload={operation:operation.id,table,entityId,changes,reason:operation.reason};
    const json=JSON.stringify(payload),sourceId=randomUUID();
    await db.query(`INSERT INTO freight.source_records(id,first_import_run_id,last_import_run_id,shipment_id,source_type,source_record_key,source_locator,payload,payload_sha256,parser_version)
      VALUES($1,$2,$2,$3,'manual',$4,$5::jsonb,$6::jsonb,$7,'admin-v1')`,[sourceId,operation.runId,shipmentId,`admin:${operation.id}:${table}:${entityId}:${sourceId}`,JSON.stringify({application:'freight-admin',entityId}),json,createHash('sha256').update(json).digest('hex')]);
    for(const [sourceField,change]of Object.entries(changes)){
      const field=table==='shipment_exceptions'?`inspection:${entityId}:${sourceField}`:sourceField;
      await db.query(`UPDATE freight.field_observations SET is_selected=false,manual_lock=false WHERE shipment_id=$1 AND delivery_id IS NOT DISTINCT FROM $2::uuid AND field_name=$3 AND is_selected`,[shipmentId,deliveryId,field]);
      await db.query(`INSERT INTO freight.field_observations(id,shipment_id,delivery_id,field_name,source_record_id,source_locator,raw_value,normalized_value,parser_version,parse_status,is_selected,manual_lock,selection_reason,selected_by,selected_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'admin-v1','valid',true,true,$9,$10,now())`,[randomUUID(),shipmentId,deliveryId,field,sourceId,`admin.${table}.${field}`,JSON.stringify(change.after??null),JSON.stringify(change.after??null),operation.reason,operation.actor]);
    }
    await db.query(`INSERT INTO freight.audit_logs(shipment_id,entity_type,entity_id,action,actor_type,actor_id,changes,reason,import_run_id) VALUES($1,$2,$3,'manual_correction','user',$4,$5::jsonb,$6,$7)`,[shipmentId,table,entityId,operation.actor,JSON.stringify(changes),operation.reason,operation.runId]);
    return sourceId;
  }
  private async audit(db:Queryable,kind:EntityKind,before:RecordValue|null,after:RecordValue|null,action:AuditEntry['action'],op:Operation){
    const record=after??before!;
    const label=kind==='containers'?(record as Container).containerNo:kind==='routes'?(record as ShippingRoute).name:(record as Warehouse).code;
    await db.query(`INSERT INTO freight_admin.audit_logs(tenant,entity,entity_id,label,action,actor,reason,before_record,after_record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,[this.tenant,kind,record.id,label,action,op.actor,op.reason,JSON.stringify(before),JSON.stringify(after)]);
  }
  private async dictionary(db:Queryable,kind:'routes'|'warehouses',id:string){
    if(!z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).safeParse(id).success)throw new ApiError(400,kind==='routes'?'所选航线不存在':'所选仓库不存在');
    const row=(await db.query(`SELECT to_jsonb(r) value FROM freight_admin.${kind} r WHERE tenant=$1 AND id=$2 AND deleted_at IS NULL FOR KEY SHARE`,[this.tenant,id])).rows[0];
    if(!row)throw new ApiError(400,kind==='routes'?'所选航线不存在':'所选仓库不存在');return asRecord(row.value);
  }
  private async rawSource(db:Queryable,table:'shipments'|'deliveries'|'shipment_exceptions',id:string):Promise<Row>{
    const row=(await db.query(`SELECT to_jsonb(s) value FROM freight.${table} s WHERE id=$1 FOR UPDATE`,[id])).rows[0];
    if(!row)throw new ApiError(404,'源记录不存在');return asRecord(row.value);
  }
  private differences(raw:Row,updates:Row):Record<string,{before:unknown;after:unknown}>{
    return Object.fromEntries(Object.entries(updates).filter(([key,value])=>!equal(raw[key]??null,value??null)).map(([key,value])=>[key,{before:raw[key]??null,after:value??null}]));
  }
  private async applySource(db:Queryable,op:Operation,table:'shipments'|'deliveries'|'shipment_exceptions',raw:Row,updates:Row,shipmentId:string,deliveryId:string|null=null){
    const changes=this.differences(raw,updates);if(!Object.keys(changes).length)return;
    await this.sourceEvidence(db,op,shipmentId,table,text(raw.id),changes,deliveryId);
    await this.writeSource(db,table,text(raw.id),Object.fromEntries(Object.entries(changes).map(([key,value])=>[key,value.after])));
  }
  private async assertIdentity(db:Queryable,referenceNo:string,exceptId?:string){
    const rows=(await db.query(`SELECT id FROM freight.shipments WHERE source_tenant=$1 AND lower(waybill_no)=lower($2) AND ($3::uuid IS NULL OR id<>$3::uuid) LIMIT 1`,[this.tenant,referenceNo,exceptId??null])).rows;
    if(rows.length)throw new ApiError(409,'提单号已存在，请使用本次运输的唯一编号');
  }
  private async createDelivery(db:Queryable,op:Operation,shipmentId:string,d:Delivery){
    const warehouse=await this.dictionary(db,'warehouses',d.warehouseId);
    // A supplied ID cannot reparent an imported or another tenant's record.
    if(z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).safeParse(d.id).success && (await db.query('SELECT id FROM freight.deliveries WHERE id=$1',[d.id])).rows.length)throw new ApiError(400,'送仓批次不属于当前柜子');
    const id=randomUUID();
    const values:Row={id,shipment_id:shipmentId,delivery_key:`manual:${id}`,warehouse_code:warehouse.code||null,warehouse_name:warehouse.name||null,
      destination_type:'amazon',delivery_method:'truck',delivery_scope:'amazon_warehouse',amazon_timing_eligible:true,scope_reason:'管理员明确登记亚马逊仓库批次',
      completion_class:d.deliveredAt?'delivered':'unknown',estimated_delivery_date:d.plannedAt,actual_delivery_date:d.deliveredAt,
      delivery_status:d.deliveredAt?'delivered':'pending',notes_internal:d.notes||null,is_valid_data:true,data_validity:'valid',delivery_date_basis:d.deliveredAt?'manual_admin':null};
    await this.insertSource(db,'deliveries',values);
    await db.query(`INSERT INTO freight_admin.deliveries(delivery_id,shipment_id,tenant,warehouse_id,pieces,cbm,published,batch_no) VALUES($1,$2,$3,$4,$5,$6,false,$7)`,[id,shipmentId,this.tenant,d.warehouseId,d.pieces,d.cbm,d.batchNo]);
    await this.sourceEvidence(db,op,shipmentId,'deliveries',id,this.differences({},values),id);
  }
  private async insertSource(db:Queryable,table:'shipments'|'deliveries'|'shipment_exceptions',values:Row){
    const entries=Object.entries(values);
    await db.query(`INSERT INTO freight.${table}(${entries.map(([key])=>identifier(key)).join(',')}) VALUES(${entries.map((_,i)=>`$${i+1}`).join(',')})`,entries.map(([,value])=>value));
  }
  private inspectionStatus(i:Inspection){return i.status??(i.endedAt?'resolved':i.startedAt?'open':'unknown');}
  private async createInspection(db:Queryable,op:Operation,shipmentId:string,i:Inspection,existingAdminId?:string){
    if(!existingAdminId && z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).safeParse(i.id).success && (await db.query('SELECT id FROM freight_admin.inspections WHERE id=$1',[i.id])).rows.length)throw new ApiError(400,'查验记录不属于当前柜子');
    const id=randomUUID(),status=this.inspectionStatus(i);
    const values:Row={id,shipment_id:shipmentId,exception_key:`manual:${id}`,exception_type:'inspection',confirmation_status:'confirmed',status,
      started_date:i.startedAt,resolved_date:i.endedAt,reason_code:i.type,description:i.notes||i.type,confirmed_by:op.actor,confirmed_at:dateNow(),source_locator:`admin.inspections.${id}`};
    const sourceId=await this.sourceEvidence(db,op,shipmentId,'shipment_exceptions',id,this.differences({},values));
    await this.insertSource(db,'shipment_exceptions',{...values,source_record_id:sourceId});
    if(existingAdminId) await db.query(`UPDATE freight_admin.inspections SET source_exception_id=$1,type=$2,started_at=$3,ended_at=$4,status=$5,notes=$6 WHERE id=$7 AND tenant=$8`,[id,i.type,i.startedAt,i.endedAt,status,i.notes,existingAdminId,this.tenant]);
    else await db.query(`INSERT INTO freight_admin.inspections(id,shipment_id,tenant,source_exception_id,type,started_at,ended_at,status,notes) VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8)`,[id,shipmentId,this.tenant,i.type,i.startedAt,i.endedAt,status,i.notes]);
  }
  async create(kind:EntityKind,body:unknown,actor?:string):Promise<RecordValue>{
    const input=parseInput(kind,body),op=this.operation(body,actor,'后台新增记录');
    return this.transaction(async db=>{
      const id=randomUUID();
      if(kind==='routes'){
        const r=input as ShippingRoute;
        await db.query(`INSERT INTO freight_admin.routes(id,tenant,name,channel,carrier,origin,destination,estimated_days,enabled,published) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false)`,[id,this.tenant,r.name,r.channel,r.carrier,r.origin,r.destination,r.estimatedDays,r.enabled]);
      }else if(kind==='warehouses'){
        const w=input as Warehouse;
        if((await db.query('SELECT id FROM freight_admin.warehouses WHERE tenant=$1 AND upper(code)=upper($2) AND deleted_at IS NULL',[this.tenant,w.code])).rows.length)throw new ApiError(409,'仓库代码已存在');
        await db.query(`INSERT INTO freight_admin.warehouses(id,tenant,code,name,region,address,enabled,published) VALUES($1,$2,$3,$4,$5,$6,$7,false)`,[id,this.tenant,w.code,w.name,w.region,w.address,w.enabled]);
      }else{
        const c=input as Container,route=await this.dictionary(db,'routes',c.routeId);await this.assertIdentity(db,c.referenceNo);
        const values:Row={id,source_system:'manual_admin',source_tenant:this.tenant,source_waybill_id:id,waybill_no:c.referenceNo,container_no:c.containerNo,
          transport_mode:'sea',record_status:'active',channel_name:route.channel||null,service_name:route.name||null,carrier_name:route.carrier||null,
          origin_port_name:route.origin||null,destination_port_name:route.destination||null,vessel_name:c.vessel||null,voyage_no:c.voyage||null,notes_internal:c.notes||null,
          etd_date:c.etd,eta_date:c.eta,atd_date:c.departedAt,ata_date:c.arrivedAt,discharged_date:c.dischargedAt,available_for_pickup_date:c.availableAt,picked_up_date:c.pickedUpAt,devanned_date:c.devannedAt,
          inspection_assessment:c.inspections.length?'inspected':'not_inspected',inspection_basis:c.inspectionDisposition==='unknown'?'default_no_evidence':'manual',
          delivery_manifest_status:c.manifestComplete?'complete':'unknown',manifest_confirmed_by:c.manifestComplete?op.actor:null,manifest_confirmed_at:c.manifestComplete?dateNow():null,
          is_published:false,is_valid_data:true,data_validity:'valid'};
        await this.insertSource(db,'shipments',values);
        await db.query(`INSERT INTO freight_admin.containers(shipment_id,tenant,route_id,container_type,owner_name,loaded_at) VALUES($1,$2,$3,$4,$5,$6)`,[id,this.tenant,c.routeId,c.containerType,c.owner,c.loadedAt]);
        await this.sourceEvidence(db,op,id,'shipments',id,this.differences({},values));
        for(const d of c.deliveries)await this.createDelivery(db,op,id,d);
        for(const i of c.inspections)await this.createInspection(db,op,id,i);
      }
      const after=await this.get(db,kind,id);await this.audit(db,kind,null,after,'create',op);return after;
    });
  }
  private async editDeliveries(db:Queryable,op:Operation,before:Container,next:Container,body:unknown){
    const previous=new Map(before.deliveries.map(d=>[d.id,d])),nextIds=new Set(next.deliveries.map(d=>d.id));
    for(const d of next.deliveries){
      const old=previous.get(d.id);
      if(!old){await this.createDelivery(db,op,before.id,d);continue;}
      if(equal(old,d))continue;
      const raw=await this.rawSource(db,'deliveries',d.id);
      if(text(raw.shipment_id)!==before.id)throw new ApiError(400,'送仓批次不属于当前柜子');
      const updates:Row={};
      if(d.warehouseId!==old.warehouseId){const w=await this.dictionary(db,'warehouses',d.warehouseId);updates.warehouse_code=w.code||null;updates.warehouse_name=w.name||null;}
      if(d.plannedAt!==old.plannedAt)updates.estimated_delivery_date=d.plannedAt;
      if(d.deliveredAt!==old.deliveredAt){updates.actual_delivery_date=d.deliveredAt;if(raw.delivery_status!=='cancelled')updates.delivery_status=d.deliveredAt?'delivered':'pending';}
      if(d.notes!==old.notes)updates.notes_internal=d.notes||null;
      if(Object.keys(updates).length){this.requireReason(body);await this.applySource(db,op,'deliveries',raw,updates,before.id,d.id);}
      await db.query(`UPDATE freight_admin.deliveries SET warehouse_id=$1,pieces=$2,cbm=$3,published=$4,batch_no=$5 WHERE delivery_id=$6 AND shipment_id=$7 AND tenant=$8`,[d.warehouseId,d.pieces,d.cbm,d.published,d.batchNo,d.id,before.id,this.tenant]);
    }
    for(const old of before.deliveries)if(!nextIds.has(old.id)){
      this.requireReason(body);const raw=await this.rawSource(db,'deliveries',old.id);
      await this.applySource(db,op,'deliveries',raw,{delivery_status:'cancelled'},before.id,old.id);
      await db.query(`UPDATE freight_admin.deliveries SET deleted_at=now(),published=false WHERE delivery_id=$1 AND tenant=$2`,[old.id,this.tenant]);
    }
  }
  private async editInspections(db:Queryable,op:Operation,before:Container,next:Container,body:unknown){
    const previous=new Map(before.inspections.map(i=>[i.id,i])),nextIds=new Set(next.inspections.map(i=>i.id));
    for(const i of next.inspections){
      const old=previous.get(i.id);if(!old){await this.createInspection(db,op,before.id,i);continue;}
      if(equal(old,i))continue;
      this.requireReason(body);
      const admin=(await db.query('SELECT source_exception_id FROM freight_admin.inspections WHERE id=$1 AND shipment_id=$2 AND tenant=$3 AND deleted_at IS NULL FOR UPDATE',[i.id,before.id,this.tenant])).rows[0];
      if(!admin)throw new ApiError(400,'查验记录不属于当前柜子');
      if(!admin.source_exception_id){await this.createInspection(db,op,before.id,i,i.id);continue;}
      const raw=await this.rawSource(db,'shipment_exceptions',text(admin.source_exception_id));
      const updates:Row={};
      if(i.type!==old.type)updates.reason_code=i.type;
      if(i.startedAt!==old.startedAt)updates.started_date=i.startedAt;
      if(i.endedAt!==old.endedAt)updates.resolved_date=i.endedAt;
      const status=this.inspectionStatus(i);if(status!==this.inspectionStatus(old))updates.status=status;
      if(i.notes!==old.notes)updates.description=i.notes||i.type;
      await this.applySource(db,op,'shipment_exceptions',raw,updates,before.id);
      await db.query(`UPDATE freight_admin.inspections SET type=$1,started_at=$2,ended_at=$3,status=$4,notes=$5 WHERE id=$6 AND tenant=$7`,[i.type,i.startedAt,i.endedAt,status,i.notes,i.id,this.tenant]);
    }
    for(const old of before.inspections)if(!nextIds.has(old.id)){
      this.requireReason(body);
      const admin=(await db.query('SELECT source_exception_id FROM freight_admin.inspections WHERE id=$1 AND shipment_id=$2 AND tenant=$3 FOR UPDATE',[old.id,before.id,this.tenant])).rows[0]!;
      if(admin.source_exception_id){const raw=await this.rawSource(db,'shipment_exceptions',text(admin.source_exception_id));await this.applySource(db,op,'shipment_exceptions',raw,{confirmation_status:'rejected'},before.id);}
      await db.query('UPDATE freight_admin.inspections SET deleted_at=now() WHERE id=$1 AND tenant=$2',[old.id,this.tenant]);
    }
  }
  async update(kind:EntityKind,id:string,body:unknown,version:number,actor?:string):Promise<RecordValue>{
    const op=this.operation(body,actor);
    return this.transaction(async db=>{
      await this.lock(db,kind,id,version);const before=await this.get(db,kind,id);
      const parsed=parseUpdateInput(kind,body,before as unknown as Row);
      const next={...before,...parsed,published:before.published} as RecordValue;
      if(kind==='containers'){
        const old=before as Container,c=next as Container,raw=await this.rawSource(db,'shipments',id),updates:Row={};
        for(const [key,column] of Object.entries(sourceFields))if(!equal(asRecord(c)[key],asRecord(old)[key]))updates[column]=asRecord(c)[key]||null;
        if(c.referenceNo!==old.referenceNo)await this.assertIdentity(db,c.referenceNo,id);
        if(c.routeId!==old.routeId){const r=await this.dictionary(db,'routes',c.routeId);for(const [key,column]of Object.entries(routeFields))updates[column]=r[key]||null;}
        if(c.manifestComplete!==old.manifestComplete){updates.delivery_manifest_status=c.manifestComplete?'complete':'partial';updates.manifest_confirmed_by=c.manifestComplete?op.actor:null;updates.manifest_confirmed_at=c.manifestComplete?dateNow():null;}
        if(c.inspectionDisposition!==old.inspectionDisposition){updates.inspection_assessment=c.inspectionDisposition==='recorded'?'inspected':'not_inspected';updates.inspection_basis=c.inspectionDisposition==='unknown'?'default_no_evidence':'manual';}
        if(Object.keys(updates).length){this.requireReason(body);await this.applySource(db,op,'shipments',raw,updates,id);}
        await this.editDeliveries(db,op,old,c,body);await this.editInspections(db,op,old,c,body);
        await db.query(`UPDATE freight_admin.containers SET route_id=$1,container_type=$2,owner_name=$3,loaded_at=$4,version=version+1,updated_at=now() WHERE shipment_id=$5 AND tenant=$6`,[c.routeId,c.containerType,c.owner,c.loadedAt,id,this.tenant]);
      }else if(kind==='routes'){
        const old=before as ShippingRoute,r=next as ShippingRoute;
        const sourceUpdates=Object.fromEntries(Object.entries(routeFields).filter(([key])=>!equal(asRecord(old)[key],asRecord(r)[key])).map(([key,column])=>[column,asRecord(r)[key]||null]));
        if(Object.keys(sourceUpdates).length){this.requireReason(body);const rows=await db.query(`SELECT to_jsonb(s) value FROM freight.shipments s JOIN freight_admin.containers c ON c.shipment_id=s.id WHERE c.route_id=$1 AND c.tenant=$2 AND s.source_tenant=$2 FOR UPDATE OF s`,[id,this.tenant]);
          for(const {value}of rows.rows){const raw=asRecord(value);await this.applySource(db,op,'shipments',raw,sourceUpdates,text(raw.id));}}
        await db.query(`UPDATE freight_admin.routes SET name=$1,channel=$2,carrier=$3,origin=$4,destination=$5,estimated_days=$6,enabled=$7,version=version+1,updated_at=now() WHERE id=$8 AND tenant=$9`,[r.name,r.channel,r.carrier,r.origin,r.destination,r.estimatedDays,r.enabled,id,this.tenant]);
        await db.query(`UPDATE freight_admin.containers SET version=version+1,updated_at=now() WHERE route_id=$1 AND tenant=$2`,[id,this.tenant]);
      }else{
        const old=before as Warehouse,w=next as Warehouse;
        if(w.code!==old.code&&(await db.query(`SELECT id FROM freight_admin.warehouses WHERE tenant=$1 AND upper(code)=upper($2) AND id<>$3 AND deleted_at IS NULL`,[this.tenant,w.code,id])).rows.length)throw new ApiError(409,'仓库代码已存在');
        const updates:Row={};if(w.code!==old.code)updates.warehouse_code=w.code;if(w.name!==old.name)updates.warehouse_name=w.name;
        if(Object.keys(updates).length){this.requireReason(body);const rows=await db.query(`SELECT to_jsonb(d) value FROM freight.deliveries d JOIN freight_admin.deliveries a ON a.delivery_id=d.id WHERE a.warehouse_id=$1 AND a.tenant=$2 FOR UPDATE OF d`,[id,this.tenant]);
          for(const {value}of rows.rows){const raw=asRecord(value);await this.applySource(db,op,'deliveries',raw,updates,text(raw.shipment_id),text(raw.id));}}
        await db.query(`UPDATE freight_admin.warehouses SET code=$1,name=$2,region=$3,address=$4,enabled=$5,version=version+1,updated_at=now() WHERE id=$6 AND tenant=$7`,[w.code,w.name,w.region,w.address,w.enabled,id,this.tenant]);
        await db.query(`UPDATE freight_admin.containers SET version=version+1,updated_at=now() WHERE tenant=$1 AND shipment_id IN(SELECT shipment_id FROM freight_admin.deliveries WHERE warehouse_id=$2 AND tenant=$1)`,[this.tenant,id]);
      }
      const after=await this.get(db,kind,id);await this.audit(db,kind,before,after,'update',op);return after;
    });
  }
  async publish(kind:EntityKind,id:string,published:boolean,version:number,actor?:string):Promise<RecordValue>{
    const op=this.operation(null,actor,published?'开启前台展示':'关闭前台展示');
    return this.transaction(async db=>{
      await this.lock(db,kind,id,version);const before=await this.get(db,kind,id);if(before.published===published)return before;
      if(kind==='containers'){
        const raw=await this.rawSource(db,'shipments',id);const updates:Row={is_published:published};if(published){updates.published_by=op.actor;updates.published_at=dateNow();}
        await this.writeSource(db,'shipments',id,updates);
        await db.query(`INSERT INTO freight.audit_logs(shipment_id,entity_type,entity_id,action,actor_type,actor_id,changes,reason) VALUES($1,'shipments',$1,$2,'user',$3,$4::jsonb,$5)`,[id,published?'publish':'unpublish',op.actor,JSON.stringify(this.differences(raw,updates)),op.reason]);
      }else{
        await db.query(`UPDATE freight_admin.${kind} SET published=$1,version=version+1,updated_at=now() WHERE id=$2 AND tenant=$3`,[published,id,this.tenant]);
        if(kind==='routes')await db.query('UPDATE freight_admin.containers SET version=version+1,updated_at=now() WHERE route_id=$1 AND tenant=$2',[id,this.tenant]);
        else await db.query(`UPDATE freight_admin.containers SET version=version+1,updated_at=now() WHERE tenant=$1 AND shipment_id IN(SELECT shipment_id FROM freight_admin.deliveries WHERE warehouse_id=$2 AND tenant=$1)`,[this.tenant,id]);
      }
      const after=await this.get(db,kind,id);await this.audit(db,kind,before,after,published?'publish':'unpublish',op);return after;
    });
  }
  async delete(kind:EntityKind,id:string,version:number,actor?:string):Promise<{deleted:boolean}>{
    const op=this.operation(null,actor,'管理员确认归档记录，保留来源历史');
    return this.transaction(async db=>{
      await this.lock(db,kind,id,version);const before=await this.get(db,kind,id);
      if(kind==='containers'){
        const raw=await this.rawSource(db,'shipments',id);await this.applySource(db,op,'shipments',raw,{record_status:'cancelled',is_published:false},id);
        await db.query('UPDATE freight_admin.containers SET deleted_at=now(),version=version+1,updated_at=now() WHERE shipment_id=$1 AND tenant=$2',[id,this.tenant]);
      }else{
        const rows=kind==='routes'?await db.query('SELECT shipment_id FROM freight_admin.containers WHERE route_id=$1 AND tenant=$2 LIMIT 1',[id,this.tenant]):await db.query('SELECT delivery_id FROM freight_admin.deliveries WHERE warehouse_id=$1 AND tenant=$2 LIMIT 1',[id,this.tenant]);
        if(rows.rows.length)throw new ApiError(409,kind==='routes'?'该航线已被运输记录引用，请关闭启用状态':'该仓库已有送仓记录引用，请关闭启用状态');
        await db.query(`UPDATE freight_admin.${kind} SET deleted_at=now(),enabled=false,published=false,version=version+1,updated_at=now() WHERE id=$1 AND tenant=$2`,[id,this.tenant]);
      }
      await this.audit(db,kind,before,null,'delete',op);return {deleted:true};
    });
  }
}
