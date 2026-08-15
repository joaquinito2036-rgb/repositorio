# Monochrome Soulseek Streaming API for Cloudflare Workers

API de streaming orientada a Monochrome: **Cloudflare Worker + Cloudflare Container con FFmpeg** y un **Soulseek Gateway HTTPS** que se ejecuta junto a `slskd` en un VPS/NAS/PC.

> Usa Soulseek únicamente para contenido que tengas derecho a descargar o distribuir. Este proyecto no evita DRM ni controles de acceso.

## Arquitectura

```text
Monochrome / cliente
        |
        v
Cloudflare Worker (auth, CORS, URL pública)
        |
        v
Cloudflare Container (Node + FFmpeg/ffprobe)
        | HTTPS :443
        v
Soulseek Gateway ---- localhost/LAN ---- slskd ---- Soulseek
        |                                  |
        +--------- carpeta downloads ------+
```

El Gateway es deliberadamente externo: Cloudflare Containers permite salida pública HTTP/HTTPS, pero no es el lugar adecuado para una sesión Soulseek que necesita TCP P2P arbitrario. El Container sí es adecuado para ejecutar FFmpeg.

## Calidades

Perfiles nativos actuales reflejados de Monochrome:

- `auto` — Auto (Adaptive)
- `HI_RES_LOSSLESS` — Hi-Res Lossless (24-bit)
- `LOSSLESS` — Lossless (16-bit)
- `HIGH` — AAC 320 kbps
- `LOW` — AAC 96 kbps
- `MAX` — calidad máxima/original dependiente del archivo

También se incluyen los perfiles FFmpeg que Monochrome ofrece para descarga/conversión: MP3 128/256/320, OGG 128/256/320, Opus 96/128/160/256/320, AAC 256, FLAC, ALAC y WAV 16-bit.

La API **no reetiqueta un archivo con pérdida como lossless**. Si el origen es MP3/AAC, `LOSSLESS`/`HI_RES_LOSSLESS` hacen pass-through del origen. Los bitrates con pérdida se limitan al bitrate del origen cuando este es menor, para no aparentar una mejora inexistente.

## Streaming

- HLS: AAC/fMP4, segmentos de 4 s. En `auto` genera una escalera adaptativa (96/160/320 kbps, limitada por el archivo).
- MPEG-DASH: AAC/fMP4 con varias representaciones en `auto`.
- Directo: fuente original con `Range`, o transcodificación a FLAC/AAC/MP3/OGG/Opus/ALAC/WAV.
- `ffprobe` determina codec, bitrate, sample rate, canales, bits y si la fuente es lossless.

Todos los archivos servidos incluyen `Last-Modified`, `ETag`, `Accept-Ranges`; se implementan `Range`, `If-None-Match` e `If-Modified-Since` donde corresponde.

## 1. Configurar slskd

Configura una API key de al menos 16 caracteres y una carpeta de descargas conocida. El Gateway usa `X-API-Key` contra slskd.

Ejemplo conceptual:

```yaml
web:
  authentication:
    api_keys:
      monochrome:
        key: CAMBIA_ESTA_CLAVE_LARGA
```

Arranca el Gateway en el mismo host o red que slskd y monta la misma carpeta de descargas:

```bash
docker build -t monochrome-soulseek-gateway ./soulseek-gateway

docker run --rm -p 8788:8788 \
  -e SLSKD_URL=http://host.docker.internal:5030 \
  -e SLSKD_API_KEY='tu-api-key-slskd' \
  -e GATEWAY_TOKEN='otro-secreto-muy-largo' \
  -e DOWNLOAD_DIR=/downloads \
  -v /ruta/real/slskd/downloads:/downloads \
  monochrome-soulseek-gateway
```

Expón el Gateway mediante **HTTPS** (por ejemplo un reverse proxy o Cloudflare Tunnel). No expongas la API de slskd directamente a Internet.

## 2. Cloudflare

```bash
npm install
npx wrangler secret put API_TOKEN
npx wrangler secret put SOULSEEK_GATEWAY_URL
npx wrangler secret put SOULSEEK_GATEWAY_TOKEN
npm run deploy
```

`SOULSEEK_GATEWAY_URL` debe ser una URL HTTPS accesible por puerto 443.

Para desarrollo puedes omitir `API_TOKEN`. En producción se recomienda configurarlo. El cliente puede autenticar con `Authorization: Bearer ...` o `?access_token=...` (útil para reproductores HLS/DASH que no permiten cabeceras personalizadas).

## API

### Ver calidades

```http
GET /v1/qualities
```

### Buscar en Soulseek

```http
GET /v1/search?q=artist%20album
```

Después consulta el identificador de búsqueda devuelto:

```http
GET /v1/search/{searchId}
```

### Encolar descarga

```http
POST /v1/download
Content-Type: application/json

{
  "username": "usuario_soulseek",
  "filename": "Artist\\Album\\01 - Track.flac",
  "size": 123456789,
  "searchId": "opcional"
}
```

Devuelve `jobId`/`sourceId`. Consulta hasta `ready`:

```http
GET /v1/jobs/{sourceId}
```

### Inspeccionar archivo

```http
GET /v1/media/{sourceId}/info
```

### Original / máxima calidad

```http
GET /v1/media/{sourceId}/original
GET /v1/media/{sourceId}/file?quality=MAX&format=source
```

### Archivo transcodificado

```http
GET /v1/media/{sourceId}/file?quality=HIGH
GET /v1/media/{sourceId}/file?quality=LOSSLESS
GET /v1/media/{sourceId}/file?quality=FFMPEG_MP3_320
GET /v1/media/{sourceId}/file?quality=FFMPEG_OPUS_160
GET /v1/media/{sourceId}/file?quality=FLAC
```

### HLS

```http
GET /v1/media/{sourceId}/hls/auto/master.m3u8
GET /v1/media/{sourceId}/hls/HIGH/master.m3u8
GET /v1/media/{sourceId}/hls/LOW/master.m3u8
```

### MPEG-DASH

```http
GET /v1/media/{sourceId}/dash/auto/manifest.mpd
GET /v1/media/{sourceId}/dash/HIGH/manifest.mpd
```

## Cabeceras y caché

La fuente del Gateway y la copia del Container usan la fecha real del archivo para `Last-Modified`. `ETag` es débil y se deriva de tamaño + mtime. Las versiones transcodificadas quedan cacheadas en el disco efímero del Container y se regeneran si cambia tamaño o `Last-Modified` de la fuente.

El disco de Cloudflare Container es efímero: tras un reinicio del host se vuelve a descargar/transcodificar. La fuente de verdad permanece en el Gateway/slskd.

## Limitaciones conocidas

- Cloudflare Containers puede reiniciarse; no se usa para mantener la sesión P2P de Soulseek.
- HLS/DASH usa AAC para máxima compatibilidad. FLAC/ALAC/MP3/Opus/OGG se ofrecen como archivo directo/transcodificado; no todos los reproductores aceptan esos codecs dentro de HLS/DASH.
- Dolby Atmos no se sintetiza. Si en el futuro se añade una fuente E-AC-3 JOC/AC-4, debe tratarse como pass-through compatible; FFmpeg no debe inventar metadatos Atmos.
- El MVP usa una única instancia de Container (`primary`) y cache local. Para producción grande conviene mover resultados a R2 y añadir colas/locks por transcodificación.

## Comprobaciones

```bash
npm run check
curl https://TU-WORKER/v1/qualities -H 'Authorization: Bearer TU_TOKEN'
curl 'https://TU-WORKER/v1/search?q=test' -H 'Authorization: Bearer TU_TOKEN'
```
