import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 65536;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const COOKIE_NAME = '__Host-freight_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export interface AuthConfig {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  origin: string;
}
export class AuthError extends Error {
  constructor(public statusCode: number, message: string, public retryAfter?: number) { super(message); }
}
interface PasswordParts { salt: Buffer; key: Buffer }
function passwordParts(encoded: string): PasswordParts {
  const [scheme, n, r, p, saltText, keyText, extra] = encoded.split('$');
  if (scheme !== 'scrypt' || n !== String(SCRYPT_N) || r !== String(SCRYPT_R) || p !== String(SCRYPT_P)
    || !saltText || !keyText || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(saltText + keyText))
    throw new Error('ADMIN_PASSWORD_HASH 格式无效，请使用 hashPassword 生成');
  const salt = Buffer.from(saltText, 'base64url');
  const key = Buffer.from(keyText, 'base64url');
  if (salt.length !== 24 || key.length !== KEY_LENGTH || salt.toString('base64url') !== saltText || key.toString('base64url') !== keyText)
    throw new Error('ADMIN_PASSWORD_HASH 格式无效，请使用 hashPassword 生成');
  return { salt, key };
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}
/** Store only this encoded result in ADMIN_PASSWORD_HASH; never log the input password. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 14 || password.length > 256) throw new Error('管理员密码需为 14 至 256 个字符');
  const salt = randomBytes(24);
  const key = await derive(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
function constantEqual(left: string, right: string) {
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
}
export function validateAuthConfig(config: AuthConfig) {
  if (!config.username || config.username.trim() !== config.username || config.username.length > 100)
    throw new Error('ADMIN_USERNAME 必须为 1 至 100 个字符');
  passwordParts(config.passwordHash);
  if (!/^[A-Za-z0-9_-]{43,}$/.test(config.sessionSecret) || Buffer.from(config.sessionSecret, 'base64url').length < 32)
    throw new Error('ADMIN_SESSION_SECRET 必须是至少 32 个随机字节的 base64url 值');
  let origin: URL;
  try { origin = new URL(config.origin); } catch { throw new Error('ADMIN_ORIGIN 必须为管理后台的 HTTPS 源地址'); }
  if (origin.protocol !== 'https:' || config.origin !== origin.origin || origin.username || origin.password)
    throw new Error('ADMIN_ORIGIN 必须为管理后台的 HTTPS 源地址，不包含路径');
}
interface Session { user: string; expiresAt: number }
interface AttemptWindow { count: number; resetAt: number }
export class AuthService {
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, AttemptWindow>();
  private globalAttempts: AttemptWindow;
  private inFlight = 0;
  private readonly password: PasswordParts;
  constructor(readonly config: AuthConfig, private readonly now: () => number = Date.now) {
    validateAuthConfig(config);
    this.password = passwordParts(config.passwordHash);
    this.globalAttempts = { count: 0, resetAt: now() + LOGIN_WINDOW_MS };
  }
  private sign(token: string) { return createHmac('sha256', this.config.sessionSecret).update(token).digest('base64url'); }
  private sessionKey(token: string) { return createHash('sha256').update(token).digest('base64url'); }
  private prune() {
    const now = this.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    for (const [key, attempts] of this.attempts) if (attempts.resetAt <= now) this.attempts.delete(key);
    if (this.globalAttempts.resetAt <= now) this.globalAttempts = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  }
  private consumeAttempt(ip: string) {
    this.prune();
    let attempt = this.attempts.get(ip);
    if (!attempt) {
      // Keep memory bounded even when forwarded addresses vary. Do not evict blocked addresses.
      if (this.attempts.size >= 1024) throw new AuthError(429, '登录尝试过于频繁，请稍后重试', 900);
      attempt = { count: 0, resetAt: this.now() + LOGIN_WINDOW_MS };
      this.attempts.set(ip, attempt);
    }
    if (attempt.count >= 5 || this.globalAttempts.count >= 30 || this.inFlight >= 2) {
      const resetAt = attempt.count >= 5 ? attempt.resetAt : this.globalAttempts.resetAt;
      throw new AuthError(429, '登录尝试过于频繁，请稍后重试', Math.max(1, Math.ceil((resetAt - this.now()) / 1000)));
    }
    attempt.count += 1;
    this.globalAttempts.count += 1;
  }
  async login(username: string, password: string, ip: string): Promise<{ user: string; cookie: string }> {
    this.consumeAttempt(ip);
    this.inFlight += 1;
    let valid = false;
    try {
      const key = await derive(password, this.password.salt);
      // Always derive a password key, including when the username is unknown.
      valid = timingSafeEqual(key, this.password.key) && constantEqual(username, this.config.username);
    } finally { this.inFlight -= 1; }
    if (!valid) throw new AuthError(401, '用户名或密码不正确');
    const token = randomBytes(32).toString('base64url');
    // An application restart deliberately invalidates sessions. At most 256 active sessions.
    if (this.sessions.size >= 256) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(this.sessionKey(token), { user: this.config.username, expiresAt: this.now() + SESSION_TTL_MS });
    return { user: this.config.username, cookie: `${COOKIE_NAME}=${token}.${this.sign(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}` };
  }
  private tokenFromCookie(header?: string): string | null {
    if (!header || header.length > 8192) return null;
    const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE_NAME}=`));
    if (matches.length !== 1) return null;
    const value = matches[0]!.slice(COOKIE_NAME.length + 1);
    const [token, signature, extra] = value.split('.');
    if (extra !== undefined || !token || !signature || !/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
    if (!constantEqual(signature, this.sign(token))) return null;
    return token;
  }
  user(header?: string): string | null {
    this.prune();
    const token = this.tokenFromCookie(header);
    if (!token) return null;
    return this.sessions.get(this.sessionKey(token))?.user ?? null;
  }
  logout(header?: string): string {
    const token = this.tokenFromCookie(header);
    if (token) this.sessions.delete(this.sessionKey(token));
    return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
  }
  close() { this.sessions.clear(); this.attempts.clear(); }
}
