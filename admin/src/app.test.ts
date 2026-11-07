import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, createApp, sign, verify, type AppDeps } from './app.js';

const SECRET = 's3cret-for-tests';
const NOW = 1_700_000_000_000;
const sec = () => Math.floor(NOW / 1000);

function setup(overrides: { githubEmail?: string | null; state?: string } = {}) {
  const instance = { state: 'stopped', describe: vi.fn(), start: vi.fn(), stop: vi.fn() };
  instance.describe.mockImplementation(async () => ({ state: instance.state }));
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('access_token')) return Response.json({ access_token: 'gh-token' });
    if (u.endsWith('/user/emails')) {
      const email = overrides.githubEmail === undefined ? 'john.josef@gmail.com' : overrides.githubEmail;
      return Response.json(email ? [{ email: 'other@x.com', primary: false, verified: true }, { email, primary: true, verified: true }] : []);
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  const deps: AppDeps = {
    config: {
      domain: 'admin.example.com',
      serverHost: 'game.example.com',
      githubClientId: 'cid',
      adminEmails: ['john.josef@gmail.com'],
    },
    secrets: async () => ({ sessionSecret: SECRET, githubClientSecret: 'ghsecret' }),
    instance,
    serverPassword: async () => 'hunter2',
    fetch: fetchMock as unknown as typeof fetch,
    now: () => NOW,
  };
  return { handle: createApp(deps), instance, fetchMock };
}

const ev = (method: string, path: string, extra: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 =>
  ({
    rawPath: path,
    headers: {},
    cookies: [],
    queryStringParameters: undefined,
    requestContext: { http: { method } },
    ...extra,
  }) as unknown as APIGatewayProxyEventV2;

const authed = (email = 'john.josef@gmail.com', exp = sec() + 600) => [`${SESSION_COOKIE}=${sign({ email, exp }, SECRET)}`];
const csrf = { 'x-requested-with': 'enshrouded-admin' };

describe('sign/verify', () => {
  it('round-trips and rejects tampering and expiry', () => {
    const t = sign({ a: 1, exp: sec() + 10 }, SECRET);
    expect(verify(t, SECRET, sec())).toMatchObject({ a: 1 });
    expect(verify(t, 'other', sec())).toBeNull();
    expect(verify(`${t}x`, SECRET, sec())).toBeNull();
    expect(verify(t, SECRET, sec() + 11)).toBeNull();
    expect(verify('garbage', SECRET, sec())).toBeNull();
    expect(verify(undefined, SECRET, sec())).toBeNull();
  });
});

describe('admin app', () => {
  it('serves the page publicly with a nonce CSP', async () => {
    const r = await setup().handle(ev('GET', '/'));
    expect(r.statusCode).toBe(200);
    expect((r.headers as Record<string, string>)['content-security-policy']).toMatch(/nonce-/);
  });

  it('requires a session for every API route', async () => {
    const { handle } = setup();
    for (const [m, p] of [['GET', '/api/status'], ['GET', '/api/password'], ['POST', '/api/start'], ['POST', '/api/stop']]) {
      expect((await handle(ev(m!, p!, { headers: csrf }))).statusCode).toBe(401);
    }
  });

  it('rejects a valid cookie for an email that was removed from the allow-list', async () => {
    const r = await setup().handle(ev('GET', '/api/status', { cookies: authed('removed@x.com') }));
    expect(r.statusCode).toBe(401);
  });

  it('reports status and reveals the password to admins only', async () => {
    const { handle } = setup();
    const s = await handle(ev('GET', '/api/status', { cookies: authed() }));
    expect(JSON.parse(s.body as string)).toEqual({ state: 'stopped', address: 'game.example.com:15637' });
    const p = await handle(ev('GET', '/api/password', { cookies: authed() }));
    expect(JSON.parse(p.body as string)).toEqual({ password: 'hunter2' });
  });

  it('starts only a stopped server and stops only a running one', async () => {
    const { handle, instance } = setup();
    await handle(ev('POST', '/api/start', { cookies: authed(), headers: csrf }));
    expect(instance.start).toHaveBeenCalledTimes(1);
    await handle(ev('POST', '/api/stop', { cookies: authed(), headers: csrf }));
    expect(instance.stop).not.toHaveBeenCalled();
    instance.state = 'running';
    await handle(ev('POST', '/api/start', { cookies: authed(), headers: csrf }));
    expect(instance.start).toHaveBeenCalledTimes(1);
    await handle(ev('POST', '/api/stop', { cookies: authed(), headers: csrf }));
    expect(instance.stop).toHaveBeenCalledTimes(1);
  });

  it('rejects state changes without the CSRF header or from another origin', async () => {
    const { handle, instance } = setup();
    expect((await handle(ev('POST', '/api/start', { cookies: authed() }))).statusCode).toBe(403);
    const r = await handle(ev('POST', '/api/start', { cookies: authed(), headers: { ...csrf, origin: 'https://evil.example' } }));
    expect(r.statusCode).toBe(403);
    expect(instance.start).not.toHaveBeenCalled();
  });

  describe('GitHub sign-in', () => {
    const begin = async (h: ReturnType<typeof setup>['handle']) => {
      const r = await h(ev('GET', '/api/auth/github'));
      const state = new URL(r.headers!.location as string).searchParams.get('state')!;
      return { state, stateCookie: r.cookies![0]!.split(';')[0]! };
    };

    it('redirects to GitHub asking only for email scope', async () => {
      const r = await setup().handle(ev('GET', '/api/auth/github'));
      const u = new URL(r.headers!.location as string);
      expect(u.origin + u.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(u.searchParams.get('scope')).toBe('user:email');
      expect(u.searchParams.get('redirect_uri')).toBe('https://admin.example.com/api/auth/github/callback');
    });

    it('signs in an allow-listed verified primary email', async () => {
      const { handle } = setup();
      const { state, stateCookie } = await begin(handle);
      const r = await handle(ev('GET', '/api/auth/github/callback', { queryStringParameters: { code: 'c', state }, cookies: [stateCookie] }));
      expect(r.statusCode).toBe(302);
      expect(r.cookies!.some((c) => c.startsWith(`${SESSION_COOKIE}=`) && c.includes('HttpOnly') && c.includes('Secure'))).toBe(true);
    });

    it('denies an email that is not on the list', async () => {
      const { handle } = setup({ githubEmail: 'stranger@x.com' });
      const { state, stateCookie } = await begin(handle);
      const r = await handle(ev('GET', '/api/auth/github/callback', { queryStringParameters: { code: 'c', state }, cookies: [stateCookie] }));
      expect(r.statusCode).toBe(403);
      expect(r.cookies!.some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.includes('Max-Age=0'))).toBe(false);
    });

    it('denies a callback whose state does not match or has no state cookie', async () => {
      const { handle } = setup();
      const { stateCookie } = await begin(handle);
      const wrong = await handle(ev('GET', '/api/auth/github/callback', { queryStringParameters: { code: 'c', state: 'nope' }, cookies: [stateCookie] }));
      expect(wrong.statusCode).toBe(403);
      const none = await handle(ev('GET', '/api/auth/github/callback', { queryStringParameters: { code: 'c', state: 'nope' } }));
      expect(none.statusCode).toBe(403);
    });
  });
});
