import { signState } from '../../src/lib/oauth'
import { call, type TestEnv } from './env'

/** Drive GET /api/auth/github/callback with a real signed state. Returns the redirect Location. */
export async function githubCallback(env: TestEnv, opts: { state?: string } = {}) {
  env['GITHUB_CLIENT_ID'] = 'cid'
  env['GITHUB_CLIENT_SECRET'] = 'csecret'
  env['WEB_APP_URL'] = 'https://web.test'
  const state = opts.state ?? (await signState(env.JWT_SECRET))
  const res = await call(env, 'GET', `/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`)
  const location = res.headers.get('location') ?? ''
  const fragment = new URLSearchParams(location.split('#')[1] ?? '')
  return { status: res.status, location, fragment }
}
