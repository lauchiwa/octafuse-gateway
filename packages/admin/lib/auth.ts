/**
 * Gateway Admin 后台会话：HMAC 签名、带过期的 `admin_session` token。
 *
 * token 结构（mini-JWT，`.` 分隔两段 base64url）：
 *   base64url(payloadJson) "." base64url(HMAC-SHA256(base64url(payloadJson), key))
 *   payloadJson = { iat:<unix s>, exp:<unix s>, nonce:<hex> }
 *
 * 签名密钥由 `ADMIN_PASSWORD` 派生（`SHA-256("octafuse-admin-session:v1:" + password)`），
 * 因此无需新增部署变量；轮换密码即使全部现存会话失效。校验用 `crypto.subtle.verify`（常量时间）。
 */

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const SIGNING_KEY_DOMAIN = 'octafuse-admin-session:v1:';

const textEncoder = new TextEncoder();

/** base64url（无填充）编码 bytes。 */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url 解码为 bytes；非法输入抛错。 */
function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 从 `Cookie` 请求头中精确取出某个 cookie 值（非子串匹配）。 */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/** 由 `ADMIN_PASSWORD` 派生 HMAC-SHA256 密钥（域分隔，避免与其他用途混用）。 */
async function deriveAdminSigningKey(adminPassword: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(SIGNING_KEY_DOMAIN + adminPassword)
  );
  return crypto.subtle.importKey(
    'raw',
    material,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/** 16 字节随机 nonce（hex）。 */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 签发签名会话 token。`adminPassword` 为空时抛错（调用方应已校验凭据配置）。
 */
export async function issueSessionToken(
  adminPassword: string,
  ttlSeconds: number = SESSION_TTL_SECONDS
): Promise<string> {
  if (!adminPassword) {
    throw new Error('issueSessionToken: adminPassword required');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = { iat: nowSeconds, exp: nowSeconds + ttlSeconds, nonce: generateNonce() };
  const payloadPart = base64urlEncode(textEncoder.encode(JSON.stringify(payload)));
  const key = await deriveAdminSigningKey(adminPassword);
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(payloadPart));
  return `${payloadPart}.${base64urlEncode(new Uint8Array(signature))}`;
}

/**
 * 校验签名会话 token：签名（常量时间）+ 未过期。任何异常/篡改/过期 → false（fail closed）。
 */
export async function verifySessionToken(
  token: string | null | undefined,
  adminPassword: string | null | undefined
): Promise<boolean> {
  if (!token || !adminPassword) return false;
  try {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return false;
    const payloadPart = token.slice(0, dot);
    const signaturePart = token.slice(dot + 1);
    if (!payloadPart || !signaturePart) return false;

    const key = await deriveAdminSigningKey(adminPassword);
    const signatureBytes = base64urlDecode(signaturePart);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      textEncoder.encode(payloadPart)
    );
    if (!valid) return false;

    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadPart))) as {
      exp?: unknown;
    };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return payload.exp > nowSeconds;
  } catch {
    return false;
  }
}

/** 从请求 `Cookie` 头取 `admin_session` 并校验签名与过期。 */
export async function verifyRequestSession(
  request: Request,
  adminPassword: string | null | undefined
): Promise<boolean> {
  const token = readCookie(request.headers.get('cookie'), 'admin_session');
  return verifySessionToken(token, adminPassword);
}

/**
 * 是否为 `admin_session` 设置 `Secure`（可选加固，由 `ADMIN_COOKIE_SECURE` 控制）。
 * - 未设置或 `0`/`false`/`no`/`off` → false（默认；明文 HTTP 可登录）
 * - `1`/`true`/`yes`/`on` → true（已部署 HTTPS 时可选用，限制 Cookie 仅经 HTTPS 回传）
 */
export function resolveCookieSecure(): boolean {
  const raw = process.env.ADMIN_COOKIE_SECURE?.trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return true;
  }
  return false;
}
