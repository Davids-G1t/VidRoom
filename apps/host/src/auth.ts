import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 「启动地址换 Cookie」鉴权:
 * - 启动时生成一次性 launch token,控制台打印 /launch?token=... 地址;
 * - 用正确 token 访问 /launch → 发一个 session cookie(HttpOnly),token 立即作废;
 * - 之后 /api/* 只认这个 cookie。session 只存内存,Host 重启即全部失效。
 */

export const SESSION_COOKIE = 'vidroom_session';

function sameSecret(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class LaunchAuth {
  private launchToken: string | null = randomBytes(32).toString('hex');
  private readonly sessions = new Set<string>();

  /** 只在启动时取一次,用来拼启动地址 */
  get token(): string {
    if (this.launchToken === null) throw new Error('launch token already redeemed');
    return this.launchToken;
  }

  /** token 正确且未用过 → 返回新 session id;否则 null。无论成败,正确的 token 只能兑换一次。 */
  redeem(token: string | null): string | null {
    if (this.launchToken === null || token === null || !sameSecret(token, this.launchToken)) {
      return null;
    }
    this.launchToken = null;
    const session = randomBytes(32).toString('hex');
    this.sessions.add(session);
    return session;
  }

  isValidSession(session: string | undefined): boolean {
    if (!session) return false;
    for (const s of this.sessions) if (sameSecret(s, session)) return true;
    return false;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function sessionCookieHeader(session: string): string {
  return `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`;
}
