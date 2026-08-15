import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8788);
const SLSKD_URL = (process.env.SLSKD_URL || 'http://127.0.0.1:5030').replace(/\/$/, '');
const SLSKD_API_KEY = process.env.SLSKD_API_KEY || '';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const DOWNLOAD_DIR = resolve(process.env.DOWNLOAD_DIR || '/downloads');
const JOBS_DIR = join(DOWNLOAD_DIR,'.monochrome-jobs');
await mkdir(JOBS_DIR,{recursive:true});

function json(res,status,body,headers={}) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}); res.end(JSON.stringify(body,null,2)); }
function authed(req) { if (!GATEWAY_TOKEN) return true; return req.headers.authorization === `Bearer ${GATEWAY_TOKEN}`; }
function safeId(id) { return /^[A-Za-z0-9_-]{1,128}$/.test(id); }
function weakEtag(s) { return `W/\"${Number(s.size).toString(16)}-${Math.floor(s.mtimeMs).toString(16)}\"`; }
function mime(path) { return ({'.flac':'audio/flac','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.opus':'audio/opus','.wav':'audio/wav'})[extname(path).toLowerCase()] || 'application/octet-stream'; }
async function slskd(path, init={}) { const headers=new Headers(init.headers||{}); if(SLSKD_API_KEY) headers.set('x-api-key',SLSKD_API_KEY); const r=await fetch(`${SLSKD_URL}${path}`,{...init,headers}); if(!r.ok) throw new Error(`slskd ${r.status}: ${(await r.text()).slice(0,1000)}`); return r; }
async function bodyJson(req) { const chunks=[]; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'); }
async function saveJob(job) { await writeFile(join(JOBS_DIR,`${job.id}.json`),JSON.stringify(job,null,2)); }
async function loadJob(id) { return JSON.parse(await readFile(join(JOBS_DIR,`${id}.json`),'utf8')); }
async function filesRecursive(root) { const out=[]; async function walk(dir){ for(const e of await readdir(dir,{withFileTypes:true})){ const p=join(dir,e.name); if(e.isDirectory()) await walk(p); else out.push(p); } } try { await walk(root); } catch {} return out; }
async function locate(job) { const root=join(DOWNLOAD_DIR,'monochrome',job.id); const files=await filesRecursive(root); if(!files.length) return null; const expected=basename(job.filename).toLowerCase(); return files.find(f=>basename(f).toLowerCase()===expected) || files[0]; }
async function source(id) { if(!safeId(id)) throw new Error('invalid id'); const job=await loadJob(id); const path=await locate(job); if(!path) return null; return {job,path,s:await stat(path)}; }
async function serve(req,res,path,s){ const etag=weakEtag(s), lm=s.mtime.toUTCString(); if(req.headers['if-none-match']===etag){res.writeHead(304,{etag,'last-modified':lm});return res.end();} const h={'content-type':mime(path),'accept-ranges':'bytes',etag,'last-modified':lm,'cache-control':'private, max-age=0'}; const range=req.headers.range; if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m){res.writeHead(416,{'content-range':`bytes */${s.size}`});return res.end();}let start=m[1]?Number(m[1]):0,end=m[2]?Number(m[2]):s.size-1;if(!m[1]&&m[2]){const n=Number(m[2]);start=Math.max(0,s.size-n);end=s.size-1;}if(start>end||start>=s.size){res.writeHead(416,{'content-range':`bytes */${s.size}`});return res.end();}end=Math.min(end,s.size-1);h['content-range']=`bytes ${start}-${end}/${s.size}`;h['content-length']=String(end-start+1);res.writeHead(206,h);if(req.method==='HEAD')return res.end();return createReadStream(path,{start,end}).pipe(res);}h['content-length']=String(s.size);res.writeHead(200,h);if(req.method==='HEAD')return res.end();createReadStream(path).pipe(res);}

http.createServer(async(req,res)=>{
  try {
    if(!authed(req)) return json(res,401,{error:'unauthorized'});
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`), p=u.pathname.split('/').filter(Boolean);
    if(u.pathname==='/healthz') return json(res,200,{ok:true,slskd:SLSKD_URL,downloadDir:DOWNLOAD_DIR});
    if(u.pathname==='/v1/search'&&req.method==='GET'){const q=(u.searchParams.get('q')||'').trim();if(q.length<2)return json(res,400,{error:'query_too_short'});const r=await slskd('/api/v0/searches',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({searchText:q})});return json(res,200,await r.json());}
    if(p[0]==='v1'&&p[1]==='search'&&p[2]){const r=await slskd(`/api/v0/searches/${encodeURIComponent(p[2])}?includeResponses=true`);return json(res,200,await r.json());}
    if(u.pathname==='/v1/download'&&req.method==='POST'){const b=await bodyJson(req);if(!b.username||!b.filename||b.size==null)return json(res,400,{error:'username, filename and size are required'});const id=randomUUID();const payload={username:b.username,files:[{filename:b.filename,size:Number(b.size)}],options:{destination:`monochrome/${id}`}};if(b.searchId)payload.searchId=b.searchId;const r=await slskd('/api/v0/transfers/downloads/batches',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const slskdResult=await r.json();const job={id,username:b.username,filename:b.filename,size:Number(b.size),searchId:b.searchId||null,createdAt:new Date().toISOString(),slskd:slskdResult};await saveJob(job);return json(res,202,{jobId:id,sourceId:id,status:'queued',slskd:slskdResult});}
    if(p[0]==='v1'&&p[1]==='jobs'&&p[2]){const job=await loadJob(p[2]);const path=await locate(job);if(!path)return json(res,200,{jobId:job.id,sourceId:job.id,status:'pending'});const s=await stat(path);return json(res,200,{jobId:job.id,sourceId:job.id,status:'ready',name:basename(path),size:s.size,lastModified:s.mtime.toUTCString()});}
    if(p[0]==='v1'&&p[1]==='source'&&p[2]){const src=await source(p[2]);if(!src)return json(res,404,{error:'source_not_ready'});if(p[3]==='meta')return json(res,200,{id:p[2],name:basename(src.path),size:src.s.size,lastModified:src.s.mtime.toUTCString(),etag:weakEtag(src.s),mime:mime(src.path)});if(p[3]==='content')return serve(req,res,src.path,src.s);}
    json(res,404,{error:'not_found'});
  }catch(e){console.error(e);json(res,500,{error:'gateway_error',message:e.message});}
}).listen(PORT,'0.0.0.0',()=>console.log(`Soulseek gateway listening on :${PORT}`));
