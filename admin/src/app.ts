import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { renderPage } from './ui.js';

export interface InstanceInfo {
  state: string;
}

export interface AppDeps {
  config: {
    /** Admin site host, e.g. enshrouded-admin.bubbletech.io. */
    domain: string;
    /** Game hostname shown to players. */
    serverHost: string;
    githubClientId: string;
    /** Lowercase; matched against the account's verified primary GitHub email. */
    adminEmails: string[];
  };
  secrets(): Promise<{ sessionSecret: string; githubClientSecret: string }>;
  instance: { describe(): Promise<InstanceInfo>; start(): Promise<void>; stop(): Promise<void> };
  serverPassword(): Promise<string>;
  fetch: typeof fetch;
  now(): number;
}

export const SESSION_COOKIE = 'ea_session';
const STATE_COOKIE = 'ea_state';
const SESSION_SECONDS = 12 * 3600;
const STATE_SECONDS = 600;
const CSRF_HEADER = 'enshrouded-admin';

const mac = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url');

export function sign(payload: { exp: number } & Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

export function verify<T extends { exp: number }>(token: string | undefined, secret: string, nowSeconds: number): T | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(body, secret));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
    return typeof payload.exp === 'number' && payload.exp > nowSeconds ? payload : null;
  } catch {
    return null;
  }
}

const parseCookies = (event: APIGatewayProxyEventV2): Record<string, string> =>
  Object.fromEntries(
    (event.cookies ?? []).flatMap((c) => {
      const i = c.indexOf('=');
      return i > 0 ? [[c.slice(0, i).trim(), c.slice(i + 1).trim()] as const] : [];
    }),
  );

const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;

const baseHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { ...baseHeaders, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const redirect = (location: string, cookies: string[] = []): APIGatewayProxyStructuredResultV2 => ({
  statusCode: 302,
  headers: { ...baseHeaders, location },
  cookies,
});

function html(statusCode: number, nonce: string, body: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      ...baseHeaders,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    },
    body,
  };
}

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const redirectUri = `https://${config.domain}/api/auth/github/callback`;
  const nowSeconds = () => Math.floor(deps.now() / 1000);

  async function session(event: APIGatewayProxyEventV2): Promise<{ email: string } | null> {
    const token = parseCookies(event)[SESSION_COOKIE];
    if (!token) return null;
    const { sessionSecret } = await deps.secrets();
    const s = verify<{ email: string; exp: number }>(token, sessionSecret, nowSeconds());
    // Re-check the allow-list on every request so removing someone takes effect at once.
    return s && config.adminEmails.includes(s.email) ? { email: s.email } : null;
  }

  async function githubEmail(code: string): Promise<string | null> {
    const { githubClientSecret } = await deps.secrets();
    const timeout = () => AbortSignal.timeout(8000);
    const tokenRes = await deps.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.githubClientId,
        client_secret: githubClientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: timeout(),
    });
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) return null;
    const res = await deps.fetch('https://api.github.com/user/emails', {
      headers: {
        authorization: `Bearer ${access_token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'enshrouded-admin',
      },
      signal: timeout(),
    });
    if (!res.ok) return null;
    const emails = (await res.json()) as { email: string; primary: boolean; verified: boolean }[];
    return emails.find((e) => e.primary && e.verified)?.email.toLowerCase() ?? null;
  }

  return async function handle(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
    const method = event.requestContext.http.method;
    const path = event.rawPath;

    if (method === 'GET' && path === '/') {
      const nonce = randomBytes(16).toString('base64');
      return html(200, nonce, renderPage(nonce));
    }

    if (method === 'GET' && path === '/api/auth/github') {
      const { sessionSecret } = await deps.secrets();
      const state = randomBytes(16).toString('hex');
      const signed = sign({ state, exp: nowSeconds() + STATE_SECONDS }, sessionSecret);
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: config.githubClientId,
        redirect_uri: redirectUri,
        scope: 'user:email',
        state,
        allow_signup: 'false',
      }).toString();
      return redirect(url.toString(), [cookie(STATE_COOKIE, signed, STATE_SECONDS)]);
    }

    if (method === 'GET' && path === '/api/auth/github/callback') {
      const { sessionSecret } = await deps.secrets();
      const q = event.queryStringParameters ?? {};
      const saved = verify<{ state: string; exp: number }>(parseCookies(event)[STATE_COOKIE], sessionSecret, nowSeconds());
      const clear = cookie(STATE_COOKIE, '', 0);
      const denied = () => ({
        ...html(403, 'x', '<!doctype html><title>Not allowed</title><p>Not allowed. <a href="/">Back</a></p>'),
        cookies: [clear],
      });
      if (!saved || !q.code || !q.state || q.state !== saved.state) return denied();
      let email: string | null = null;
      try {
        email = await githubEmail(q.code);
      } catch {
        return denied();
      }
      if (!email || !config.adminEmails.includes(email)) return denied();
      const token = sign({ email, exp: nowSeconds() + SESSION_SECONDS }, sessionSecret);
      return redirect('/', [clear, cookie(SESSION_COOKIE, token, SESSION_SECONDS)]);
    }

    if (!path.startsWith('/api/')) return json(404, { error: 'not found' });

    const who = await session(event);
    if (!who) return json(401, { error: 'sign in required' });

    if (method === 'GET' && path === '/api/status') {
      const { state } = await deps.instance.describe();
      return json(200, { state, address: `${config.serverHost}:15637` });
    }

    if (method === 'GET' && path === '/api/password') {
      return json(200, { password: await deps.serverPassword() });
    }

    if (method === 'POST') {
      // SameSite=Lax already blocks cross-site POSTs; the header and Origin check are belt and braces.
      const origin = event.headers.origin;
      if (event.headers['x-requested-with'] !== CSRF_HEADER || (origin && origin !== `https://${config.domain}`)) {
        return json(403, { error: 'bad request origin' });
      }
      if (path === '/api/auth/logout') {
        return { ...json(200, { ok: true }), cookies: [cookie(SESSION_COOKIE, '', 0)] };
      }
      if (path === '/api/start' || path === '/api/stop') {
        const { state } = await deps.instance.describe();
        if (path === '/api/start') {
          if (state === 'stopped') await deps.instance.start();
        } else if (state === 'running') {
          await deps.instance.stop();
        }
        return json(202, { ok: true });
      }
    }

    return json(404, { error: 'not found' });
  };
}
