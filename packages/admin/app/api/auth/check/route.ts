/**
 * 供前端判断会话是否有效：校验 `admin_session` 的 HMAC 签名与过期（不再只看 cookie 是否存在）。
 */
import { cookies } from 'next/headers';
import { verifySessionToken } from '@/lib/auth';

export const dynamic = 'force-dynamic';

async function resolveAdminPassword(): Promise<string | undefined> {
  try {
    const { env } = await import('@opennextjs/cloudflare').then(m => m.getCloudflareContext());
    return env.ADMIN_PASSWORD;
  } catch {
    return process.env.ADMIN_PASSWORD;
  }
}

export async function GET() {
  try {
    const cookieStore = await cookies();
    const sessionToken = cookieStore.get('admin_session')?.value;
    const adminPassword = await resolveAdminPassword();

    const authenticated = await verifySessionToken(sessionToken, adminPassword);
    return Response.json({ authenticated });
  } catch (error) {
    console.error('Auth check error:', error);
    return Response.json(
      { authenticated: false },
      { status: 500 }
    );
  }
}
