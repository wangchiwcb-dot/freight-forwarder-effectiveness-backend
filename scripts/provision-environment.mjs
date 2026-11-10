// Run as root on the deployment host, with the private credential JSON path as argv[2].
// Passwords are consumed from a restricted file, never passed as command arguments or logged.
import {readFileSync,writeFileSync,mkdirSync,unlinkSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {hashPassword} from '../dist/server/server/auth.js';
if(process.getuid()!==0)throw new Error('Requires root');
const path=process.argv[2];
if(!path)throw new Error('Credential file path required');
mkdirSync('/etc/freight-admin',{recursive:true,mode:0o700});
if(existsSync('/etc/freight-admin/api.env'))throw new Error('Configuration already exists; refusing to replace');
const {username,password}=JSON.parse(readFileSync(path,'utf8'));
const hash=await hashPassword(password);
const dbPassword=randomBytes(32).toString('base64url');
const sessionSecret=randomBytes(48).toString('base64url');
const roleSQL=`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='freight_admin_api') THEN CREATE ROLE freight_admin_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END $$;\nALTER ROLE freight_admin_api PASSWORD '${dbPassword}';\n`;
execFileSync('docker',['exec','-i','freight-postgres','psql','-X','-U','postgres','-d','freight_times','-v','ON_ERROR_STOP=1'],{input:roleSQL,stdio:['pipe','ignore','pipe']});
const environment=(dbName,port)=>`NODE_ENV=production\nADMIN_SOURCE=postgres\nADMIN_ORIGIN=https://effective.omfreight.vip\nADMIN_TENANT=szzhhq\nADMIN_USERNAME=${username}\nADMIN_PASSWORD_HASH=${hash}\nADMIN_SESSION_SECRET=${sessionSecret}\nDATABASE_URL=postgresql://freight_admin_api:${dbPassword}@127.0.0.1:5432/${dbName}\nPORT=${port}\n`;
writeFileSync('/etc/freight-admin/api.env',environment('freight_times',3102),{mode:0o600,flag:'wx'});
writeFileSync('/etc/freight-admin/stage.env',environment('freight_admin_stage_20261110',3104),{mode:0o600,flag:'wx'});
unlinkSync(path);
console.log('Created restricted production and staging configuration.');
