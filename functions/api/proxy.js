/**
 * 发票直链代理（Cloudflare Pages Function / Workers 共用）
 *
 * 作用：浏览器受同源策略限制，拿不到别的站点的 PDF。这里在边缘把文件取回来。
 * 边界：只取 PDF 与图片、单文件 ≤ 20 MB、拒绝内网与云元数据地址、拒绝重定向到内网。
 *
 * 可选环境变量：
 *   ALLOWED_HOSTS=invoice.example.com,cdn.example.com
 *   配了之后只允许这些域名及其子域，适合只给自己用。
 */

const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const USER_AGENT = 'invoice-two-up/1.0 (invoice layout merger)';

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  };
}

function fail(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }, corsHeaders())
  });
}

/** 挡住 localhost、内网段、云元数据与十进制写法的 IP */
function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal' || h === 'instance-data' || h === 'metadata') return true;
  if (h.includes(':')) return true;              // IPv6 一律保守拒绝
  if (/^\d+$/.test(h)) return true;              // 2130706433 这类十进制 IP
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const p = [1, 2, 3, 4].map(function (i) { return parseInt(m[i], 10); });
  if (p.some(function (n) { return n > 255; })) return true;
  const a = p[0], b = p[1];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;       // link-local / 元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function allowedByEnv(hostname, env) {
  const raw = env && env.ALLOWED_HOSTS;
  if (!raw) return true;
  const hosts = String(raw).split(',').map(function (s) {
    return s.trim().toLowerCase();
  }).filter(Boolean);
  if (!hosts.length) return true;
  const h = String(hostname).toLowerCase();
  return hosts.some(function (allowed) {
    return h === allowed || h.endsWith('.' + allowed);
  });
}

function sniffType(bytes) {
  if (bytes.length < 5) return null;
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return 'image/webp';
  }
  return null;
}

function concatBuffers(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function handleProxy(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'GET') return fail(405, '只接受 GET');

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get('url');
  if (!target) return fail(400, '缺少 url 参数');

  let u;
  try {
    u = new URL(target);
  } catch (e) {
    return fail(400, 'url 不是合法地址');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail(400, '只支持 http / https');
  if (isBlockedHost(u.hostname)) return fail(403, '这个地址不允许代理');
  if (!allowedByEnv(u.hostname, env)) return fail(403, '该域名不在 ALLOWED_HOSTS 白名单内');

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(u.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/pdf,image/*;q=0.9,*/*;q=0.5'
      }
    });
  } catch (e) {
    clearTimeout(timer);
    return fail(504, '取回超时或被目标站点拒绝');
  }
  clearTimeout(timer);

  if (!upstream.ok) return fail(upstream.status === 404 ? 404 : 502, '目标站点返回 HTTP ' + upstream.status);

  // 重定向后也要再查一次，防止跳进内网
  try {
    const finalUrl = new URL(upstream.url);
    if (isBlockedHost(finalUrl.hostname) || !allowedByEnv(finalUrl.hostname, env)) {
      return fail(403, '目标站点重定向到了不允许的地址');
    }
  } catch (e) { /* upstream.url 可能为空，忽略 */ }

  const length = parseInt(upstream.headers.get('content-length') || '0', 10);
  if (length && length > MAX_BYTES) return fail(413, '文件超过 20 MB');

  if (!upstream.body) return fail(502, '目标站点没有返回内容');

  const reader = upstream.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const step = await reader.read();
    if (step.done) break;
    const chunk = step.value;
    total += chunk.byteLength;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch (e) { /* noop */ }
      return fail(413, '文件超过 20 MB');
    }
    chunks.push(chunk);
  }

  const bytes = concatBuffers(chunks, total);
  const type = sniffType(bytes);
  if (!type) return fail(415, '这个地址返回的不是 PDF 或图片');

  return new Response(bytes, {
    status: 200,
    headers: Object.assign({
      'content-type': type,
      'content-length': String(total),
      'content-disposition': 'inline; filename="invoice"',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }, corsHeaders())
  });
}

/* ---- Cloudflare Pages Functions 入口 ---- */
export async function onRequestGet(context) {
  return handleProxy(context.request, context.env);
}

export async function onRequestOptions(context) {
  return handleProxy(context.request, context.env);
}
