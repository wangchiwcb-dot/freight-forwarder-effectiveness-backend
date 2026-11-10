import { useMemo, useState } from 'react';
import { Alert, App, Button, Descriptions, Drawer, Empty, Input, Pagination, Select, Space, Switch, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowRightOutlined, CheckCircleOutlined, EyeOutlined, FileSearchOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { AuditEntry, Container } from '../../shared/types';
import { containerStage, containerVisible, daysBetween, deliveryVisible } from '../../shared/types';
import { useAdmin } from '../store';

export function PublicationPage() {
  const { data, busy, setPublished } = useAdmin();
  const { modal } = App.useApp();
  const production=data.source==='postgres';
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);
  const visible = data.containers.filter(c => containerVisible(c, data.routes));
  const activePreviewPage = Math.min(previewPage, Math.max(1, Math.ceil(visible.length / 10)));
  const previewItems = visible.slice((activePreviewPage - 1) * 10, activePreviewPage * 10);
  const blocked = data.containers.filter(c => c.published && !containerVisible(c, data.routes));
  const deliveries = data.containers.flatMap(c => c.deliveries.filter(d => deliveryVisible(c, d, data.routes, data.warehouses)));
  const filtered = data.containers.filter(c => {
    const route = data.routes.find(r => r.id === c.routeId);
    const matches = [c.containerNo, c.referenceNo, route?.name, route?.channel].join(' ').toLowerCase().includes(search.trim().toLowerCase());
    return matches && (status === 'all' || (status === 'visible' ? containerVisible(c, data.routes) : status === 'blocked' ? c.published && !containerVisible(c, data.routes) : !c.published));
  });
  function reason(c: Container) {
    if (!c.published) return '柜子展示未开启';
    const route = data.routes.find(r => r.id === c.routeId);
    if (!route) return '未关联有效航线';
    if (!route.enabled) return '关联航线已停用';
    if (!route.published) return '航线展示未开启';
    if(c.recordStatus==='cancelled')return '已取消记录';
    if(c.transportMode&&c.transportMode!=='sea')return '非海运记录';
    if(c.isValidData===false||c.eligibleForPublic===false)return '待复核或缺少有效开船日期';
    return '柜子与航线均已开启';
  }
  function toggle(c: Container, published: boolean) {
    modal.confirm({ title: published ? '确认开启前台展示？' : '确认关闭前台展示？', content: published ? `开启 ${c.containerNo} 的展示开关。实际可见性还取决于航线开关，送仓批次还需关联仓库与批次同时开启。${production?'当前操作将影响线上展示。':'当前为本地演示环境。'}` : `关闭后，${c.containerNo} 及其送仓批次将不在前台预览中展示。所有记录仍会保留。`, okText: published ? '开启展示' : '关闭展示', cancelText: '取消', onOk: async () => { if (!await setPublished('containers', c, published)) throw new Error('操作失败'); } });
  }
  const columns: ColumnsType<Container> = [
    { title: '柜子 / 提单号', key: 'container', width: 210, render: (_, c) => <div><div className="table-primary mono">{c.containerNo}</div><div className="table-secondary mono">{c.referenceNo}</div></div> },
    { title: '关联航线', key: 'route', width: 200, render: (_, c) => { const route = data.routes.find(r => r.id === c.routeId); return <div><div>{route?.name ?? '—'}</div><div className="table-secondary">{route?.channel ?? '未关联渠道'}</div></div>; } },
    { title: '柜子状态', key: 'stage', width: 110, render: (_, c) => <Tag bordered={false} color={c.devannedAt ? 'green' : 'blue'}>{containerStage(c)}</Tag> },
    { title: '柜子展示开关', key: 'switch', width: 125, render: (_, c) => <Switch size="small" checked={c.published} disabled={busy} aria-label={`${c.containerNo}展示开关`} onChange={v => toggle(c, v)} /> },
    { title: '实际展示状态', key: 'effective', width: 190, render: (_, c) => <div><Tag bordered={false} color={containerVisible(c, data.routes) ? 'green' : c.published ? 'gold' : 'default'}>{containerVisible(c, data.routes) ? '展示中' : c.published ? '未满足展示条件' : '未展示'}</Tag><div className="table-secondary mt-1">{reason(c)}</div></div> },
    { title: '可展示送仓批次', key: 'batches', width: 160, render: (_, c) => { const count = c.deliveries.filter(d => deliveryVisible(c, d, data.routes, data.warehouses)).length; return <Tooltip title="送仓批次还需对应仓库启用且展示，以及批次展示开关开启"><span><strong className={count ? 'text-[#177b70]' : ''}>{count}</strong><span className="muted"> / {c.deliveries.length} 批</span></span></Tooltip>; } },
  ];
  return <>
    <div className="page-heading"><div><h1>前台展示管理</h1><p>发布前多一次确认，让客户只看到准备好的数据。</p></div><Button icon={<EyeOutlined />} onClick={() => { setPreviewPage(1); setPreviewOpen(true); }}>查看前台预览</Button></div>
    <div className="stat-grid mb-5 grid grid-cols-2 gap-4 xl:grid-cols-4">{[
      ['可展示柜子', visible.length, '柜子、航线开关均已生效', 'text-[#177b70]'],
      ['待开启展示', data.containers.filter(c => !c.published).length, '新记录默认保持关闭', 'text-[#213c42]'],
      ['未满足展示条件', blocked.length, '核对关联开关、运输状态与有效日期', 'text-[#c18a36]'],
      ['可展示送仓批次', deliveries.length, '仓库与批次开关同时生效', 'text-[#213c42]'],
    ].map(([label, value, description, color]) => <div className="stat-card rounded-xl border border-[#e1e8e8] bg-white p-5" key={label}><div className="muted text-xs">{label}</div><div className={`my-3 text-3xl font-semibold ${color}`}>{value}</div><div className="muted text-xs">{description}</div></div>)}</div>
    <Alert showIcon type="info" className="mb-5" message="展示采用关联开关共同控制" description={<span>柜子展示需要：柜子开启 + 航线启用并开启展示。送仓批次还需要：批次开启 + 仓库启用并开启展示。展示开启不代表数据已满足时效统计要求。</span>} />
    <section className="panel overflow-hidden"><div className="flex flex-wrap items-center gap-3 border-b border-[#edf1f1] p-5"><Input allowClear prefix={<SearchOutlined className="muted" />} aria-label="搜索展示记录" placeholder="搜索柜号、提单号或航线" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 290 }} /><Select aria-label="展示状态筛选" value={status} onChange={setStatus} options={[{ value: 'all', label: '全部展示状态' }, { value: 'visible', label: '展示中' }, { value: 'hidden', label: '未开启展示' }, { value: 'blocked', label: '未满足展示条件' }]} style={{ width: 180 }} /><Button onClick={() => { setSearch(''); setStatus('all'); }}>重置</Button><span className="muted ml-auto text-xs">共 {filtered.length} 条记录</span></div><Table rowKey="id" columns={columns} dataSource={filtered} pagination={{ pageSize: 8, showSizeChanger: false, showTotal: total => `共 ${total} 条` }} scroll={{ x: 1040 }} /></section>
    <Drawer title="前台数据预览" width={860} open={previewOpen} onClose={() => setPreviewOpen(false)} footer={<Pagination current={activePreviewPage} pageSize={10} total={visible.length} showSizeChanger={false} showTotal={total=>`共 ${total} 条运输记录`} onChange={setPreviewPage} size="small"/>}><Alert type="info" showIcon message={production?"线上展示范围预览":"本地演示预览"} description={production?"这里显示经过发布与数据有效性筛选的记录。图表另按对应指标的实际日期筛选样本，未完成记录不会计入已完成时效。":"这里呈现当前开关规则允许展示的运输信息，尚未同步到线上时效系统。"} className="mb-6" /><div className="mb-5 flex items-center justify-between"><strong className="text-base">可展示运输记录</strong><Tag color="green" bordered={false}>{visible.length} 柜 · {deliveries.length} 批送仓</Tag></div>{!visible.length ? <Empty description="暂无可展示记录，请先开启相关展示开关" /> : <Space direction="vertical" size={16} style={{ width: '100%' }}>{previewItems.map(c => { const route = data.routes.find(r => r.id === c.routeId); const batches = c.deliveries.filter(d => deliveryVisible(c, d, data.routes, data.warehouses)); const timing = c.publicTiming; const displayed = production ? {...c, loadedAt: null, departedAt: timing?.departedAt ?? null, arrivedAt: timing?.arrivedAt ?? null, dischargedAt: timing?.dischargedAt ?? null, availableAt: timing?.availableAt ?? null, pickedUpAt: timing?.pickedUpAt ?? null, devannedAt: timing?.devannedAt ?? null} : c; const duration = production ? timing?.totalDays ?? null : daysBetween(c.departedAt, c.devannedAt); return <section key={c.id} className="rounded-xl border border-[#e1e8e8] p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div><strong className="mono text-base">{c.containerNo}</strong><span className="muted ml-3">{route?.name}</span></div><Tag color="green" bordered={false} icon={<CheckCircleOutlined />}>{containerStage(displayed)}</Tag></div><div className="mb-4 flex items-center gap-2 text-sm"><span>{route?.origin}</span><ArrowRightOutlined className="muted" /><span>{route?.destination}</span><span className="muted ml-auto">{c.vessel} {c.voyage}</span></div><Descriptions size="small" column={3} items={[{ key: 'departure', label: '实际开船', children: displayed.departedAt ?? '待更新' }, { key: 'arrival', label: '实际到港', children: displayed.arrivedAt ?? '待更新' }, { key: 'devanning', label: '实际拆柜', children: displayed.devannedAt ?? '待更新' }, { key: 'duration', label: '柜子时效', children: duration === null ? '尚无完整时效' : `${duration} 天` }]} />{batches.length > 0 && <Table size="small" rowKey="id" pagination={false} className="mt-3" dataSource={batches} columns={[{ title: '亚马逊仓库', dataIndex: 'warehouseId', render: id => data.warehouses.find(w => w.id === id)?.code ?? '—' }, { title: '预计送仓', dataIndex: 'plannedAt', render: value => value ?? '待更新' }, { title: '实际送仓', dataIndex: 'deliveredAt', render: value => value ?? '待更新' }, { title: '送仓时效', key: 'deliveryDays', render: (_, d) => { const days = production ? d.publicTiming?.totalDays ?? null : daysBetween(c.departedAt, d.deliveredAt); const tail = production ? d.publicTiming?.tailDays ?? null : daysBetween(c.devannedAt,d.deliveredAt); return days === null ? tail === null ? '—' : <span>总时效未知<small className="table-secondary">拆柜后 {tail} 天</small></span> : `${days} 天`; } }]} />}</section>; })}</Space>}</Drawer>
  </>;
}

const actionLabels: Record<AuditEntry['action'], string> = { create: '新增记录', update: '修改记录', delete: '删除记录', publish: '开启展示', unpublish: '关闭展示' };
const entityLabels: Record<AuditEntry['entity'], string> = { containers: '柜子', routes: '航线', warehouses: '仓库' };
const fieldLabels: Record<string, string> = {
  id: '记录标识', version: '版本', createdAt: '创建时间', updatedAt: '更新时间', containerNo: '柜号', referenceNo: '提单号', routeId: '关联航线', vessel: '船名', voyage: '航次', containerType: '柜型', owner: '负责人', notes: '备注', etd: '预计开船', eta: '预计到港', loadedAt: '实际装柜', departedAt: '实际开船', arrivedAt: '实际到港', dischargedAt: '实际卸船', availableAt: '实际可提柜', pickedUpAt: '实际提柜', devannedAt: '实际拆柜', inspectionDisposition: '查验情况', inspections: '查验记录', deliveries: '送仓批次', manifestComplete: '送仓清单完整', published: '前台展示', name: '名称', channel: '公司渠道', carrier: '船公司', origin: '起运港', destination: '目的港', estimatedDays: '参考时效（天）', enabled: '启用状态', code: '仓库代码', region: '所属地区', address: '仓库地址', warehouseId: '关联仓库', batchNo: '批次号', pieces: '件数', cbm: '体积（m³）', plannedAt: '预计送仓', deliveredAt: '实际送仓', type: '查验类型', startedAt: '查验开始', endedAt: '查验结束',
};
const enumLabels: Record<string, string> = { unknown: '待确认', clear: '无查验', recorded: '已记录查验' };
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export function AuditPage() {
  const { data } = useAdmin();
  const [search, setSearch] = useState('');
  const [entity, setEntity] = useState('all');
  const [action, setAction] = useState('all');
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const filtered = useMemo(() => [...data.audit].sort((a, b) => b.at.localeCompare(a.at)).filter(item => (entity === 'all' || item.entity === entity) && (action === 'all' || item.action === action) && [item.label, item.actor, actionLabels[item.action]].join(' ').toLowerCase().includes(search.trim().toLowerCase())), [data.audit, search, entity, action]);
  function valueText(key: string, value: unknown): string {
    if (value === undefined || value === null || value === '') return '—';
    if (typeof value === 'boolean') return key === 'published' || key === 'enabled' ? (value ? '开启' : '关闭') : (value ? '是' : '否');
    if (key === 'routeId') return data.routes.find(r => r.id === value)?.name ?? String(value);
    if (key === 'warehouseId') return data.warehouses.find(w => w.id === value)?.code ?? String(value);
    if (key === 'inspectionDisposition') return enumLabels[String(value)] ?? String(value);
    if (Array.isArray(value)) return value.length ? value.map((item, index) => `${index + 1}. ${Object.entries(asObject(item)).filter(([k]) => k !== 'id').map(([k, v]) => `${fieldLabels[k] ?? k}：${valueText(k, v)}`).join('；')}`).join('\n\n') : '无记录';
    if (typeof value === 'object') return Object.entries(asObject(value)).map(([k, v]) => `${fieldLabels[k] ?? k}：${valueText(k, v)}`).join('；');
    return String(value);
  }
  const before = asObject(selected?.before);
  const after = asObject(selected?.after);
  const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !['id', 'version', 'createdAt', 'updatedAt'].includes(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(key => ({ key, label: fieldLabels[key] ?? key, before: valueText(key, before[key]), after: valueText(key, after[key]) }));
  const columns: ColumnsType<AuditEntry> = [
    { title: '操作时间', dataIndex: 'at', width: 185, render: value => <span className="mono text-xs">{dayjs(value).format('YYYY-MM-DD HH:mm:ss')}</span> },
    { title: '操作对象', key: 'object', width: 230, render: (_, record) => <div><div className="table-primary">{record.label}</div><div className="table-secondary">{entityLabels[record.entity]}</div></div> },
    { title: '操作类型', dataIndex: 'action', width: 130, render: (value: AuditEntry['action']) => <Tag bordered={false} color={value === 'delete' ? 'red' : value === 'publish' ? 'green' : value === 'unpublish' ? 'gold' : 'default'}>{actionLabels[value]}</Tag> },
    { title: '操作人', dataIndex: 'actor', width: 150 },
    { title: '变更详情', key: 'detail', width: 125, render: (_, record) => <Button type="link" size="small" icon={<FileSearchOutlined />} onClick={() => setSelected(record)}>查看变更</Button> },
  ];
  return <>
    <div className="page-heading"><div><h1>操作日志</h1><p>记录每一次新增、修改、删除与展示设置，保留可追溯的变更历史。</p></div><Tag bordered={false} color="default">只读日志</Tag></div>
    <section className="panel overflow-hidden"><div className="flex flex-wrap items-center gap-3 border-b border-[#edf1f1] p-5"><Input allowClear prefix={<SearchOutlined className="muted" />} aria-label="搜索操作日志" placeholder="搜索记录名称或操作人" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 270 }} /><Select aria-label="日志对象筛选" value={entity} onChange={setEntity} options={[{ value: 'all', label: '全部对象' }, ...Object.entries(entityLabels).map(([value, label]) => ({ value, label }))]} style={{ width: 135 }} /><Select aria-label="日志操作筛选" value={action} onChange={setAction} options={[{ value: 'all', label: '全部操作' }, ...Object.entries(actionLabels).map(([value, label]) => ({ value, label }))]} style={{ width: 145 }} /><Button onClick={() => { setSearch(''); setEntity('all'); setAction('all'); }}>重置</Button><span className="muted ml-auto text-xs">共 {filtered.length} 条日志</span></div><Table rowKey="id" columns={columns} dataSource={filtered} pagination={{ pageSize: 10, showSizeChanger: false, showTotal: total => `共 ${total} 条` }} scroll={{ x: 820 }} locale={{ emptyText: <Empty description="暂无操作日志，保存业务记录后将在这里留痕" /> }} /></section>
    <Drawer title="查看变更记录" open={!!selected} onClose={() => setSelected(null)} width={860}>{selected && <><Descriptions bordered size="small" column={2} className="mb-6" items={[{ key: 'object', label: '操作对象', children: selected.label }, { key: 'entity', label: '对象类型', children: entityLabels[selected.entity] }, { key: 'action', label: '操作类型', children: actionLabels[selected.action] }, { key: 'actor', label: '操作人', children: selected.actor }, { key: 'time', label: '操作时间', children: dayjs(selected.at).format('YYYY-MM-DD HH:mm:ss'), span: 2 }]} /><div className="mb-4 flex items-center justify-between"><strong>字段变更</strong><span className="muted text-xs">{changes.length} 项内容发生变化</span></div><Table rowKey="key" size="small" pagination={false} dataSource={changes} columns={[{ title: '字段', dataIndex: 'label', width: 130 }, { title: '修改前', dataIndex: 'before', width: 285, render: value => <div className="whitespace-pre-wrap break-words text-xs leading-6 text-[#819295]">{value}</div> }, { title: '修改后', dataIndex: 'after', width: 285, render: value => <div className="whitespace-pre-wrap break-words text-xs leading-6">{value}</div> }]} scroll={{ x: 700 }} /></>}</Drawer>
  </>;
}
