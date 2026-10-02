import { call, type TestEnv } from './env'

function configure(env: TestEnv) {
  env['GITHUB_CLIENT_ID'] = 'cid'
  env['GITHUB_CLIENT_SECRET'] = 'csecret'
  env['WEB_APP_URL'] = 'https://web.test'
}

/** Begin a flow like a browser would: returns the state sent to the provider and the cookie jar value. */
export async function beginGithub(env: TestEnv) {
  configure(env)
  const res = await call(env, 'GET', '/api/auth/github')
  const authorize = new URL(res.headers.get('location') ?? '')
  const setCookie = res.headers.get('set-cookie') ?? ''
  return {
    status: res.status,
    authorize,
    state: authorize.searchParams.get('state') ?? '',
    cookie: setCookie.split(';')[0] ?? '',
    setCookie,
  }
}

/** Drive GET /api/auth/github/callback. By default completes a genuine flow in the same "browser". */
export async function githubCallback(env: TestEnv, opts: { state?: string; cookie?: string | null } = {}) {
  configure(env)
  const begun = await beginGithub(env)
  const state = opts.state ?? begun.state
  const cookie = opts.cookie === undefined ? begun.cookie : opts.cookie
  const res = await call(env, 'GET', `/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
    headers: cookie ? { cookie } : {},
  })
  const location = res.headers.get('location') ?? ''
  const fragment = new URLSearchParams(location.split('#')[1] ?? '')
  return { status: res.status, location, fragment, setCookie: res.headers.get('set-cookie') ?? '' }
}
