import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Container, ShippingRoute, Snapshot } from '../shared/types.js';
import { buildApp } from './app.js';
import { parseInput } from './validation.js';

let app: FastifyInstance;
let directory: string;
let database: string;
let initial: Snapshot;
async function state(): Promise<Snapshot> { return (await app.inject({method:'GET',url:'/api/state'})).json(); }
async function update(kind: string,record: object & {id: string},changes: object) {
  return app.inject({method:'PUT',url:`/api/${kind}/${record.id}`,payload:{...record,...changes}});
}
async function publish(kind: string,record: {id:string;version:number},published: boolean) {
  return app.inject({method:'PATCH',url:`/api/${kind}/${record.id}/publication`,payload:{version:record.version,published}});
}
beforeEach(async()=>{
  directory=mkdtempSync(join(tmpdir(),'freight-admin-api-'));
  database=join(directory,'admin.sqlite');
  app=await buildApp({dbPath:database});
  initial=await state();
});
afterEach(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});

describe('management API',()=>{
  it('provides explicitly synthetic, internally valid startup data',async()=>{
    expect(initial.source).toBe('demo');
    expect(initial.containers).toHaveLength(18);
    for(const kind of ['routes','warehouses','containers'] as const)
      for(const record of initial[kind]) expect(()=>parseInput(kind,record)).not.toThrow();
    expect((await app.inject({method:'GET',url:'/api/health'})).json()).toEqual({status:'ok',source:'demo',productionConnected:false});
  });
  it('creates unpublished records and batches even if a client requests publication',async()=>{
    const source=initial.containers[0]!;
    const result=await app.inject({method:'POST',url:'/api/containers',payload:{...source,referenceNo:'NEW-TRANSPORT-001',published:true,deliveries:source.deliveries.map(d=>({...d,published:true}))}});
    expect(result.statusCode).toBe(201);
    const record=result.json<Container>();
    expect(record.id).not.toBe(source.id);
    expect(record.published).toBe(false);
    expect(record.deliveries.every(d=>!d.published)).toBe(true);
    expect(record.version).toBe(1);
    const snapshot=await state();
    expect(snapshot.audit[0]).toMatchObject({action:'create',entityId:record.id,before:null,after:{published:false}});
  });
  it('treats container numbers as reusable but reference numbers as unique per transport',async()=>{
    const source=initial.containers[0]!;
    const reused=await app.inject({method:'POST',url:'/api/containers',payload:{...source,referenceNo:'REUSE-001'}});
    expect(reused.statusCode).toBe(201);
    expect(reused.json().containerNo).toBe(source.containerNo);
    const duplicate=await app.inject({method:'POST',url:'/api/containers',payload:{...source,referenceNo:'reuse-001'}});
    expect(duplicate.statusCode).toBe(409);
    expect((await state()).containers).toHaveLength(19);
  });
  it('separates editing from explicit parent publication and records the complete audit',async()=>{
    const source=initial.containers.find(c=>!c.published)!;
    const edited=await update('containers',source,{notes:'运单已复核',published:true});
    expect(edited.statusCode).toBe(200);
    expect(edited.json().published).toBe(false);
    const publication=await publish('containers',edited.json(),true);
    expect(publication.statusCode).toBe(200);
    expect(publication.json()).toMatchObject({published:true,version:source.version+2});
    const audit=(await state()).audit[0]!;
    expect(audit).toMatchObject({action:'publish',actor:'本地管理员',before:{published:false},after:{published:true,notes:'运单已复核'}});
    expect(audit.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it('prevents stale edits, deletes, and publications without changing data or audit',async()=>{
    const source=initial.containers[0]!;
    const first=await update('containers',source,{notes:'先保存的版本'});
    expect(first.statusCode).toBe(200);
    const auditCount=(await state()).audit.length;
    const staleEdit=await update('containers',source,{notes:'过期版本'});
    const stalePublication=await publish('containers',source,true);
    const staleDelete=await app.inject({method:'DELETE',url:`/api/containers/${source.id}`,payload:{version:source.version}});
    expect([staleEdit.statusCode,stalePublication.statusCode,staleDelete.statusCode]).toEqual([409,409,409]);
    const current=await state();
    expect(current.audit).toHaveLength(auditCount);
    expect(current.containers.find(c=>c.id===source.id)?.notes).toBe('先保存的版本');
  });
  it('rejects invalid, reversed, and invented calendar dates without partial writes',async()=>{
    const source=initial.containers.find(c=>c.devannedAt)!;
    const auditCount=initial.audit.length;
    for(const change of [{arrivedAt:'2026-02-30'},{devannedAt:'2026-01-01'},{etd:'2026-11-10',eta:'2026-11-01'},
      {deliveries:[{...source.deliveries[0]!,deliveredAt:'2026-01-01'}]}]) {
      const response=await update('containers',source,change);
      expect(response.statusCode).toBe(400);
    }
    expect((await state()).audit).toHaveLength(auditCount);
  });
  it('allows missing actual nodes without substituting estimates',async()=>{
    const source=initial.containers[0]!;
    const result=await update('containers',source,{departedAt:null,arrivedAt:null,eta:'2026-11-25'});
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({departedAt:null,arrivedAt:null,eta:'2026-11-25'});
  });
  it('preserves multiple inspections and rejects an end date before its start',async()=>{
    const source=initial.containers[0]!;
    const inspections=[
      {id:'inspection-a',type:'X 光查验',startedAt:'2026-11-01',endedAt:'2026-11-02',notes:'第一次已完成'},
      {id:'inspection-b',type:'人工查验',startedAt:'2026-11-03',endedAt:null,notes:'等待放行'},
    ];
    const response=await update('containers',source,{inspectionDisposition:'recorded',inspections});
    expect(response.statusCode).toBe(200);
    expect(response.json().inspections).toEqual(inspections);
    const invalid=await update('containers',response.json(),{inspections:[{...inspections[0],endedAt:'2026-10-31'}]});
    expect(invalid.statusCode).toBe(400);
    const inconsistent=await update('containers',response.json(),{inspectionDisposition:'clear'});
    expect(inconsistent.statusCode).toBe(400);
  });
  it('supports multiple batches to one warehouse and requires a second explicit save to publish a new batch',async()=>{
    const source=initial.containers[0]!;
    const existing=source.deliveries[0]!;
    const next={...existing,id:'new-batch',batchNo:'SECOND-BATCH',published:true};
    const response=await update('containers',source,{deliveries:[{...existing,published:true},next]});
    expect(response.statusCode).toBe(200);
    expect(response.json().deliveries.map((d:{published:boolean})=>d.published)).toEqual([true,false]);
    const saved=response.json<Container>();
    const second=await update('containers',saved,{deliveries:saved.deliveries.map(d=>({...d,published:true}))});
    expect(second.statusCode).toBe(200);
    expect(second.json().deliveries.every((d:{published:boolean})=>d.published)).toBe(true);
    const duplicate=await update('containers',second.json(),{deliveries:[existing,{...next,batchNo:existing.batchNo}]});
    expect(duplicate.statusCode).toBe(400);
  });
  it('prevents dangling references and protects dictionaries already in use',async()=>{
    const source=initial.containers[0]!;
    expect((await update('containers',source,{routeId:'missing'})).statusCode).toBe(400);
    expect((await update('containers',source,{deliveries:[{...source.deliveries[0]!,warehouseId:'missing'}]})).statusCode).toBe(400);
    const route=initial.routes.find(r=>r.id===source.routeId)!;
    const warehouse=initial.warehouses.find(w=>w.id===source.deliveries[0]!.warehouseId)!;
    expect((await app.inject({method:'DELETE',url:`/api/routes/${route.id}`,payload:{version:route.version}})).statusCode).toBe(409);
    expect((await app.inject({method:'DELETE',url:`/api/warehouses/${warehouse.id}`,payload:{version:warehouse.version}})).statusCode).toBe(409);
    expect((await state()).audit).toHaveLength(initial.audit.length);
  });
  it('applies container, route, warehouse, batch, and enabled publication gates together',async()=>{
    const source=initial.containers.find(c=>c.published && c.deliveries.some(d=>d.published) && c.routeId==='route-2')!;
    const preview=()=>app.inject({method:'GET',url:'/api/public-preview'});
    expect((await preview()).json().containers.some((c:{id:string})=>c.id===source.id)).toBe(true);
    const route=initial.routes.find(r=>r.id===source.routeId)!;
    const hidden=await update('routes',route,{enabled:false});
    expect(hidden.statusCode).toBe(200);
    expect((await preview()).json().containers.some((c:{id:string})=>c.id===source.id)).toBe(false);
    await update('routes',hidden.json(),{enabled:true});
    const warehouse=initial.warehouses.find(w=>w.id===source.deliveries[0]!.warehouseId)!;
    const hiddenWarehouse=await publish('warehouses',warehouse,false);
    expect(hiddenWarehouse.statusCode).toBe(200);
    const publicContainer=(await preview()).json().containers.find((c:{id:string})=>c.id===source.id);
    expect(publicContainer.deliveries.some((d:{warehouseId:string})=>d.warehouseId===warehouse.id)).toBe(false);
    await publish('containers',source,false);
    expect((await preview()).json().containers.some((c:{id:string})=>c.id===source.id)).toBe(false);
  });
  it('never exposes notes, actors, reference numbers, owners, or audit in public projection',async()=>{
    const source=initial.containers.find(c=>c.published && c.routeId!=='route-5')!;
    await update('containers',source,{owner:'SECRET-OWNER',notes:'SECRET-NOTE',referenceNo:'SECRET-REFERENCE',
      deliveries:source.deliveries.map(d=>({...d,notes:'SECRET-BATCH-NOTE'}))});
    const response=await app.inject({method:'GET',url:'/api/public-preview'});
    expect(response.body).not.toContain('SECRET-');
    expect(response.body).not.toContain('audit');
    expect(response.body).not.toContain('本地管理员');
    expect(response.json().source).toBe('demo');
  });
  it('deletes a container while retaining its audit trail',async()=>{
    const source=initial.containers[0]!;
    const deleted=await app.inject({method:'DELETE',url:`/api/containers/${source.id}`,payload:{version:source.version}});
    expect(deleted.statusCode).toBe(200);
    const snapshot=await state();
    expect(snapshot.containers.some(c=>c.id===source.id)).toBe(false);
    expect(snapshot.audit[0]).toMatchObject({action:'delete',entityId:source.id,before:{containerNo:source.containerNo},after:null});
  });
  it('persists edits and audit after a process restart',async()=>{
    const source=initial.containers[0]!;
    await update('containers',source,{notes:'重启后仍然存在'});
    const beforeRestart=await state();
    await app.close();
    app=await buildApp({dbPath:database});
    expect(await state()).toEqual(beforeRestart);
  });
  it('does not reseed an intentionally emptied database on restart',async()=>{
    await app.close();
    const emptyDb=join(directory,'empty.sqlite');
    app=await buildApp({dbPath:emptyDb,seed:false});
    const created=await app.inject({method:'POST',url:'/api/routes',payload:initial.routes[0]});
    const route=created.json<ShippingRoute>();
    await app.inject({method:'DELETE',url:`/api/routes/${route.id}`,payload:{version:route.version}});
    await app.close();
    app=await buildApp({dbPath:emptyDb});
    expect((await state()).routes).toHaveLength(0);
    expect((await state()).containers).toHaveLength(0);
    expect((await state()).audit).toHaveLength(2);
  });
  it('enforces nonnegative quantities and normalized unique warehouse codes',async()=>{
    const source=initial.containers[0]!;
    const bad=await update('containers',source,{deliveries:[{...source.deliveries[0]!,pieces:-1}]});
    expect(bad.statusCode).toBe(400);
    const duplicate=await app.inject({method:'POST',url:'/api/warehouses',payload:{...initial.warehouses[0],code:'ont8'}});
    expect(duplicate.statusCode).toBe(409);
  });
  it('blocks remote origins and hosts while accepting the local frontend',async()=>{
    const source=initial.containers[0]!;
    for(const origin of ['https://attacker.example','http://localhost:9999','null']) {
      const response=await app.inject({method:'PATCH',url:`/api/containers/${source.id}/publication`,headers:{origin},payload:{version:source.version,published:true}});
      expect(response.statusCode).toBe(403);
    }
    expect((await app.inject({method:'GET',url:'/api/state',headers:{host:'attacker.example'}})).statusCode).toBe(403);
    const local=await app.inject({method:'PUT',url:`/api/containers/${source.id}`,headers:{origin:'http://127.0.0.1:4180'},payload:{...source,notes:'local'}});
    expect(local.statusCode).toBe(200);
  });
  it('returns bounded errors for malformed or unknown requests',async()=>{
    const unknown=await app.inject({method:'POST',url:'/api/secrets',payload:{}});
    expect(unknown.statusCode).toBe(404);
    const malformed=await app.inject({method:'POST',url:'/api/containers',headers:{'content-type':'application/json'},payload:'{' });
    expect(malformed.statusCode).toBe(400);
    expect(Object.keys(malformed.json())).toEqual(['message']);
  });
});
