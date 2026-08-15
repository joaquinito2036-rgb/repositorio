import { Container, getContainer } from '@cloudflare/containers';
import { env as runtimeEnv } from 'cloudflare:workers';

interface Env {
  MEDIA_CONTAINER: DurableObjectNamespace<MediaContainer>;
  API_TOKEN?: string;
  SOULSEEK_GATEWAY_URL?: string;
  SOULSEEK_GATEWAY_TOKEN?: string;
  CORS_ORIGINS?: string;
}

export class MediaContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '24h';
  enableInternet = true;
  envVars = {
    SOULSEEK_GATEWAY_URL: String((runtimeEnv as unknown as Env).SOULSEEK_GATEWAY_URL || ''),
    SOULSEEK_GATEWAY_TOKEN: String((runtimeEnv as unknown as Env).SOULSEEK_GATEWAY_TOKEN || '')
  };
}

function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get('Origin') || '*';
  const allowed = (env.CORS_ORIGINS || '*').split(',').map(v => v.trim());
  const allowOrigin = allowed.includes('*') || allowed.includes(origin) ? origin : allowed[0] || 'null';
  return new Headers({
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,Range,If-None-Match,If-Modified-Since',
    'Access-Control-Expose-Headers': 'Accept-Ranges,Content-Length,Content-Range,Content-Type,ETag,Last-Modified,X-Source-Quality,X-Effective-Quality',
    'Vary': 'Origin'
  });
}

function authorized(request: Request, env: Env): boolean {
  if (!env.API_TOKEN) return true;
  const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const queryToken = new URL(request.url).searchParams.get('access_token');
  return bearer === env.API_TOKEN || queryToken === env.API_TOKEN;
}

function withHeaders(response: Response, extra: Headers): Response {
  const headers = new Headers(response.headers);
  extra.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!authorized(request, env)) return withHeaders(Response.json({ error: 'unauthorized' }, { status: 401 }), cors);

    const url = new URL(request.url);
    if (url.pathname === '/') {
      return withHeaders(Response.json({
        name: 'Monochrome Soulseek Streaming API',
        version: 1,
        endpoints: ['/v1/qualities', '/v1/search', '/v1/download', '/v1/jobs/:id', '/v1/media/:id/info', '/v1/media/:id/original', '/v1/media/:id/file', '/v1/media/:id/hls/:quality/master.m3u8', '/v1/media/:id/dash/:quality/manifest.mpd']
      }), cors);
    }

    const instance = getContainer(env.MEDIA_CONTAINER, 'primary');
    const response = await instance.fetch(request);
    return withHeaders(response, cors);
  }
};
