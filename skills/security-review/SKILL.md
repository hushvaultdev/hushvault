# Security Review Skill

Full security review of HushVault code changes.

## When to Use

Use `/security-review` before:
- Merging any PR that changes auth, encryption, or API access control
- Adding new API endpoints that handle secrets
- Shipping a new feature to production
- Quarterly security hygiene review

## Review Scope

### Authentication & Authorization
- [ ] JWT validation on all protected routes (check `requireAuth` middleware present)
- [ ] Token expiry set and enforced
- [ ] API keys hashed before storage (not plaintext in D1)
- [ ] Organisation/project scoping — user can only access their own resources
- [ ] Privilege escalation paths checked (can a free-tier user access Team features?)

### Input Validation
- [ ] All API endpoints use `zValidator` with Zod schemas
- [ ] String length limits on all text inputs (key names, values, descriptions)
- [ ] No user-controlled values passed to D1 raw SQL
- [ ] File upload size limits (if applicable)

### Cryptographic Security
Run `/crypto-audit` as a sub-task and include its output here.

### Secret Exposure
- [ ] No secret values in API error responses
- [ ] No secret values in `console.log` or `console.error`
- [ ] Audit log does not include secret values (only key names + actor)
- [ ] Share links: key only in URL fragment, never sent to server
- [ ] CLI: secrets not written to disk (only injected into child process env)

### Rate Limiting & Abuse
- [ ] Login endpoint has rate limiting (prevent brute force)
- [ ] Secret fetch endpoint has rate limiting
- [ ] Share link view count enforced atomically

### Dependencies
- [ ] `pnpm audit` — no high or critical vulnerabilities
- [ ] No unexpected network calls from Worker (no exfiltration risk)

### OWASP Top 10 (relevant items for a secrets API)
- [ ] A01 Broken Access Control — org/project isolation verified
- [ ] A02 Cryptographic Failures — envelope encryption correct
- [ ] A03 Injection — parameterized queries via Drizzle
- [ ] A05 Security Misconfiguration — no debug endpoints in prod
- [ ] A07 Auth Failures — JWT signing verified, no unsigned tokens accepted

## Output Format

```
SECURITY REVIEW — [date] — [PR/feature name]

PASS ✅ / FAIL ❌ / N/A for each checklist item above.

FINDINGS:
[CRITICAL] Description + file:line + recommended fix
[HIGH] ...
[MEDIUM] ...

VERDICT: APPROVE / NEEDS FIXES BEFORE MERGE
```
