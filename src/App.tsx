import { useEffect, useState } from 'react';
import { App as AntApp, Avatar, Breadcrumb, Button, Drawer, Menu, Popover, Tag, Tooltip } from 'antd';
import { AppstoreOutlined, ContainerOutlined, DeploymentUnitOutlined, ExportOutlined, EyeOutlined, HistoryOutlined, MenuOutlined, QuestionCircleOutlined, ReloadOutlined, RightOutlined, SafetyCertificateOutlined, ShopOutlined } from '@ant-design/icons';
import { useAdmin } from './store';
import { Containers } from './pages/Containers';
import { References } from './pages/References';
import { PublicationPage, AuditPage } from './pages/Governance';
import { Overview } from './pages/Overview';

type Page = 'overview' | 'containers' | 'routes' | 'warehouses' | 'publication' | 'audit';
const labels: Record<Page, string> = { overview: '工作台', containers: '柜子管理', routes: '航线管理', warehouses: '亚马逊仓库', publication: '展示管理', audit: '操作日志' };
function readPage(): Page { const key = location.hash.slice(1); return key in labels ? key as Page : 'containers'; }
const navItems = [
  { key: 'overview', icon: <AppstoreOutlined />, label: '工作台' },
  { type: 'group' as const, label: '运输数据', children: [
    { key: 'containers', icon: <ContainerOutlined />, label: '柜子管理' },
    { key: 'routes', icon: <DeploymentUnitOutlined />, label: '航线管理' },
    { key: 'warehouses', icon: <ShopOutlined />, label: '亚马逊仓库' },
  ] },
  { type: 'group' as const, label: '数据治理', children: [
    { key: 'publication', icon: <EyeOutlined />, label: '展示管理' },
    { key: 'audit', icon: <HistoryOutlined />, label: '操作日志' },
  ] },
];
export default function App() {
  const [page, setPage] = useState<Page>(readPage);
  const [mobile, setMobile] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { reload } = useAdmin();
  const { message } = AntApp.useApp();
  useEffect(() => { const handler = () => setPage(readPage()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  function navigate(key: string) { location.hash = key; setPage(key as Page); setMobile(false); window.scrollTo(0, 0); }
  const sidebar = <>
    <a className="brand" href="#containers" aria-label="中航环球，柜子管理"><img src="/brand-mark.png" alt="" /><div><strong>中航环球</strong><span>ZHONGHANG GLOBAL</span></div></a>
    <div className="workspace-label"><span className="workspace-icon"><ContainerOutlined /></span><div><strong>渠道时效管理</strong><span>TRANSIT MANAGEMENT</span></div><Tag bordered={false}>管理端</Tag></div>
    <Menu mode="inline" selectedKeys={[page]} items={navItems} onClick={({ key }) => navigate(key)} />
    <div className="sidebar-bottom"><a className="public-link" href="https://transit.omfreight.vip" target="_blank" rel="noreferrer"><span className="public-link-icon"><ExportOutlined /></span><span><strong>查看时效前台</strong><small>客户视角 · 渠道时效</small></span><RightOutlined /></a><div className="sidebar-footnote"><span className="status-dot" />本地演示环境 <span>v0.1</span></div></div>
  </>;
  return <div className="admin-shell">
    <a href="#main-content" className="skip-link" onClick={e => { e.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳到主内容</a>
    <aside className="sidebar">{sidebar}</aside>
    <div className="main-shell">
      <header className="topbar"><div className="topbar-left"><Button className="mobile-menu" aria-label="打开导航" icon={<MenuOutlined />} onClick={() => setMobile(true)} /><span className="topbar-symbol"><AppstoreOutlined /></span><Breadcrumb items={[{ title: '管理后台' }, { title: labels[page] }]} /></div><div className="topbar-right"><Tag className="environment-tag" bordered={false}><span className="status-dot" />演示数据</Tag><Tooltip title="刷新数据"><Button type="text" aria-label="刷新数据" loading={refreshing} icon={<ReloadOutlined />} onClick={async () => { setRefreshing(true); try { await reload(); message.success('数据已刷新'); } catch { message.error('刷新失败，请稍后重试'); } finally { setRefreshing(false); } }} /></Tooltip><Popover title="关于这个工作区" content={<div className="help-content">这里使用独立的本地演示数据。所有编辑会保存并记录操作日志，展示开关可在「展示管理」中预览效果。尚未与线上时效前台联动。</div>} trigger="click"><Button type="text" aria-label="使用说明" icon={<QuestionCircleOutlined />} /></Popover><div className="user-chip"><Avatar size={32} style={{ background: '#eaf0ee', color: '#53716a' }}>管</Avatar><span>演示管理员</span></div></div></header>
      <main className="page-content" id="main-content" tabIndex={-1}>{page === 'overview' ? <Overview onNavigate={navigate} /> : page === 'containers' ? <Containers /> : page === 'routes' || page === 'warehouses' ? <References key={page} kind={page} /> : page === 'publication' ? <PublicationPage /> : <AuditPage />}<footer className="main-footer"><span>中航环球 · 渠道时效管理系统</span><span><SafetyCertificateOutlined /> 每次数据变更均保留操作记录</span></footer></main>
    </div>
    <Drawer placement="left" open={mobile} onClose={() => setMobile(false)} width={248} styles={{ body: { padding: 0 } }} title="导航">{sidebar}</Drawer>
  </div>;
}
