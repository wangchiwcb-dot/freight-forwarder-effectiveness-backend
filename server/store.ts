import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEntry, BaseRecord, Container, EntityKind, EntityMap, ShippingRoute, Snapshot, Warehouse } from '../shared/types.js';
import { containerVisible, deliveryVisible } from '../shared/types.js';
import { forceNewBatchesUnpublished, parseInput } from './validation.js';
import { seedAudit, seedContainers, seedRoutes, seedWarehouses } from './seed.js';

type EntityRecord = EntityMap[EntityKind];
export class ApiError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export class Store {
  readonly db: DatabaseSync;
  constructor(dbPath: string, seed = true) {
    if(dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)),{recursive:true});
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, value TEXT NOT NULL);`);
    if(!this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get()) {
      this.transaction(()=>{
        if(seed) {
          const insert = this.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?)');
          for(const [kind, records] of [['routes',seedRoutes],['warehouses',seedWarehouses],['containers',seedContainers]] as const)
            for(const record of records) insert.run(kind,record.id,JSON.stringify(record));
          for(const entry of [...seedAudit].reverse()) this.db.prepare('INSERT INTO audit(id,value) VALUES(?,?)').run(entry.id,JSON.stringify(entry));
        }
        this.db.prepare("INSERT INTO metadata(key,value) VALUES('initialized','1')").run();
      });
    }
  }
  transaction<T>(fn:()=>T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); this.db.exec('COMMIT'); return result; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
  list<K extends EntityKind>(kind: K): EntityMap[K][] {
    return this.db.prepare("SELECT value FROM records WHERE kind=? ORDER BY json_extract(value,'$.updatedAt') DESC, rowid ASC").all(kind)
      .map(row=>JSON.parse(row.value as string) as EntityMap[K]);
  }
  get<K extends EntityKind>(kind: K,id: string): EntityMap[K] {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind,id);
    if(!row) throw new ApiError(404,'该记录不存在，可能已被删除');
    return JSON.parse(row.value as string) as EntityMap[K];
  }
  snapshot(): Snapshot {
    return {source:'demo',containers:this.list('containers'),routes:this.list('routes'),warehouses:this.list('warehouses'),
      audit:this.db.prepare('SELECT value FROM audit ORDER BY sequence DESC').all().map(row=>JSON.parse(row.value as string) as AuditEntry)};
  }
  label(kind: EntityKind, record: EntityRecord): string {
    return kind==='containers' ? (record as Container).containerNo : kind==='routes' ? (record as ShippingRoute).name : (record as Warehouse).code;
  }
  audit(kind: EntityKind, action: AuditEntry['action'], before: EntityRecord | null, after: EntityRecord | null) {
    const record = after ?? before!;
    const entry: AuditEntry = {id:randomUUID(),entity:kind,entityId:record.id,label:this.label(kind,record),action,
      actor:'本地管理员',at:new Date().toISOString(),before,after};
    this.db.prepare('INSERT INTO audit(id,value) VALUES(?,?)').run(entry.id,JSON.stringify(entry));
  }
  verifyVersion(record: BaseRecord,version: number) {
    if(record.version!==version) throw new ApiError(409,'记录已被其他操作更新，请刷新后重试');
  }
  validateReferences(kind: EntityKind,record: EntityRecord) {
    if(kind==='containers') {
      const c=record as Container;
      if(!this.list('routes').some(r=>r.id===c.routeId)) throw new ApiError(400,'所选航线不存在');
      const warehouses=new Set(this.list('warehouses').map(w=>w.id));
      if(c.deliveries.some(d=>!warehouses.has(d.warehouseId))) throw new ApiError(400,'送仓批次中包含不存在的仓库');
      if(this.list('containers').some(other=>other.id!==c.id && other.referenceNo.toUpperCase()===c.referenceNo.toUpperCase()))
        throw new ApiError(409,'提单 / 参考号已存在，请使用本次运输的唯一编号');
    } else if(kind==='warehouses') {
      const w=record as Warehouse;
      if(this.list('warehouses').some(other=>other.id!==w.id && other.code.toUpperCase()===w.code.toUpperCase()))
        throw new ApiError(409,'仓库代码已存在');
    }
  }
  create(kind: EntityKind,body: unknown) {
    const parsed=parseInput(kind,body);
    return this.transaction(()=>{
      const now=new Date().toISOString();
      const record={...parsed,id:randomUUID(),version:1,createdAt:now,updatedAt:now,published:false} as EntityRecord;
      if(kind==='containers') forceNewBatchesUnpublished(record as Container);
      this.validateReferences(kind,record);
      this.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?)').run(kind,record.id,JSON.stringify(record));
      this.audit(kind,'create',null,record);
      return record;
    });
  }
  update(kind: EntityKind,id: string,body: unknown,version: number) {
    const parsed=parseInput(kind,body);
    return this.transaction(()=>{
      const before=this.get(kind,id); this.verifyVersion(before,version);
      const after={...parsed,id,version:before.version+1,createdAt:before.createdAt,updatedAt:new Date().toISOString(),published:before.published} as EntityRecord;
      if(kind==='containers') forceNewBatchesUnpublished(after as Container,before as Container);
      this.validateReferences(kind,after);
      this.db.prepare('UPDATE records SET value=? WHERE kind=? AND id=?').run(JSON.stringify(after),kind,id);
      this.audit(kind,'update',before,after); return after;
    });
  }
  publish(kind: EntityKind,id: string,published: boolean,version: number) {
    return this.transaction(()=>{
      const before=this.get(kind,id); this.verifyVersion(before,version);
      if(before.published===published) return before;
      const after={...before,published,version:before.version+1,updatedAt:new Date().toISOString()};
      this.db.prepare('UPDATE records SET value=? WHERE kind=? AND id=?').run(JSON.stringify(after),kind,id);
      this.audit(kind,published?'publish':'unpublish',before,after); return after;
    });
  }
  delete(kind: EntityKind,id: string,version: number) {
    return this.transaction(()=>{
      const before=this.get(kind,id); this.verifyVersion(before,version);
      const containers=this.list('containers');
      if(kind==='routes' && containers.some(c=>c.routeId===id)) throw new ApiError(409,'该航线已被柜子引用，不能删除；可关闭启用状态');
      if(kind==='warehouses' && containers.some(c=>c.deliveries.some(d=>d.warehouseId===id))) throw new ApiError(409,'该仓库已有送仓批次引用，不能删除；可关闭启用状态');
      this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);
      this.audit(kind,'delete',before,null); return {deleted:true};
    });
  }
  publicPreview() {
    const routes=this.list('routes'), warehouses=this.list('warehouses');
    return {source:'demo',
      routes:routes.filter(r=>r.enabled && r.published).map(({id,name,channel,carrier,origin,destination,estimatedDays})=>({id,name,channel,carrier,origin,destination,estimatedDays})),
      warehouses:warehouses.filter(w=>w.enabled && w.published).map(({id,code,name,region})=>({id,code,name,region})),
      containers:this.list('containers').filter(c=>containerVisible(c,routes)).map(c=>({
        id:c.id,containerNo:c.containerNo,routeId:c.routeId,vessel:c.vessel,voyage:c.voyage,
        departedAt:c.departedAt,arrivedAt:c.arrivedAt,dischargedAt:c.dischargedAt,availableAt:c.availableAt,pickedUpAt:c.pickedUpAt,devannedAt:c.devannedAt,
        inspections:c.inspections.map(({id,type,startedAt,endedAt})=>({id,type,startedAt,endedAt})),
        deliveries:c.deliveries.filter(d=>deliveryVisible(c,d,routes,warehouses)).map(({id,warehouseId,plannedAt,deliveredAt})=>({id,warehouseId,plannedAt,deliveredAt})),
      })),
    };
  }
}
