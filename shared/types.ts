export type EntityKind = 'containers' | 'routes' | 'warehouses';
export interface BaseRecord { id: string; version: number; createdAt: string; updatedAt: string }
export interface ShippingRoute extends BaseRecord {
  name: string; channel: string; carrier: string; origin: string; destination: string;
  estimatedDays: number | null; enabled: boolean; published: boolean;
}
export interface Warehouse extends BaseRecord {
  code: string; name: string; region: string; address: string; enabled: boolean; published: boolean;
}
export interface Inspection {
  id: string; type: string; startedAt: string | null; endedAt: string | null; notes: string; status?: 'unknown' | 'open' | 'resolved';
}
export interface PublicContainerTiming {
  departedAt: string | null; arrivedAt: string | null; dischargedAt: string | null;
  availableAt: string | null; pickedUpAt: string | null; devannedAt: string | null; totalDays: number | null;
}
export interface Delivery {
  id: string; warehouseId: string; batchNo: string; pieces: number | null; cbm: number | null;
  plannedAt: string | null; deliveredAt: string | null; published: boolean; notes: string; recordStatus?: string; isValidData?: boolean; eligibleForPublic?: boolean; publicTiming?: { totalDays: number | null; tailDays: number | null };
}
export interface Container extends BaseRecord {
  containerNo: string; referenceNo: string; routeId: string; vessel: string; voyage: string;
  containerType: string; owner: string; notes: string;
  etd: string | null; eta: string | null;
  loadedAt: string | null; departedAt: string | null; arrivedAt: string | null;
  dischargedAt: string | null; availableAt: string | null; pickedUpAt: string | null; devannedAt: string | null;
  inspectionDisposition: 'unknown' | 'clear' | 'recorded'; inspections: Inspection[];
  deliveries: Delivery[]; manifestComplete: boolean; published: boolean;
  transportMode?: string; recordStatus?: string; isValidData?: boolean; eligibleForPublic?: boolean; sourceReferenceNo?: string; publicTiming?: PublicContainerTiming;
}
export interface AuditEntry {
  id: string; entity: EntityKind; entityId: string; label: string;
  action: 'create' | 'update' | 'delete' | 'publish' | 'unpublish';
  actor: string; at: string; before: unknown; after: unknown;
}
export interface Snapshot { containers: Container[]; routes: ShippingRoute[]; warehouses: Warehouse[]; audit: AuditEntry[]; source: 'demo' | 'postgres' }
export interface EntityMap { containers: Container; routes: ShippingRoute; warehouses: Warehouse }
export type RecordInput<T extends BaseRecord> = Omit<T, keyof BaseRecord>;
export const lifecycleNodes = [
  ['loadedAt','装柜'],['departedAt','开船'],['arrivedAt','到港'],['dischargedAt','卸船'],
  ['availableAt','可提柜'],['pickedUpAt','提柜'],['devannedAt','拆柜'],
] as const;
export function containerStage(c: Container): string {
  if(c.recordStatus==='cancelled') return '已取消';
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
  if(c.inspections.some(i=>i.status==='open' || (!i.status && i.startedAt && !i.endedAt))) return '查验中';
  if(c.inspections.length && c.inspections.every(i=>i.status==='resolved'||i.endedAt)) return '已放行';
  if(c.inspections.length || c.inspectionDisposition==='recorded') return '曾查验';
  return c.inspectionDisposition==='clear' ? '无查验' : '待确认';
}
export function containerVisible(c: Container, routes: ShippingRoute[]) {
  return c.published && c.recordStatus!=='cancelled' && (c.transportMode===undefined || c.transportMode==='sea') && c.eligibleForPublic!==false && c.isValidData!==false && routes.some(r=>r.id===c.routeId && r.enabled && r.published);
}
export function deliveryVisible(c: Container,d: Delivery,routes: ShippingRoute[],warehouses: Warehouse[]) {
  return containerVisible(c,routes) && d.published && d.recordStatus!=='cancelled' && d.eligibleForPublic!==false && d.isValidData!==false && warehouses.some(w=>w.id===d.warehouseId && w.enabled && w.published);
}
export function daysBetween(start: string | null,end: string | null): number | null {
  if(!start || !end) return null;
  const n = (Date.parse(end)-Date.parse(start))/86400000;
  return Number.isFinite(n) && n>=0 ? Math.round(n) : null;
}
