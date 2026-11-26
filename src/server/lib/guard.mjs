// @ts-check
// Token, Host/Origin/Sec-Fetch-Site → 403, chybějící/špatný X-ACD-Token u /api/* → 401, bezpečnostní hlavičky.
import { randomBytes, timingSafeEqual } from 'node:crypto';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Token existuje jen v paměti. ACD_TOKEN (≥ 32 znaků) jen pro testy. */
export function createSecret() {
  const fromEnv = process.env.ACD_TOKEN;
  const token = fromEnv && fromEnv.length >= 32 ? fromEnv : randomBytes(32).toString('base64url');
  const tokenBuf = Buffer.from(token, 'utf8');
  return {
    token,
    port: 0,
    /** @param {string|undefined} candidate */
    matches(candidate) {
      if (!candidate) return false;
      const c = Buffer.from(candidate, 'utf8');
      return c.length === tokenBuf.length && timingSafeEqual(c, tokenBuf);
    },
  };
}

/** @param {import('node:http').ServerResponse} res */
export function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * Vrátí null (povoleno) nebo {status, reason}.
 * @param {import('node:http').IncomingMessage} req
 * @param {{port:number, matches:(t:string|undefined)=>boolean}} secret
 */
export function checkRequest(req, secret) {
  const hosts = [`127.0.0.1:${secret.port}`, `localhost:${secret.port}`];
  const origins = hosts.map((h) => `http://${h}`);
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!hosts.includes(host)) return { status: 403, reason: 'host' };

  const site = String(req.headers['sec-fetch-site'] ?? '');
  if (site && site !== 'same-origin' && site !== 'none') return { status: 403, reason: 'sec-fetch-site' };

  const origin = String(req.headers.origin ?? '').toLowerCase();
  const safe = req.method === 'GET' || req.method === 'HEAD';
  if ((!safe || origin) && !origins.includes(origin)) return { status: 403, reason: 'origin' };

  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const t = req.headers['x-acd-token'];
    if (!secret.matches(Array.isArray(t) ? t[0] : t)) return { status: 401, reason: 'token' };
  }
  return null;
}
