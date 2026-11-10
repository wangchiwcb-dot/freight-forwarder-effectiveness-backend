import { mkdir, mkdtemp, chmod, cp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=process.cwd();
const releaseId=process.env.RELEASE_ID || new Date().toISOString().replace(/[-:.]/g,'');
if(!/^[a-zA-Z0-9-]+$/.test(releaseId))throw new Error('Invalid release id');
const output=resolve('artifacts');const stage=await mkdtemp(join(tmpdir(),'freight-admin-release-'));
try {
 await chmod(stage,0o755);await mkdir(output,{recursive:true});
 for(const name of ['dist','database','deploy','scripts'])await cp(join(root,name),join(stage,name),{recursive:true});
 for(const name of ['package.json','package-lock.json','.env.example','README.md'])await copyFile(join(root,name),join(stage,name));
 const file=`freight-admin-${releaseId}.tar.gz`;
 execFileSync('tar',['--no-xattrs','-czf',join(output,file),'-C',stage,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
 const hash=createHash('sha256').update(await readFile(join(output,file))).digest('hex');
 await writeFile(join(output,`${file}.sha256`),`${hash}  ${file}\n`);
 console.log(JSON.stringify({file:join(output,file),sha256:hash}));
}finally{await rm(stage,{recursive:true,force:true});}
