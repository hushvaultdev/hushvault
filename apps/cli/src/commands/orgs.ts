import { Command } from 'commander'
import chalk from 'chalk'
import { ApiError, friendlyError, type ApiClient, type OrgRow } from '../api.js'
import {
  getRefreshToken,
  storeRefreshToken,
  storeToken,
  KeychainUnavailableError,
} from '../config/auth.js'
import { findProjectConfig, getGlobalConfig, saveGlobalConfig } from '../config/project.js'
import { createAuthedClient, resolveApiUrl } from '../lib/context.js'

/**
 * `hushvault orgs ...`: list the organisations you belong to and switch between them.
 *
 * A token names exactly one organisation and switching rotates the refresh family, so after a
 * successful switch the server has already revoked the old refresh token. The keychain overwrite
 * is therefore the LAST step, and a failed write tells the user to run `login` again rather than
 * silently leaving a dead family stored. Member and invitation management is deliberately NOT here:
 * it stays dashboard-only (see issue #97).
 */

export type Out = (line: string) => void

export interface OrgsOptions {
  json?: boolean | undefined
}

/** Strip control characters from values that came over the wire. */
function safe(s: unknown): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 200)
}

interface OrgView {
  id: string
  name: string
  slug: string
  plan: string
  role: string
  current: boolean
}

function viewOrg(o: OrgRow): OrgView {
  return {
    id: safe(o.id),
    name: safe(o.name),
    slug: safe(o.slug),
    plan: safe(o.plan),
    role: safe(o.role),
    current: o.current === true,
  }
}

/**
 * Resolve an org id or slug (case-insensitive; name also accepted) against the caller's
 * memberships. A miss means the caller is not a member, so the message says exactly that.
 */
export function resolveOrg(orgs: OrgRow[], input: string): OrgRow {
  const lower = input.toLowerCase()
  const found =
    orgs.find((o) => o.id === input) ??
    orgs.find((o) => o.slug.toLowerCase() === lower) ??
    orgs.find((o) => o.name.toLowerCase() === lower)
  if (!found) {
    const slugs = orgs.map((o) => o.slug).join(', ') || '(none)'
    throw new Error(`You are not a member of the organisation "${safe(input)}". Organisations you belong to: ${slugs}.`)
  }
  return found
}

const dump = (v: unknown, out: Out): void => out(JSON.stringify(v, null, 2))

export async function orgsListAction(client: ApiClient, opts: OrgsOptions, out: Out): Promise<void> {
  const orgs = (await client.listOrgs()).map(viewOrg)
  if (opts.json) {
    dump(orgs, out)
    return
  }
  if (orgs.length === 0) {
    out('You do not belong to any organisation.')
    return
  }
  for (const o of orgs) {
    const marker = o.current ? chalk.green('* ') : '  '
    out(`${marker}${o.name}  (${o.slug})  role: ${o.role}  plan: ${o.plan}${o.current ? '  [current]' : ''}`)
  }
  out('')
  out(chalk.gray('* marks the organisation your credential acts in. Switch with `hushvault orgs use <id|slug>`.'))
}

/**
 * Switch the stored session to another organisation.
 *
 * Order is load-bearing: the server rotates the refresh family during the switch, so the OLD
 * refresh token is dead once `switchOrg` resolves. The keychain overwrite is the final step and is
 * all-or-nothing from the user's point of view — any failure is reported as "run `login` again",
 * because the only correct recovery once the family is rotated is a fresh login.
 */
export async function orgsUseAction(client: ApiClient, input: string, opts: OrgsOptions, out: Out): Promise<void> {
  const orgs = await client.listOrgs()
  const target = resolveOrg(orgs, input)

  if (target.current) {
    if (opts.json) dump({ switched: false, org: viewOrg(target) }, out)
    else out(`Already acting in ${safe(target.name)} (${safe(target.slug)}).`)
    return
  }

  // A switch needs an interactive session: the refresh token lives only in the keychain, and an
  // API key (HUSHVAULT_TOKEN) is pinned to one organisation and cannot switch.
  const stored = await getRefreshToken()
  if (!stored) {
    throw new Error(
      'Switching organisations needs an interactive login (not HUSHVAULT_TOKEN). Run `hushvault login` first.',
    )
  }

  // The server revokes the old refresh family here; from now on only the returned session is valid.
  const session = await client.switchOrg(target.id, stored.refreshToken)
  if (!session.refreshToken) {
    // The old family is already gone and we did not receive a new one — only a fresh login recovers.
    throw new Error(
      'The server switched organisations but returned no new session token. Run `hushvault login` again.',
    )
  }

  // LAST step: overwrite the keychain. Refresh token (the long-lived family) first, then the access
  // token. If either write fails, the stored family may be dead, so say so plainly.
  try {
    await storeRefreshToken(stored.email, session.refreshToken)
    await storeToken(stored.email, session.token)
  } catch {
    throw new Error(
      `Switched to ${safe(target.name)} on the server, but could not save the new session to the OS keychain. ` +
        'Your previous session has been revoked — run `hushvault login` again.',
    )
  }

  const existing = await getGlobalConfig()
  await saveGlobalConfig({ ...existing, currentUser: stored.email, currentOrg: safe(target.name) })

  if (opts.json) dump({ switched: true, org: viewOrg({ ...target, current: true }) }, out)
  else out(chalk.green(`✓ Now acting in ${safe(target.name)} (${safe(target.slug)}), role: ${safe(target.role)}.`))
}

/** Map an org-command error to a short message. NOT_A_MEMBER is given its own plain line. */
export function reportOrgsError(err: unknown): void {
  if (err instanceof ApiError && (err.code === 'NOT_A_MEMBER' || err.status === 403)) {
    console.error(chalk.red('✗ You are not a member of that organisation.'))
    return
  }
  console.error(chalk.red('✗ ' + (err instanceof Error ? err.message : friendlyError(err, 'Organisations'))))
  if (err instanceof KeychainUnavailableError) {
    console.error(chalk.gray('  Run `hushvault login` again to re-establish a session.'))
  }
}

async function exec(fn: (client: ApiClient, out: Out) => Promise<void>): Promise<void> {
  const out: Out = (l) => console.log(l)
  try {
    const found = await findProjectConfig()
    const apiUrl = await resolveApiUrl(undefined, found?.config.apiUrl)
    const client = await createAuthedClient(apiUrl)
    await fn(client, out)
  } catch (err) {
    reportOrgsError(err)
    process.exit(1)
  }
}

export const orgsCommand = new Command('orgs').description('List and switch the organisation your credential acts in')

orgsCommand
  .command('list', { isDefault: true })
  .description('List the organisations you belong to (marks the current one)')
  .option('--json', 'Machine-readable output')
  .action((o: OrgsOptions) => exec((c, out) => orgsListAction(c, o, out)))

orgsCommand
  .command('use')
  .description('Switch the stored session to another organisation')
  .argument('<org>', 'Organisation id or slug')
  .option('--json', 'Machine-readable output')
  .action((org: string, o: OrgsOptions) => exec((c, out) => orgsUseAction(c, org, o, out)))
