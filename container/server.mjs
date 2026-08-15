import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile, access, utimes } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT || 8080);
const CACHE_DIR = resolve(process.env.CACHE_DIR || '/tmp/monochrome-media');
const GATEWAY_URL = (process.env.SOULSEEK_GATEWAY_URL || '').replace(/\/$/, '');
const GATEWAY_TOKEN = process.env.SOULSEEK_GATEWAY_TOKEN || '';
const AUDIO_EXTS = new Set(['.flac','.wav','.aiff','.aif','.alac','.m4a','.aac','.mp3','.ogg','.opus','.wma','.ape','.wv']);
const LOSSLESS_CODECS = new Set(['flac','alac','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le','wavpack','ape']);

const MONOCHROME_QUALITIES = {
  auto: { label: 'Auto (Adaptive)', kind: 'adaptive' },
  MAX: { label: 'Maximum / Source', kind: 'source' },
  HI_RES_LOSSLESS: { label: 'Hi-Res Lossless (24-bit)', kind: 'lossless', bits: 24 },
  LOSSLESS: { label: 'Lossless (16-bit)', kind: 'lossless', bits: 16 },
  HIGH: { label: 'AAC 320kbps', kind: 'lossy', codec: 'aac', bitrate: 320000 },
  LOW: { label: 'AAC 96kbps', kind: 'lossy', codec: 'aac', bitrate: 96000 },
  FFMPEG_MP3_320: { label: 'MP3 320kbps', kind: 'lossy', codec: 'libmp3lame', bitrate: 320000, ext: 'mp3', mime: 'audio/mpeg' },
  FFMPEG_MP3_256: { label: 'MP3 256kbps', kind: 'lossy', codec: 'libmp3lame', bitrate: 256000, ext: 'mp3', mime: 'audio/mpeg' },
  FFMPEG_MP3_128: { label: 'MP3 128kbps', kind: 'lossy', codec: 'libmp3lame', bitrate: 128000, ext: 'mp3', mime: 'audio/mpeg' },
  FFMPEG_OGG_320: { label: 'OGG 320kbps', kind: 'lossy', codec: 'libvorbis', bitrate: 320000, ext: 'ogg', mime: 'audio/ogg' },
  FFMPEG_OGG_256: { label: 'OGG 256kbps', kind: 'lossy', codec: 'libvorbis', bitrate: 256000, ext: 'ogg', mime: 'audio/ogg' },
  FFMPEG_OGG_128: { label: 'OGG 128kbps', kind: 'lossy', codec: 'libvorbis', bitrate: 128000, ext: 'ogg', mime: 'audio/ogg' },
  FFMPEG_OPUS_320: { label: 'Opus 320kbps', kind: 'lossy', codec: 'libopus', bitrate: 320000, ext: 'opus', mime: 'audio/opus' },
  FFMPEG_OPUS_256: { label: 'Opus 256kbps', kind: 'lossy', codec: 'libopus', bitrate: 256000, ext: 'opus', mime: 'audio/opus' },
  FFMPEG_OPUS_160: { label: 'Opus 160kbps', kind: 'lossy', codec: 'libopus', bitrate: 160000, ext: 'opus', mime: 'audio/opus' },
  FFMPEG_OPUS_128: { label: 'Opus 128kbps', kind: 'lossy', codec: 'libopus', bitrate: 128000, ext: 'opus', mime: 'audio/opus' },
  FFMPEG_OPUS_96: { label: 'Opus 96kbps', kind: 'lossy', codec: 'libopus', bitrate: 96000, ext: 'opus', mime: 'audio/opus' },
  FFMPEG_AAC_256: { label: 'AAC 256kbps', kind: 'lossy', codec: 'aac', bitrate: 256000, ext: 'm4a', mime: 'audio/mp4' },
  FLAC: { label: 'FLAC', kind: 'lossless', codec: 'flac', ext: 'flac', mime: 'audio/flac' },
  ALAC: { label: 'Apple Lossless', kind: 'lossless', codec: 'alac', ext: 'm4a', mime: 'audio/mp4' },
  WAV: { label: 'WAV (16-bit PCM)', kind: 'lossless', codec: 'pcm_s16le', ext: 'wav', mime: 'audio/wav' }
};

await mkdir(CACHE_DIR, { recursive: true });

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body, null, 2));
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function safeId(value) { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function weakEtag(s) { return `W/\"${Number(s.size).toString(16)}-${Math.floor(s.mtimeMs).toString(16)}\"`; }
function mimeFor(path) {
  const e = extname(path).toLowerCase();
  return ({'.flac':'audio/flac','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.opus':'audio/opus','.wav':'audio/wav','.m3u8':'application/vnd.apple.mpegurl','.m4s':'video/iso.segment','.mp4':'audio/mp4','.mpd':'application/dash+xml'})[e] || 'application/octet-stream';
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
function run(cmd, args) {
  return new Promise((resolveRun, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolveRun({ out, err }) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-4000)}`)));
  });
}
async function probe(path) {
  const { out } = await run('ffprobe', ['-v','error','-select_streams','a:0','-show_entries','stream=codec_name,codec_long_name,sample_rate,channels,channel_layout,bit_rate,bits_per_sample,bits_per_raw_sample:format=duration,bit_rate,format_name','-of','json',path]);
  const data = JSON.parse(out); const a = data.streams?.[0] || {}; const f = data.format || {};
  const bitRate = Number(a.bit_rate || f.bit_rate || 0);
  const bits = Number(a.bits_per_raw_sample || a.bits_per_sample || 0);
  return { codec: a.codec_name || 'unknown', codecLongName: a.codec_long_name, sampleRate: Number(a.sample_rate || 0), channels: Number(a.channels || 0), channelLayout: a.channel_layout, bitRate, bitsPerSample: bits, duration: Number(f.duration || 0), format: f.format_name, lossless: LOSSLESS_CODECS.has(a.codec_name) || ['flac','wav','aiff','ape','wv'].includes((f.format_name || '').split(',')[0]) };
}
async function gateway(path, init = {}) {
  if (!GATEWAY_URL) throw new Error('SOULSEEK_GATEWAY_URL is not configured');
  const headers = new Headers(init.headers || {}); if (GATEWAY_TOKEN) headers.set('authorization', `Bearer ${GATEWAY_TOKEN}`);
  const response = await fetch(`${GATEWAY_URL}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`Gateway ${response.status}: ${(await response.text()).slice(0,1000)}`);
  return response;
}
async function sourceMeta(id) { return (await gateway(`/v1/source/${encodeURIComponent(id)}/meta`)).json(); }
async function ensureSource(id) {
  if (!safeId(id)) throw new Error('invalid source id');
  const meta = await sourceMeta(id);
  if (!AUDIO_EXTS.has(extname(meta.name || '').toLowerCase())) throw new Error('source is not a supported audio file');
  const dir = join(CACHE_DIR, id); const path = join(dir, 'source' + extname(meta.name || 'audio.bin').toLowerCase()); const stamp = join(dir, 'source.json');
  await mkdir(dir, { recursive: true });
  let current = null; try { current = JSON.parse(await readFile(stamp, 'utf8')); } catch {}
  if (!await exists(path) || current?.size !== meta.size || current?.lastModified !== meta.lastModified) {
    const response = await gateway(`/v1/source/${encodeURIComponent(id)}/content`);
    const tmp = `${path}.part`; await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
    const { rename } = await import('node:fs/promises'); await rename(tmp, path);
    if (meta.lastModified) { const d = new Date(meta.lastModified); if (!Number.isNaN(d.valueOf())) await utimes(path, d, d); }
    await writeFile(stamp, JSON.stringify(meta));
  }
  return { path, meta, probe: await probe(path), dir };
}
function capBitrate(probeInfo, wanted) {
  if (probeInfo.lossless || !probeInfo.bitRate) return wanted;
  return Math.max(64000, Math.min(wanted, probeInfo.bitRate));
}
function sourceQuality(p) {
  if (p.lossless && (p.bitsPerSample > 16 || p.sampleRate > 48000)) return 'HI_RES_LOSSLESS';
  if (p.lossless) return 'LOSSLESS';
  if (p.bitRate >= 256000) return 'HIGH';
  if (p.bitRate && p.bitRate <= 128000) return 'LOW';
  return 'MAX';
}
function available(p) {
  const keys = Object.keys(MONOCHROME_QUALITIES);
  return keys.map(key => ({ key, ...MONOCHROME_QUALITIES[key], effectiveBitrate: MONOCHROME_QUALITIES[key].bitrate ? capBitrate(p, MONOCHROME_QUALITIES[key].bitrate) : undefined, noQualityGain: !p.lossless && MONOCHROME_QUALITIES[key].kind === 'lossless' }));
}
async function serveFile(req, res, path, sourceStat = null, extra = {}) {
  const s = sourceStat || await stat(path); const etag = weakEtag(s); const lastModified = s.mtime.toUTCString();
  if (req.headers['if-none-match'] === etag || (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']).getTime() >= Math.floor(s.mtimeMs / 1000) * 1000)) {
    res.writeHead(304, { etag, 'last-modified': lastModified, ...extra }); return res.end();
  }
  const headers = { 'content-type': mimeFor(path), 'accept-ranges': 'bytes', etag, 'last-modified': lastModified, 'cache-control': 'public, max-age=3600', ...extra };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range); if (!m) { res.writeHead(416, { 'content-range': `bytes */${s.size}` }); return res.end(); }
    let start = m[1] ? Number(m[1]) : 0, end = m[2] ? Number(m[2]) : s.size - 1;
    if (!m[1] && m[2]) { const n = Number(m[2]); start = Math.max(0, s.size - n); end = s.size - 1; }
    if (start > end || start >= s.size) { res.writeHead(416, { 'content-range': `bytes */${s.size}` }); return res.end(); }
    end = Math.min(end, s.size - 1); headers['content-range'] = `bytes ${start}-${end}/${s.size}`; headers['content-length'] = String(end - start + 1);
    res.writeHead(206, headers); if (req.method === 'HEAD') return res.end(); return createReadStream(path, { start, end }).pipe(res);
  }
  headers['content-length'] = String(s.size); res.writeHead(200, headers); if (req.method === 'HEAD') return res.end(); createReadStream(path).pipe(res);
}
function transcodeProfile(p, requested, formatParam) {
  if (requested === 'MAX' || requested === 'auto' && formatParam === 'source') return { passthrough: true, effective: sourceQuality(p) };
  if ((requested === 'HI_RES_LOSSLESS' || requested === 'LOSSLESS') && !p.lossless) return { passthrough: true, effective: sourceQuality(p), warning: 'lossy source is not converted to fake lossless' };
  if (requested === 'HI_RES_LOSSLESS') return { codec: 'flac', ext: 'flac', mime: 'audio/flac', args: ['-c:a','flac'], effective: 'HI_RES_LOSSLESS' };
  if (requested === 'LOSSLESS') return { codec: 'flac', ext: 'flac', mime: 'audio/flac', args: ['-c:a','flac','-sample_fmt','s16'], effective: 'LOSSLESS' };
  const q = MONOCHROME_QUALITIES[requested];
  if (q?.kind === 'lossy') { const b = capBitrate(p, q.bitrate); return { codec: q.codec, ext: q.ext || (q.codec === 'aac' ? 'm4a' : 'bin'), mime: q.mime || 'audio/mp4', args: ['-c:a',q.codec,'-b:a',`${Math.round(b/1000)}k`], effective: `${q.label} (capped ${Math.round(b/1000)}kbps)` }; }
  if (q?.kind === 'lossless') return { codec: q.codec || 'flac', ext: q.ext || 'flac', mime: q.mime || 'audio/flac', args: ['-c:a',q.codec || 'flac'], effective: q.label };
  const format = (formatParam || 'source').toLowerCase();
  if (format === 'source') return { passthrough: true, effective: sourceQuality(p) };
  const map = { flac:['flac','flac','audio/flac'], alac:['alac','m4a','audio/mp4'], wav:['pcm_s16le','wav','audio/wav'], aac:['aac','m4a','audio/mp4'], mp3:['libmp3lame','mp3','audio/mpeg'], ogg:['libvorbis','ogg','audio/ogg'], opus:['libopus','opus','audio/opus'] };
  if (!map[format]) throw new Error('unsupported format');
  if (['flac','alac','wav'].includes(format) && !p.lossless) return { passthrough: true, effective: sourceQuality(p), warning: 'lossy source is not converted to fake lossless' };
  const [codec, ext, mime] = map[format]; const wanted = Number(formatParam?.match?.(/\d+/)?.[0]) || 320000;
  const args = ['-c:a',codec]; if (!['flac','alac','wav'].includes(format)) args.push('-b:a',`${Math.round(capBitrate(p,wanted)/1000)}k`);
  return { codec, ext, mime, args, effective: format.toUpperCase() };
}
async function makeFile(source, requested, format) {
  const profile = transcodeProfile(source.probe, requested, format); if (profile.passthrough) return { path: source.path, profile };
  const key = hash(JSON.stringify({ requested, format, m: source.meta.lastModified, s: source.meta.size })).slice(0,20); const out = join(source.dir, `file-${key}.${profile.ext}`);
  if (!await exists(out)) { await run('ffmpeg', ['-y','-v','error','-i',source.path,'-vn','-map_metadata','-1','-map','0:a:0',...profile.args,out]); }
  return { path: out, profile };
}
function ladder(p) {
  const max = p.lossless || !p.bitRate ? 320000 : p.bitRate; const values = [96000,160000,320000].filter(v => v <= Math.max(96000,max)); if (!values.length) values.push(96000); if (values.at(-1) < max && max < 320000 && !values.includes(max)) values.push(max); return [...new Set(values)].sort((a,b)=>a-b);
}
async function makeHls(source, quality) {
  const rates = quality === 'auto' ? ladder(source.probe) : [capBitrate(source.probe, quality === 'LOW' ? 96000 : quality === 'HIGH' ? 320000 : Number(quality) * 1000 || 320000)];
  const root = join(source.dir, `hls-${hash(JSON.stringify({quality,rates,m:source.meta.lastModified})).slice(0,16)}`); await mkdir(root,{recursive:true});
  const master = join(root,'master.m3u8'); if (!await exists(master)) {
    const entries = [];
    for (const rate of rates) { const d = join(root,`a${rate}`); await mkdir(d,{recursive:true}); const index = join(d,'index.m3u8');
      await run('ffmpeg',['-y','-v','error','-i',source.path,'-vn','-map','0:a:0','-c:a','aac','-b:a',`${Math.round(rate/1000)}k`,'-f','hls','-hls_time','4','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',join(d,'seg_%05d.m4s'),index]);
      entries.push(`#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(rate*1.08)},CODECS=\"mp4a.40.2\"\na${rate}/index.m3u8`); }
    await writeFile(master, '#EXTM3U\n#EXT-X-VERSION:7\n' + entries.join('\n') + '\n');
  }
  return root;
}
async function makeDash(source, quality) {
  const rates = quality === 'auto' ? ladder(source.probe) : [capBitrate(source.probe, quality === 'LOW' ? 96000 : quality === 'HIGH' ? 320000 : Number(quality) * 1000 || 320000)];
  const root = join(source.dir, `dash-${hash(JSON.stringify({quality,rates,m:source.meta.lastModified})).slice(0,16)}`); await mkdir(root,{recursive:true}); const manifest = join(root,'manifest.mpd');
  if (!await exists(manifest)) { const args = ['-y','-v','error','-i',source.path,'-vn']; rates.forEach(()=>args.push('-map','0:a:0')); args.push('-c:a','aac'); rates.forEach((r,i)=>args.push(`-b:a:${i}`,`${Math.round(r/1000)}k`)); args.push('-f','dash','-seg_duration','4','-use_template','1','-use_timeline','1','-adaptation_sets','id=0,streams=a',manifest); await run('ffmpeg',args); }
  return root;
}
function pathInside(root, rel) { const p = resolve(root, rel); if (p !== root && !p.startsWith(root + '/')) throw new Error('invalid asset path'); return p; }

const server = http.createServer(async (req,res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const parts = u.pathname.split('/').filter(Boolean);
    if (u.pathname === '/healthz') return json(res,200,{ok:true,ffmpeg:true,gatewayConfigured:Boolean(GATEWAY_URL)});
    if (u.pathname === '/v1/qualities') return json(res,200,{nativeStreaming:['auto','HI_RES_LOSSLESS','LOSSLESS','HIGH','LOW'],maximum:'MAX',formats:MONOCHROME_QUALITIES,hls:'AAC/fMP4 adaptive',dash:'AAC/fMP4 adaptive'});
    if (u.pathname === '/v1/search' && req.method === 'GET') { const q = u.searchParams.get('q') || ''; const r = await gateway(`/v1/search?q=${encodeURIComponent(q)}`); res.writeHead(r.status,Object.fromEntries(r.headers)); return Readable.fromWeb(r.body).pipe(res); }
    if (parts[0] === 'v1' && parts[1] === 'search' && parts[2]) { const r = await gateway(`/v1/search/${encodeURIComponent(parts[2])}`); res.writeHead(r.status,Object.fromEntries(r.headers)); return Readable.fromWeb(r.body).pipe(res); }
    if (u.pathname === '/v1/download' && req.method === 'POST') { const chunks=[]; for await (const c of req) chunks.push(c); const r=await gateway('/v1/download',{method:'POST',headers:{'content-type':'application/json'},body:Buffer.concat(chunks)}); res.writeHead(r.status,Object.fromEntries(r.headers)); return Readable.fromWeb(r.body).pipe(res); }
    if (parts[0] === 'v1' && parts[1] === 'jobs' && parts[2]) { const r=await gateway(`/v1/jobs/${encodeURIComponent(parts[2])}`); res.writeHead(r.status,Object.fromEntries(r.headers)); return Readable.fromWeb(r.body).pipe(res); }
    if (parts[0] === 'v1' && parts[1] === 'media' && parts[2]) {
      const id=parts[2]; const source=await ensureSource(id); const sourceStat=await stat(source.path); const sourceHeaders={'x-source-quality':sourceQuality(source.probe)};
      if (parts[3] === 'info') return json(res,200,{id,name:source.meta.name,size:source.meta.size,lastModified:source.meta.lastModified,probe:source.probe,sourceQuality:sourceQuality(source.probe),qualities:available(source.probe)});
      if (parts[3] === 'original') return serveFile(req,res,source.path,sourceStat,sourceHeaders);
      if (parts[3] === 'file') { const requested=u.searchParams.get('quality') || 'MAX'; const format=u.searchParams.get('format') || 'source'; const made=await makeFile(source,requested,format); return serveFile(req,res,made.path,null,{...sourceHeaders,'x-effective-quality':made.profile.effective || requested,'x-quality-warning':made.profile.warning || ''}); }
      if (parts[3] === 'hls' && parts[4]) { const quality=parts[4]; const root=await makeHls(source,quality); const rel=parts.slice(5).join('/') || 'master.m3u8'; return serveFile(req,res,pathInside(root,rel),null,{...sourceHeaders,'x-effective-quality':quality}); }
      if (parts[3] === 'dash' && parts[4]) { const quality=parts[4]; const root=await makeDash(source,quality); const rel=parts.slice(5).join('/') || 'manifest.mpd'; return serveFile(req,res,pathInside(root,rel),null,{...sourceHeaders,'x-effective-quality':quality}); }
    }
    json(res,404,{error:'not_found'});
  } catch (error) { console.error(error); json(res,500,{error:'internal_error',message:error.message}); }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`media api listening on :${PORT}`));
