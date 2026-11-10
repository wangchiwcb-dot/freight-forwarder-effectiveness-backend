import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { EntityKind } from '../shared/types.js';
import { ApiError, Store } from './store.js';
import { publicationSchema, versionSchema } from './validation.js';

export interface AppOptions { dbPath: string; seed?: boolean; staticRoot?: string; logger?: boolean }
const entities = new Set(['containers','routes','warehouses']);
const localHosts = new Set(['localhost','127.0.0.1','[::1]']);
function entityFrom(value: string): EntityKind {
  if(!entities.has(value)) throw new ApiError(404,'未知的管理对象');
  return value as EntityKind;
}
export async function buildApp(options: AppOptions) {
  const app=Fastify({logger:options.logger ?? false,bodyLimit:1024*1024});
  const store=new Store(options.dbPath,options.seed ?? true);
  app.addHook('onClose',async()=>{store.close();});
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    reply.header('X-Content-Type-Options','nosniff');
    reply.header('Referrer-Policy','same-origin');
    reply.header('X-Frame-Options','DENY');
    const requestHost = new URL(`http://${request.headers.host ?? 'localhost'}`);
    if(!localHosts.has(requestHost.hostname)) throw new ApiError(403,'演示管理后台仅允许本机访问');
    if(['POST','PUT','PATCH','DELETE'].includes(request.method)) {
      const origin=request.headers.origin;
      if(origin) {
        let parsed: URL;
        try {parsed=new URL(origin);} catch {throw new ApiError(403,'不允许此来源的管理操作');}
        if(!['http:','https:'].includes(parsed.protocol) || !localHosts.has(parsed.hostname) ||
          ![requestHost.port,'4180','3102'].includes(parsed.port)) throw new ApiError(403,'不允许此来源的管理操作');
      }
      if(request.headers['sec-fetch-site']==='cross-site') throw new ApiError(403,'不允许跨站管理操作');
    }
  });
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof z.ZodError) return reply.code(400).send({message:error.issues[0]?.message ?? '提交的数据格式不正确'});
    if(error instanceof ApiError) return reply.code(error.statusCode).send({message:error.message});
    if(typeof error === 'object' && error && 'statusCode' in error && error.statusCode===400)
      return reply.code(400).send({message:'请求内容格式不正确'});
    request.log.error(error);
    return reply.code(500).send({message:'操作未完成，请稍后重试'});
  });
  app.get('/api/health',async()=>({status:'ok',source:'demo',productionConnected:false}));
  app.get('/api/state',async()=>store.snapshot());
  app.get('/api/public-preview',async()=>store.publicPreview());
  app.post<{Params:{entity:string}}>('/api/:entity',async(request,reply)=>{
    const result=store.create(entityFrom(request.params.entity),request.body);
    return reply.code(201).send(result);
  });
  app.put<{Params:{entity:string;id:string}}>('/api/:entity/:id',async(request)=>{
    const {version}=versionSchema.parse(request.body);
    return store.update(entityFrom(request.params.entity),request.params.id,request.body,version);
  });
  app.patch<{Params:{entity:string;id:string}}>('/api/:entity/:id/publication',async(request)=>{
    const {version,published}=publicationSchema.parse(request.body);
    return store.publish(entityFrom(request.params.entity),request.params.id,published,version);
  });
  app.delete<{Params:{entity:string;id:string}}>('/api/:entity/:id',async(request)=>{
    const {version}=versionSchema.parse(request.body);
    return store.delete(entityFrom(request.params.entity),request.params.id,version);
  });
  if(options.staticRoot) {
    await app.register(fastifyStatic,{root:options.staticRoot,prefix:'/',cacheControl:false});
    app.setNotFoundHandler(async(request,reply)=>request.url.startsWith('/api/')
      ? reply.code(404).send({message:'接口不存在'}) : reply.sendFile('index.html'));
  } else app.setNotFoundHandler(async(_request,reply)=>reply.code(404).send({message:'接口不存在'}));
  return app;
}
