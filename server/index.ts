import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';

const clientRoot=resolve(process.cwd(),'dist/client');
const app=await buildApp({dbPath:process.env.ADMIN_DB_PATH ?? resolve('.data/admin.sqlite'),
  staticRoot:existsSync(clientRoot)?clientRoot:undefined,logger:true});
const port=Number(process.env.PORT ?? 3102);
if(!Number.isInteger(port) || port<1 || port>65535) throw new Error('PORT 必须是有效端口号');
for(const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>void app.close().then(()=>process.exit(0)));
await app.listen({host:'127.0.0.1',port});
