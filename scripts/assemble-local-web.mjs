import {mkdir,readFile,writeFile,cp,rm,readdir,lstat,access,rename} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {listInventory,verifyRuntimeInventory} from './runtime-inventory.mjs';
import {resourceSha256} from './verify-runtime-resources.mjs';
export const root=resolve(import.meta.dirname,'..');
const excluded=new Set(['node_modules','.runtime-cache','runtime','bundles','delivery','.git','.venv','.models','dist-web','dist-local-service','resources/source-files.json']);
function run(c,a,o={}) {const r=spawnSync(c,a,{stdio:'inherit',windowsHide:true,...o});if(r.status!==0)throw new Error(`装配失败：${c}`);}
export async function productionPackages(target,destination,cache) {
 const [os,cpu]=target.split('-'),lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8')),records=[];await mkdir(cache,{recursive:true});
 for(const [name,s] of Object.entries(lock.packages)) {
  if(!name||s.dev||(s.os&&!s.os.includes(os))||(s.cpu&&!s.cpu.includes(cpu)))continue;
  if(!name.startsWith('node_modules/')||name.includes('/../')||!s.resolved?.startsWith('https://registry.npmjs.org/')||!s.integrity?.startsWith('sha512-'))throw new Error(`无效 npm 锁项：${name}`);
  const archive=join(cache,`${name.slice(13).replaceAll('/','-').replaceAll('@','')}-${s.version}.tgz`);
  const matches=async f=>'sha512-'+createHash('sha512').update(await readFile(f)).digest('base64')===s.integrity;
  try {await access(archive);} catch {
   if(process.env.SC_INSTALL_OFFLINE==='1')throw new Error(`离线 npm 归档缺失：${name}`);
   const partial=archive+'.partial',curl=process.platform==='win32'?join(process.env.SystemRoot||'C:\\Windows','System32','curl.exe'):'/usr/bin/curl';
   run(curl,['--fail','--location','--retry','2',s.resolved,'--output',partial]);
   if(!await matches(partial)){await rm(partial,{force:true});throw new Error(`npm 下载校验失败：${name}`);}await rename(partial,archive);
  }
  if(!await matches(archive))throw new Error(`npm 缓存校验失败：${name}`);
  const dest=join(destination,name);await mkdir(dest,{recursive:true});
  run(process.platform==='win32'?'tar.exe':'/usr/bin/tar',['-xf',archive,'-C',dest,'--strip-components','1']);
  records.push({name:name.slice(13),version:s.version,url:s.resolved,integrity:s.integrity,sha256:await resourceSha256(archive)});
 }
 return records;
}
export async function assembleBundle(target) {
 if(!['darwin-arm64','darwin-x64','win32-x64'].includes(target))throw new Error('未知目标');
 const hashes=JSON.parse(await readFile(join(root,'resources/local-runtime-lock.json'),'utf8'));
 await verifyRuntimeInventory(join(root,'runtime',target),target,hashes[target]);
 const stage=join(root,'.runtime-cache',`bundle-${target}`);await rm(stage,{force:true,recursive:true});await mkdir(stage,{recursive:true});
 await cp(join(root,'runtime',target),join(stage,'runtime',target),{recursive:true,verbatimSymlinks:true});
 await writeFile(join(stage,'npm-packages.json'),JSON.stringify(await productionPackages(target,stage,join(root,'.runtime-cache/downloads')),null,2)+'\n');
 await writeFile(join(stage,'bundle-inventory.json'),JSON.stringify({schemaVersion:1,target,files:await listInventory(stage,['bundle-inventory.json'],target)},null,2)+'\n');
 const bundles=join(root,'bundles');await mkdir(bundles,{recursive:true});const file=`sc-components-${target}.tar.gz`;
 run(process.platform==='win32'?'tar.exe':'/usr/bin/tar',['-czf',join(bundles,file),'-C',stage,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
 const path=join(root,'resources/component-bundles.json'),lock=JSON.parse(await readFile(path,'utf8'));
 lock.targets[target]={file,sha256:await resourceSha256(join(bundles,file)),inventorySha256:await resourceSha256(join(stage,'bundle-inventory.json')),runtimeInventorySha256:hashes[target]};
 await writeFile(path,JSON.stringify(lock,null,2)+'\n');return lock.targets[target];
}
export async function sourceManifest() {
 const files={};
 async function walk(dir) {
  for(const name of (await readdir(dir)).sort()) {
   const path=join(dir,name),rel=relative(root,path).split('\\').join('/');
   if(excluded.has(rel)||name.startsWith('.DS_')||name.endsWith('.tsbuildinfo'))continue;
   const info=await lstat(path);if(info.isSymbolicLink())throw new Error(`源码含本机依赖链接：${rel}`);
   if(info.isDirectory())await walk(path);else if(info.isFile())files[rel]=await resourceSha256(path);
  }
 }
 await walk(root);
 for(const dir of ['dist-web','dist-local-service'])for(const [name,s] of Object.entries(await listInventory(join(root,dir),[]))) {if(s.link)throw new Error('构建产物含符号链接');files[`${dir}/${name}`]=s.sha256;}
 await writeFile(join(root,'resources/source-files.json'),JSON.stringify({schemaVersion:1,files},null,2)+'\n');return files;
}
function zipDelivery(directory,archive) {
 const python = join(root,'runtime',`${process.platform}-${process.arch}`,process.platform==='win32'?'python/python.exe':'python/bin/python3.12');
 run(python,['-I','-B',join(root,'scripts/create-delivery-zip.py'),directory,archive],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
}
export async function assembleDelivery() {
 const files=await sourceManifest(),delivery=join(root,'delivery');await mkdir(delivery,{recursive:true});
 const source=join(delivery,'SC-public-source');await rm(source,{recursive:true,force:true});await mkdir(source);
 for(const name of [...Object.keys(files),'resources/source-files.json']){const d=join(source,name);await mkdir(resolve(d,'..'),{recursive:true});await cp(join(root,name),d);}
 const lock=JSON.parse(await readFile(join(root,'resources/component-bundles.json'),'utf8')),nodes=JSON.parse(await readFile(join(root,'resources/node-bootstrap-lock.json'),'utf8')),entries=[];
 for(const target of Object.keys(lock.targets)) {
  const dest=join(delivery,`SC-${target}`);await rm(dest,{recursive:true,force:true});await mkdir(dest,{recursive:true});
  // Platform packages and their install manifests must contain the same entry files.
  const excludedEntryExtension=target.startsWith('darwin-')?'.cmd':'.command';
  const targetFiles=Object.fromEntries(Object.entries(files).filter(([name])=>!name.endsWith(excludedEntryExtension)));
  for(const name of Object.keys(targetFiles)){const d=join(dest,name);await mkdir(resolve(d,'..'),{recursive:true});await cp(join(source,name),d);}
  await writeFile(join(dest,'resources/source-files.json'),JSON.stringify({schemaVersion:1,files:targetFiles},null,2)+'\n');
  await mkdir(join(dest,'bundles'));
  for(const [from,name] of [[join(root,'bundles',lock.targets[target].file),lock.targets[target].file],[join(root,'.runtime-cache/downloads',nodes.targets[target].file),nodes.targets[target].file]])await cp(from,join(dest,'bundles',name));
  const archive=`SC-${target}.zip`;zipDelivery(dest,join(delivery,archive));entries.push({target,file:archive,sha256:await resourceSha256(join(delivery,archive)),executionAcceptance:'见三平台实机验收表'});
 }
 const archive='SC-public-source.zip';zipDelivery(source,join(delivery,archive));entries.push({target:'source',file:archive,sha256:await resourceSha256(join(delivery,archive))});
 await writeFile(join(delivery,'manifest.json'),JSON.stringify({schemaVersion:1,baseline:'d1f3073',entries},null,2)+'\n');console.log(JSON.stringify(entries));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 if(process.argv[2]==='delivery')await assembleDelivery();else console.log(await assembleBundle(process.argv[2]??`${process.platform}-${process.arch}`));
}
