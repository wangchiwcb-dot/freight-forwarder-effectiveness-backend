import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Spin, App as AntApp } from 'antd';
import type { BaseRecord, EntityKind, Snapshot } from '../shared/types';

interface AdminContextValue {
  data: Snapshot; busy: boolean; reload: () => Promise<void>;
  save: (kind: EntityKind, id: string | null, input: unknown) => Promise<boolean>;
  setPublished: (kind: EntityKind, record: BaseRecord, published: boolean) => Promise<boolean>;
  remove: (kind: EntityKind, record: BaseRecord) => Promise<boolean>;
}
const Context = createContext<AdminContextValue | null>(null);
async function request<T>(path: string, method='GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {method,headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const payload = await response.json().catch(()=>({message:'服务暂时不可用，请稍后重试'}));
  if(!response.ok) throw new Error(payload.message || '操作失败，请刷新后重试');
  return payload as T;
}
export function AdminProvider({children}: {children: ReactNode}) {
  const {message} = AntApp.useApp();
  const [data,setData] = useState<Snapshot|null>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const reload = useCallback(async()=>{
    const snapshot = await request<Snapshot>('/state');
    setData(snapshot); setError('');
  },[]);
  useEffect(()=>{ void reload().catch(e=>setError(e.message)); },[reload]);
  async function mutate(path: string,method: string,body: unknown,success: string) {
    setBusy(true);
    try { await request(path,method,body); await reload(); message.success(success); return true; }
    catch(e) { message.error(e instanceof Error?e.message:'操作失败'); await reload().catch(()=>{}); return false; }
    finally { setBusy(false); }
  }
  if(!data) return <div className="boot-screen">{error?<Alert type="error" showIcon message="暂时无法连接管理服务" description={error} action={<Button onClick={()=>void reload().catch(e=>setError(e.message))}>重试</Button>}/>:<Spin tip="正在加载工作台…" size="large"><div className="boot-placeholder"/></Spin>}</div>;
  return <Context.Provider value={{data,busy,reload,
    save:(kind,id,input)=>mutate(`/${kind}${id?`/${id}`:''}`,id?'PUT':'POST',input,id?'更改已保存':'已创建，默认不在前台展示'),
    setPublished:(kind,record,published)=>mutate(`/${kind}/${record.id}/publication`,'PATCH',{published,version:record.version},published?'已开启展示开关':'已关闭展示开关'),
    remove:(kind,record)=>mutate(`/${kind}/${record.id}`,'DELETE',{version:record.version},'记录已删除，操作日志已保留'),
  }}>{children}</Context.Provider>;
}
export function useAdmin() {const value=useContext(Context);if(!value) throw new Error('AdminProvider missing');return value;}
