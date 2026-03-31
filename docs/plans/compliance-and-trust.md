# Compliance & Trust

**Priority:** P3 — enterprise sales prerequisite
**Status:** Design approved, deferred until post-launch

---

## Cloudflare Compliance Inheritance

HushVault inherits these certifications from Cloudflare (document in enterprise questionnaires):
- SOC 2 Type II
- ISO 27001
- PCI DSS Level 1
- GDPR compliant infrastructure
- HIPAA-eligible (with BAA from Cloudflare)

HushVault's own controls cover: application-layer access control, encryption, audit logging, incident response.

---

## SOC 2 Readiness Checklist

**What we already have:**
- [x] Encryption at rest (AES-256-GCM, all secret values)
- [x] Encryption in transit (HTTPS enforced by Cloudflare)
- [x] Audit logging (see `audit-log-and-compliance.md`)
- [x] Access control (RBAC, JWT auth, API key scoping)
- [x] Incident response plan (see below)

**What still needs to be done:**
- [ ] Formal access review process (quarterly user access reviews)
- [ ] Vendor management policy (Stripe, Resend, Sentry — document what data they receive)
- [ ] Background check policy for team members with production access
- [ ] Penetration test (third-party, annual) — schedule for post-public-launch
- [ ] Risk assessment documentation
- [ ] Business continuity / disaster recovery plan

**Target:** SOC 2 Type I assessment at 12-month mark. Type II at 18 months.

---

## GDPR Compliance

**Data residency:** Cloudflare Workers run globally by default. For EU customers on Team/Enterprise:
- Use `smart_placement` in wrangler.toml to hint EU data centers
- Enterprise: dedicated Worker deployment in EU region

**Data deletion:** `DELETE /api/account` purges all user data:
1. All secrets deleted from KV (by org prefix)
2. All D1 rows deleted (cascade from organisations)
3. Stripe customer data deleted via Stripe API
4. Confirmation email sent
5. Account deletion logged in anonymized audit trail

**Data portability:** `GET /api/export` downloads all secret names + metadata (not values) as JSON/CSV. Values excluded — user has the values; we never store plaintext.

**DPA (Data Processing Agreement):** Template provided at `hushvault.dev/legal/dpa`. Enterprise customers can request signed DPA.

**GDPR retention:** Audit logs purged per plan tier. Email data (invitations, registration) purged 30 days after account deletion.

---

## Privacy Policy Commitments

Key claims to maintain in code and architecture:
- "We never store plaintext secret values" — enforced by envelope encryption; server never has the key
- "We never log secret values" — enforced by audit log metadata-only policy
- "Share links use zero-knowledge encryption" — server stores only ciphertext; key never reaches server

These are technical commitments — architecture must support them, not just policy.

---

## security.txt & Responsible Disclosure

`GET /.well-known/security.txt`:
```
Contact: security@hushvault.dev
Expires: 2027-03-31T00:00:00.000Z
Preferred-Languages: en
Policy: https://hushvault.dev/security/policy
Canonical: https://hushvault.dev/.well-known/security.txt
```

**Remediation SLAs:**
| Severity | Response | Fix |
|----------|----------|-----|
| Critical | 24 hours | 72 hours |
| High | 48 hours | 7 days |
| Medium | 5 business days | 30 days |
| Low | 2 weeks | Next release |

**Bug bounty:** Not at launch. Document as "coming soon" — announce via GitHub Security Advisories.

---

## Incident Response Plan

1. **Detection** — Sentry alert, CloudFlare health check failure, or user report to `security@`
2. **Assessment** — Severity triage within 2 hours: Is data exposed? Which tenants? How many secrets?
3. **Containment** — Revoke affected API keys, rotate master key if needed, block affected IPs via WAF
4. **Notification** — GDPR requires 72-hour notification to affected users (if data breach)
   - Email template ready at `apps/web/src/emails/security-incident.tsx`
   - Status page updated at `status.hushvault.dev`
5. **Recovery** — Restore from D1 Time Travel (30-day backup), re-encrypt if master key rotated
6. **Post-mortem** — Published on `hushvault.dev/blog` within 7 days (builds trust)

---

## Penetration Test Scope (Annual)

- API: all authenticated + unauthenticated endpoints
- Dashboard: XSS, CSRF, auth bypass
- CLI: credential storage, process injection via env
- Encryption: envelope encryption implementation review

Methodology: Black-box + grey-box (API schema provided).
Vendor: schedule with HackerOne PTaaS or independent firm post-launch.
