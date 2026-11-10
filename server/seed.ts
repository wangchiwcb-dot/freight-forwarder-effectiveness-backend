import type { Container, ShippingRoute, Warehouse, AuditEntry } from '../shared/types.js';
const createdAt = '2026-11-10T02:00:00.000Z';
const base = (id: string) => ({id, version: 1, createdAt, updatedAt: createdAt});
export const seedRoutes: ShippingRoute[] = [
  ['route-1','美森正班 CLX','美森正班','Matson 美森','宁波','长滩',12,true,true],
  ['route-2','美森加班 CLX+','美森加班','Matson 美森','上海','长滩',14,true,true],
  ['route-3','以星快船 ZEX','以星快船','ZIM 以星','盐田','洛杉矶',16,true,true],
  ['route-4','长荣 EMC','普船海卡','EVERGREEN 长荣','宁波','洛杉矶',19,true,true],
  ['route-5','COSCO AWE','美东海卡','COSCO 中远海运','盐田','纽约',30,true,false],
  ['route-6','ONE PS5','普船海卡','ONE 海洋网联','上海','奥克兰',22,false,false],
].map(([id,name,channel,carrier,origin,destination,estimatedDays,enabled,published]) => ({
  ...base(id as string),name:name as string,channel:channel as string,carrier:carrier as string,
  origin:origin as string,destination:destination as string,estimatedDays:estimatedDays as number,
  enabled:enabled as boolean,published:published as boolean,
}));
export const seedWarehouses: Warehouse[] = [
  ['warehouse-1','ONT8','Amazon ONT8','美西 · 加州','Moreno Valley, CA'],
  ['warehouse-2','LAX9','Amazon LAX9','美西 · 加州','Fontana, CA'],
  ['warehouse-3','LGB8','Amazon LGB8','美西 · 加州','Rialto, CA'],
  ['warehouse-4','SBD1','Amazon SBD1','美西 · 加州','Bloomington, CA'],
  ['warehouse-5','LAS1','Amazon LAS1','美西 · 内华达','Henderson, NV'],
  ['warehouse-6','GYR3','Amazon GYR3','美西 · 亚利桑那','Phoenix, AZ'],
  ['warehouse-7','ABE8','Amazon ABE8','美东 · 新泽西','Florence, NJ'],
  ['warehouse-8','TEB9','Amazon TEB9','美东 · 新泽西','Somerset, NJ'],
].map(([id,code,name,region,address],i) => ({...base(id!),code:code!,name:name!,region:region!,address:address!,enabled:true,published:i!==7}));
const day = (offset: number) => new Date(Date.UTC(2026, 10, 10 + offset)).toISOString().slice(0,10);
export const seedContainers: Container[] = Array.from({length:18},(_,i)=>{
  const routeId = `route-${i % 5 + 1}`;
  const completed = i >= 7;
  const departureOffset = completed ? -36 - (i%5) : [-8,-9,-17,-21,-35,-4,2][i]!;
  const transit = routeId === 'route-5' ? 30 : routeId === 'route-4' ? 19 : routeId === 'route-3' ? 16 : 12;
  const arrivedOffset = departureOffset + transit;
  const inspecting = i===2 || i===3;
  const examined = inspecting || i===9 || i===13;
  const departed = departureOffset<=0;
  const arrived = arrivedOffset<=0;
  const devanned = completed;
  const stage = i===4 ? 'picked' : '';
  const actualDevanned = day(Math.min(-1, arrivedOffset + 4));
  const deliveries = Array.from({length: i%3===0 ? 3 : 2},(_,j)=>{
    const warehouseIndex = routeId==='route-5' ? (j%2)+7 : (i+j)%6+1;
    const deliveredAt = completed && !(i===8 && j===1) ? day(Math.min(0,arrivedOffset+6+j)) : null;
    return {id:`delivery-${i+1}-${j+1}`,warehouseId:`warehouse-${warehouseIndex}`,batchNo:`ZH${String(i+1).padStart(3,'0')}-${String(j+1).padStart(2,'0')}`,
      pieces:120+(i*43+j*81)%700,cbm:Number((8.4+(i*1.7+j*2.1)%19).toFixed(1)),
      plannedAt:day(arrivedOffset+6+j),deliveredAt,published:i%4!==0,notes:''};
  });
  return {
    ...base(`container-${i+1}`),containerNo:['MSCU','MATU','ZIMU','EISU','COSU'][i%5]+String(4738210+i*137),
    referenceNo:`ZH2026${completed?'10':'11'}${String(i+1).padStart(4,'0')}`,
    routeId,vessel:['MANUKAI','MATSON LANAI','ZIM SHANGHAI','EVER FORTUNE','COSCO SHIPPING ROSE'][i%5]!,
    voyage:`${String(142+i).padStart(3,'0')}E`,containerType:i%5===0?'40GP':'40HQ',owner:['王晓','李明','陈静'][i%3]!,
    notes:i===2?'等待海关查验结果，放行后安排提柜。':i===8?'第二批货物已预约，待确认实际送仓日期。':'',
    etd:day(departureOffset),eta:day(arrivedOffset),loadedAt:day(departureOffset-3),
    departedAt:departed?day(departureOffset):null,arrivedAt:arrived?day(arrivedOffset):null,
    dischargedAt:arrived && arrivedOffset+1<=0?day(arrivedOffset+1):null,
    availableAt:(completed || stage==='picked')?day(arrivedOffset+2):null,
    pickedUpAt:(completed || stage==='picked')?day(arrivedOffset+3):null,
    devannedAt:devanned?actualDevanned:null,
    inspectionDisposition:examined?'recorded':i===0?'unknown':'clear',
    inspections:examined?[{id:`inspection-${i}`,type:i===3?'CET 查验':'海关查验',startedAt:day(arrivedOffset),endedAt:inspecting?null:day(arrivedOffset+2),notes:inspecting?'海关已受理，等待查验完成。':'查验完成，已放行。'}]:[],
    deliveries,manifestComplete:completed || i%3!==0,published:i%4!==0,
  };
});
export const seedAudit: AuditEntry[] = [
  {id:'audit-seed-1',entity:'containers',entityId:'container-3',label:seedContainers[2]!.containerNo,action:'update',actor:'本地管理员',at:'2026-11-10T02:20:00.000Z',before:null,after:{event:'更新查验记录（演示）'}},
  {id:'audit-seed-2',entity:'containers',entityId:'container-2',label:seedContainers[1]!.containerNo,action:'publish',actor:'本地管理员',at:'2026-11-10T02:00:00.000Z',before:{published:false},after:{published:true}},
  {id:'audit-seed-3',entity:'containers',entityId:'container-1',label:seedContainers[0]!.containerNo,action:'create',actor:'本地管理员',at:'2026-11-10T01:30:00.000Z',before:null,after:seedContainers[0]},
];
