import { useMemo, useState } from 'react';
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Select, Space, Switch, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowRightOutlined, DeleteOutlined, EditOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { ShippingRoute, Warehouse } from '../../shared/types';
import { useAdmin } from '../store';

type Reference = ShippingRoute | Warehouse;
type ReferenceValues = {
  name: string; channel: string; carrier: string; origin: string; destination: string;
  estimatedDays: number; code: string; region: string; address: string; enabled: boolean;
};
const required = [{ required: true, whitespace: true, message: '请填写此项' }];

function inputOf(record: Reference) {
  if ('channel' in record) {
    const { name, channel, carrier, origin, destination, estimatedDays, enabled, published, version } = record;
    return { name, channel, carrier, origin, destination, estimatedDays, enabled, published, version };
  }
  const { code, name, region, address, enabled, published, version } = record;
  return { code, name, region, address, enabled, published, version };
}

export function References({ kind }: { kind: 'routes' | 'warehouses' }) {
  const { data, busy, save, remove, setPublished } = useAdmin();
  const { modal } = App.useApp();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [editing, setEditing] = useState<Reference | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<ReferenceValues>();
  const isRoute = kind === 'routes';
  const noun = isRoute ? '航线' : '仓库';
  const records: Reference[] = isRoute ? data.routes : data.warehouses;
  const filtered = useMemo(() => records.filter(record => {
    const words = 'channel' in record
      ? [record.name, record.channel, record.carrier, record.origin, record.destination]
      : [record.code, record.name, record.region, record.address];
    return words.join(' ').toLowerCase().includes(search.trim().toLowerCase())
      && (status === 'all' || (status === 'enabled' ? record.enabled : !record.enabled));
  }), [records, search, status]);
  const referenceCount = (record: Reference) => isRoute
    ? data.containers.filter(c => c.routeId === record.id).length
    : data.containers.reduce((sum, c) => sum + c.deliveries.filter(d => d.warehouseId === record.id).length, 0);

  function showEditor(record?: Reference) {
    setEditing(record ?? null);
    form.resetFields();
    form.setFieldsValue(record ?? { enabled: true, estimatedDays: 18, address: '' });
    setOpen(true);
  }
  function closeEditor() {
    if (!form.isFieldsTouched()) { setOpen(false); return; }
    modal.confirm({ title: '放弃未保存的更改？', content: '尚未保存的内容将不会保留。', okText: '放弃更改', cancelText: '继续编辑', onOk: () => setOpen(false) });
  }
  async function submit(values: ReferenceValues) {
    const input = isRoute
      ? { name: values.name.trim(), channel: values.channel.trim(), carrier: values.carrier.trim(), origin: values.origin.trim(), destination: values.destination.trim(), estimatedDays: values.estimatedDays, enabled: values.enabled, published: editing?.published ?? false }
      : { code: values.code.trim().toUpperCase(), name: values.name.trim(), region: values.region.trim(), address: values.address?.trim() ?? '', enabled: values.enabled, published: editing?.published ?? false };
    if (await save(kind, editing?.id ?? null, { ...input, ...(editing ? { version: editing.version } : {}) })) setOpen(false);
  }
  function toggleEnabled(record: Reference, enabled: boolean) {
    modal.confirm({
      title: enabled ? `启用这条${noun}？` : `停用这条${noun}？`,
      content: enabled ? `启用后可继续维护关联记录。只有同时开启相关展示开关，数据才会出现在预览中。` : `现有的 ${referenceCount(record)} ${isRoute ? '条柜子记录' : '个送仓批次'}会保留，相关数据将不在前台预览中展示。`,
      okText: enabled ? '确认启用' : '确认停用', cancelText: '取消',
      onOk: async () => { if (!await save(kind, record.id, { ...inputOf(record), enabled })) throw new Error('保存失败'); },
    });
  }
  function togglePublished(record: Reference, published: boolean) {
    modal.confirm({
      title: published ? `开启${noun}展示？` : `关闭${noun}展示？`,
      content: published ? `${noun}需要处于启用状态；关联柜子和送仓批次也须分别开启展示。此设置仅影响本地演示预览。` : `关联${isRoute ? '柜子及其送仓批次' : '送仓批次'}将从前台预览中隐藏，记录和历史数据仍会保留。`,
      okText: published ? '开启展示' : '关闭展示', cancelText: '取消',
      onOk: async () => { if (!await setPublished(kind, record, published)) throw new Error('操作失败'); },
    });
  }
  function deleteRecord(record: Reference) {
    modal.confirm({ title: `删除${noun}「${'code' in record ? record.code : record.name}」？`, content: '删除后该记录不可恢复，操作日志会保留。已被引用的记录无法删除。', okText: '确认删除', okButtonProps: { danger: true }, cancelText: '取消', onOk: async () => { if (!await remove(kind, record)) throw new Error('删除失败'); } });
  }
  const columns: ColumnsType<Reference> = [
    {
      title: isRoute ? '航线名称' : '亚马逊仓库', key: 'name', width: isRoute ? 195 : 210,
      render: (_, record) => <div><div className="table-primary">{'code' in record ? record.code : record.name}</div><div className="table-secondary">{'code' in record ? record.name : record.carrier}</div></div>,
    },
    ...(isRoute ? [
      { title: '公司渠道', key: 'channel', width: 140, render: (_: unknown, record: Reference) => 'channel' in record ? <Tag bordered={false}>{record.channel}</Tag> : null },
      { title: '起运港 / 目的港', key: 'ports', width: 200, render: (_: unknown, record: Reference) => 'origin' in record ? <Space size={7}><span>{record.origin}</span><ArrowRightOutlined className="muted" /><span>{record.destination}</span></Space> : null },
      { title: '参考时效', key: 'days', width: 100, render: (_: unknown, record: Reference) => 'estimatedDays' in record ? <span><strong>{record.estimatedDays}</strong><span className="muted"> 天</span></span> : null },
    ] : [
      { title: '所属地区', key: 'region', width: 135, render: (_: unknown, record: Reference) => 'region' in record ? record.region : null },
      { title: '仓库地址', key: 'address', width: 250, ellipsis: true, render: (_: unknown, record: Reference) => 'address' in record ? <Tooltip title={record.address}>{record.address || '—'}</Tooltip> : null },
    ]),
    { title: isRoute ? '关联柜子' : '送仓批次', key: 'references', width: 100, render: (_, record) => <span>{referenceCount(record)} <span className="muted">{isRoute ? '柜' : '批'}</span></span> },
    { title: '启用状态', key: 'enabled', width: 95, render: (_, record) => <Switch size="small" checked={record.enabled} disabled={busy} aria-label={`${'code' in record ? record.code : record.name}启用状态`} onChange={checked => toggleEnabled(record, checked)} /> },
    { title: '前台展示', key: 'published', width: 100, render: (_, record) => <Tooltip title={!record.enabled && record.published ? '当前已停用，展示开关暂不生效' : '展示仍受关联记录开关控制'}><Switch size="small" checked={record.published} disabled={busy} aria-label={`${'code' in record ? record.code : record.name}前台展示`} onChange={checked => togglePublished(record, checked)} /></Tooltip> },
    { title: '操作', key: 'actions', width: 110, fixed: 'right', render: (_, record) => <Space size={0}><Button type="text" size="small" icon={<EditOutlined />} aria-label={`编辑${'code' in record ? record.code : record.name}`} onClick={() => showEditor(record)} /><Tooltip title={referenceCount(record) ? '已有业务记录引用，可停用但不能删除' : '删除'}><Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`删除${'code' in record ? record.code : record.name}`} disabled={busy || referenceCount(record) > 0} onClick={() => deleteRecord(record)} /></Tooltip></Space> },
  ];

  return <>
    <div className="page-heading"><div><h1>{isRoute ? '航线管理' : '亚马逊仓库'}</h1><p>{isRoute ? '统一维护公司渠道、航线与港口，连接每一段运输。' : '维护目的仓库和送仓关联，让每一批货都有清晰去向。'}</p></div><Button type="primary" icon={<PlusOutlined />} onClick={() => showEditor()}>新增{noun}</Button></div>
    <div className="inline-metrics mb-5 flex flex-wrap gap-6 rounded-xl border border-[#e1e8e8] bg-white px-6 py-5"><span className="muted">全部{noun} <strong className="ml-2 text-lg text-[#213c42]">{records.length}</strong></span><span className="muted">已启用 <strong className="ml-2 text-lg text-[#177b70]">{records.filter(r => r.enabled).length}</strong></span><span className="muted">展示已开启 <strong className="ml-2 text-lg text-[#213c42]">{records.filter(r => r.published).length}</strong></span><span className="ml-auto text-xs text-[#7a8c90]">{isRoute ? '公司渠道与船公司航线独立记录' : '同一仓库可对应多个柜子、多个送仓批次'}</span></div>
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[#edf1f1] p-5"><Input allowClear prefix={<SearchOutlined className="muted" />} placeholder={isRoute ? '搜索航线、渠道或港口' : '搜索仓库代码、名称或地区'} aria-label={`搜索${noun}`} value={search} onChange={e => setSearch(e.target.value)} style={{ width: 290 }} /><Select aria-label={`${noun}启用状态筛选`} value={status} onChange={setStatus} options={[{ value: 'all', label: '全部启用状态' }, { value: 'enabled', label: '已启用' }, { value: 'disabled', label: '已停用' }]} style={{ width: 150 }} /><Button onClick={() => { setSearch(''); setStatus('all'); }}>重置</Button><span className="muted ml-auto text-xs">共 {filtered.length} 条记录</span></div>
      <Table<Reference> rowKey="id" columns={columns} dataSource={filtered} pagination={{ pageSize: 10, showSizeChanger: false, showTotal: total => `共 ${total} 条` }} scroll={{ x: isRoute ? 1110 : 1050 }} />
    </section>
    <div className="mt-4 flex items-center gap-2 text-xs text-[#819295]">停用或关闭展示不会删除业务记录。被引用的{noun}需保留，以保证历史数据完整。</div>
    <Drawer title={editing ? `编辑${noun}` : `新增${noun}`} open={open} onClose={closeEditor} width={560} destroyOnHidden footer={<div className="flex items-center justify-between"><span className="muted text-xs">{editing ? '保存后将记录本次修改' : '新记录默认不在前台展示'}</span><Space><Button onClick={closeEditor}>取消</Button><Button type="primary" loading={busy} onClick={() => form.submit()}>保存{noun}</Button></Space></div>}>
      <Alert type="info" showIcon message={isRoute ? '公司渠道与具体航线分别维护' : '使用实际亚马逊仓库代码'} description={isRoute ? '例如公司渠道为“美西快船”，具体航线为“美森 CLX”。参考时效仅作配置参考，不替代实际运输时效。' : '代码用于关联柜子中的送仓批次；新增仓库后，需要单独确认是否开启前台展示。'} className="mb-6" />
      <Form form={form} layout="vertical" onFinish={submit} requiredMark="optional">
        {isRoute ? <>
          <Form.Item label="航线名称" name="name" rules={required}><Input placeholder="例如：美森 CLX" maxLength={80} /></Form.Item>
          <div className="field-grid grid grid-cols-2 gap-x-4"><Form.Item label="公司渠道" name="channel" rules={required}><Input placeholder="例如：美西快船" maxLength={80} /></Form.Item><Form.Item label="船公司" name="carrier" rules={required}><Input placeholder="例如：MATSON" maxLength={80} /></Form.Item><Form.Item label="起运港" name="origin" rules={required}><Input placeholder="例如：上海" maxLength={80} /></Form.Item><Form.Item label="目的港" name="destination" rules={required}><Input placeholder="例如：长滩" maxLength={80} /></Form.Item></div>
          <Form.Item label="参考时效（自然日）" name="estimatedDays" rules={[{ required: true, message: '请填写参考时效' }]}><InputNumber min={1} max={365} precision={0} style={{ width: '100%' }} addonAfter="天" /></Form.Item>
        </> : <>
          <div className="field-grid grid grid-cols-2 gap-x-4"><Form.Item label="仓库代码" name="code" rules={[...required, { pattern: /^[A-Za-z0-9-]+$/, message: '仅使用英文字母、数字或连字符' }]}><Input placeholder="例如：ONT8" maxLength={20} /></Form.Item><Form.Item label="所属地区" name="region" rules={required}><Input placeholder="例如：美西 · 加利福尼亚" maxLength={80} /></Form.Item></div>
          <Form.Item label="仓库名称" name="name" rules={required}><Input placeholder="例如：Moreno Valley 亚马逊仓" maxLength={120} /></Form.Item><Form.Item label="仓库地址" name="address"><Input.TextArea placeholder="填写仓库地址，便于送仓核对" maxLength={300} rows={3} showCount /></Form.Item>
        </>}
        <Form.Item label="启用状态" name="enabled" valuePropName="checked" extra="停用后保留历史关联数据，并从前台预览隐藏相关记录。"><Switch checkedChildren="启用" unCheckedChildren="停用" /></Form.Item>
      </Form>
    </Drawer>
  </>;
}
