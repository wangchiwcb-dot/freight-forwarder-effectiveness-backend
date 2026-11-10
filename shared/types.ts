export type EntityKind = 'containers' | 'routes' | 'warehouses';
export interface BaseRecord { id: string; version: number; createdAt: string; updatedAt: string }
export interface ShippingRoute extends BaseRecord {
  name: string; channel: string; carrier: string; origin: string; destination: string;
  estimatedDays: number; enabled: boolean; published: boolean;
}
export interface Warehouse extends BaseRecord {
  code: string; name: string; region: string; address: string; enabled: boolean; published: boolean;
}
export interface Inspection {
  id: string; type: string; startedAt: string; endedAt: string | null; notes: string;
}
export interface Delivery {
  id: string; warehouseId: string; batchNo: string; pieces: number; cbm: number;
  plannedAt: string | null; deliveredAt: string | null; published: boolean; notes: string;
}
export interface Container extends BaseRecord {
  containerNo: string; referenceNo: string; routeId: string; vessel: string; voyage: string;
  containerType: string; owner: string; notes: string;
  etd: string | null; eta: string | null;
  loadedAt: string | null; departedAt: string | null; arrivedAt: string | null;
  dischargedAt: string | null; availableAt: string | null; pickedUpAt: string | null; devannedAt: string | null;
  inspectionDisposition: 'unknown' | 'clear' | 'recorded'; inspections: Inspection[];
  deliveries: Delivery[]; manifestComplete: boolean; published: boolean;
}
export interface AuditEntry {
  id: string; entity: EntityKind; entityId: string; label: string;
  action: 'create' | 'update' | 'delete' | 'publish' | 'unpublish';
  actor: string; at: string; before: unknown; after: unknown;
}
export interface Snapshot { containers: Container[]; routes: ShippingRoute[]; warehouses: Warehouse[]; audit: AuditEntry[]; source: 'demo' }
export interface EntityMap { containers: Container; routes: ShippingRoute; warehouses: Warehouse }
export type RecordInput<T extends BaseRecord> = Omit<T, keyof BaseRecord>;
export const lifecycleNodes = [
  ['loadedAt','装柜'],['departedAt','开船'],['arrivedAt','到港'],['dischargedAt','卸船'],
  ['availableAt','可提柜'],['pickedUpAt','提柜'],['devannedAt','拆柜'],
] as const;
export function containerStage(c: Container): string {
  if(c.devannedAt) return '已拆柜';
  if(c.pickedUpAt) return '已提柜';
  if(c.availableAt) return '待提柜';
  if(c.dischargedAt) return '已卸船';
  if(c.arrivedAt) return '已到港';
  if(c.departedAt) return '海运中';
  if(c.loadedAt) return '已装柜';
  return '待装柜';
}
export function inspectionState(c: Container): string {
  if(c.inspections.some(i=>!i.endedAt)) return '查验中';
  if(c.inspections.length) return '已放行';
  return c.inspectionDisposition==='clear' ? '无查验' : '待确认';
}
export function containerVisible(c: Container, routes: ShippingRoute[]) {
  return c.published && routes.some(r=>r.id===c.routeId && r.enabled && r.published);
}
export function deliveryVisible(c: Container,d: Delivery,routes: ShippingRoute[],warehouses: Warehouse[]) {
  return containerVisible(c,routes) && d.published && warehouses.some(w=>w.id===d.warehouseId && w.enabled && w.published);
}
export function daysBetween(start: string | null,end: string | null): number | null {
  if(!start || !end) return null;
  const n = (Date.parse(end)-Date.parse(start))/86400000;
  return Number.isFinite(n) && n>=0 ? Math.round(n) : null;
}
