import { z } from 'zod';
import { lifecycleNodes, type Container, type EntityKind } from '../shared/types.js';

const text = (max = 160) => z.string().trim().max(max, `最多 ${max} 个字符`);
const required = (name: string, max = 160) => text(max).min(1, `请填写${name}`);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, '请输入有效日期');
const optionalDate = date.nullable().default(null);
const id = required('记录编号', 100);
const notes = text(2000).default('');
const publication = z.boolean().default(false);
const delivery = z.object({
  id, warehouseId: id, batchNo: required('批次号', 100), pieces: z.number().int().min(0).max(10000000),
  cbm: z.number().min(0).max(100000), plannedAt: optionalDate, deliveredAt: optionalDate,
  published: publication, notes,
});
const inspection = z.object({
  id, type: required('查验类型', 100), startedAt: date, endedAt: optionalDate, notes,
}).superRefine((value, ctx) => {
  if (value.endedAt && value.endedAt < value.startedAt)
    ctx.addIssue({code: 'custom', message: '查验结束日期不能早于开始日期', path: ['endedAt']});
});
const container = z.object({
  containerNo: required('柜号', 50).transform(s=>s.toUpperCase()),
  referenceNo: required('提单 / 参考号', 100), routeId: id,
  vessel: text(100).default(''), voyage: text(80).default(''), containerType: required('柜型', 30),
  owner: text(100).default(''), notes, etd: optionalDate, eta: optionalDate,
  loadedAt: optionalDate, departedAt: optionalDate, arrivedAt: optionalDate,
  dischargedAt: optionalDate, availableAt: optionalDate, pickedUpAt: optionalDate, devannedAt: optionalDate,
  inspectionDisposition: z.enum(['unknown', 'clear', 'recorded']).default('unknown'),
  inspections: z.array(inspection).max(50).default([]), deliveries: z.array(delivery).max(200).default([]),
  manifestComplete: z.boolean().default(false), published: publication,
}).superRefine((value, ctx) => {
  let previous: {label: string; date: string} | undefined;
  for (const [key, label] of lifecycleNodes) {
    const current = value[key];
    if (!current) continue;
    if (previous && current < previous.date)
      ctx.addIssue({code:'custom', message:`${label}日期不能早于${previous.label}日期`, path:[key]});
    previous = {label, date: current};
  }
  if (value.etd && value.eta && value.eta < value.etd)
    ctx.addIssue({code:'custom',message:'预计到港日期不能早于预计开船日期',path:['eta']});
  if (value.inspectionDisposition === 'recorded' && !value.inspections.length)
    ctx.addIssue({code:'custom',message:'请选择至少一条查验记录，或将查验状态设为待确认 / 无查验',path:['inspections']});
  if (value.inspectionDisposition !== 'recorded' && value.inspections.length)
    ctx.addIssue({code:'custom',message:'存在查验记录时，查验状态应为有查验记录',path:['inspectionDisposition']});
  const inspectionIds = new Set<string>();
  value.inspections.forEach((item,index)=>{
    if(inspectionIds.has(item.id)) ctx.addIssue({code:'custom',message:'查验记录编号重复',path:['inspections',index,'id']});
    inspectionIds.add(item.id);
  });
  const deliveryIds = new Set<string>();
  const batches = new Set<string>();
  value.deliveries.forEach((item,index)=>{
    if(deliveryIds.has(item.id)) ctx.addIssue({code:'custom',message:'送仓记录编号重复',path:['deliveries',index,'id']});
    if(batches.has(item.batchNo.toUpperCase())) ctx.addIssue({code:'custom',message:'同柜批次号不能重复',path:['deliveries',index,'batchNo']});
    deliveryIds.add(item.id); batches.add(item.batchNo.toUpperCase());
    const lastKnown = value.devannedAt ?? value.pickedUpAt ?? value.availableAt ?? value.dischargedAt ?? value.arrivedAt ?? value.departedAt ?? value.loadedAt;
    if(item.deliveredAt && lastKnown && item.deliveredAt < lastKnown)
      ctx.addIssue({code:'custom',message:'实际送仓日期不能早于已记录的柜子生命周期节点',path:['deliveries',index,'deliveredAt']});
  });
});
const route = z.object({
  name: required('航线名称', 100), channel: required('公司渠道', 100), carrier: required('船公司', 100),
  origin: required('起运港', 100), destination: required('目的港', 100),
  estimatedDays: z.number().int().min(1).max(365), enabled: z.boolean().default(true), published: publication,
});
const warehouse = z.object({
  code: required('仓库代码', 40).transform(s=>s.toUpperCase()), name: required('仓库名称', 160),
  region: required('区域', 100), address: text(500).default(''), enabled: z.boolean().default(true), published: publication,
});
export const schemas = {containers: container, routes: route, warehouses: warehouse};
export const versionSchema = z.object({version: z.number().int().positive('请刷新页面后再操作')});
export const publicationSchema = versionSchema.extend({published: z.boolean()});
export function parseInput(entity: EntityKind, body: unknown) {
  return schemas[entity].parse(body);
}
export function forceNewBatchesUnpublished(next: Container, previous?: Container) {
  const existing = new Set(previous?.deliveries.map(d=>d.id) ?? []);
  next.deliveries = next.deliveries.map(d=>({...d, published: existing.has(d.id) ? d.published : false}));
}
