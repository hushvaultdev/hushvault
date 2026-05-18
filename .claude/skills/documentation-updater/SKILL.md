---
name: documentation-updater
description: Map code changes to documentation needing updates. Scans git diff to flag stale docs, checks counts and cross-references, and generates update checklists for docs in /docs/solutions/.
allowed-tools: Read, Grep, Glob, Bash
user-invocable: false
---

# Documentation Updater Skill

## Purpose

Ensure documentation stays synchronised with code changes across the Educ4te.website repository. This skill analyses git diffs, detects stale documentation, verifies counts and cross-references, and produces actionable update checklists.

This is an **agent-only skill**  it is invoked by other skills and agents (e.g., release-manager, sprint-planner) rather than directly by users.

---

## When This Skill Is Invoked

This skill should be triggered by agents in the following scenarios:

1. **Pre-merge review**  Before merging `dev` into `main`, verify all documentation reflects the code changes in the merge.
2. **Release preparation**  When a release-manager agent is assembling a release, run documentation checks as part of the release checklist.
3. **Sprint planning**  When a sprint-planner agent is reviewing outstanding work, flag stale documentation as technical debt items.
4. **Post-refactor audit**  After any significant refactoring, scan for documentation that references moved, renamed, or deleted files.
5. **Periodic health check**  Scheduled audits of documentation accuracy (counts, paths, cross-references).

---

## File-to-Documentation Mapping

The following table defines which code directories map to which documentation areas. When files in the **Code Path** column are modified, the corresponding **Documentation Area** must be checked for staleness.

| Code Path | Documentation Area | Key Docs |
|---|---|---|
| `admin-api/` | `/docs/solutions/admin/` | `ADMIN_API_REFERENCE.md` (endpoint count, route definitions) |
| `functions/` | `/docs/solutions/functions/` | `CLOUDFLARE_FUNCTIONS_INDEX.md` (function count, descriptions) |
| `src/data/blog-mdx/` | `/docs/solutions/blog/` | `BLOG_POSTS_README.md` (post counts, quarterly breakdown) |
| `src/data/courses/` | `/docs/solutions/courses/` | Course catalogue docs, Stripe sync docs |
| `src/data/pathways/` | `/docs/solutions/stripe/` | Pathway pricing, Stripe product IDs |
| `functions/create-checkout-session.js` | `/docs/solutions/stripe/` | Stripe integration docs (3 files) |
| `functions/stripe-webhook.js` | `/docs/solutions/stripe/` | Webhook handling documentation |
| `functions/newsletter-*.js` | `/docs/solutions/newsletter/` | Newsletter implementation docs (4 files) |
| `cloudflare-workers/elevenlabs-mcp/` | `/docs/solutions/elevenlabs/` | ElevenLabs MCP docs (7 files) |
| `.mcp.json` | `/docs/solutions/canva/`, `/docs/solutions/elevenlabs/` | MCP integration configuration |
| `src/components/Blog.jsx` | `/docs/solutions/blog/` | Category gradients, rendering logic |
| `src/pages/BlogArchive.jsx` | `/docs/solutions/blog/` | Archive page, category filtering |
| `scripts/lib/frontmatter-validator.js` | `/docs/VALIDATION_GUIDE.md` | Valid categories list (13 categories) |
| `vite.config.js` | `/docs/03-BUILD.md` | Build configuration, plugin list |
| `.claude/skills/*/SKILL.md` | `CLAUDE.md` | Skill count, skill descriptions |
| `marketing/campaigns/` | `/docs/solutions/campaigns/` | Campaign system documentation |
| `src/App.jsx` | `/docs/architecture/` | Route definitions, lazy loading |
| `.env.development.local` | `/docs/03-BUILD.md` | Environment variable documentation |

### Additional Mapping Rules

- **Any new `functions/*.js` file**  Update `/docs/solutions/functions/CLOUDFLARE_FUNCTIONS_INDEX.md` function count.
- **Any new `admin-api/routes/*.js` file**  Update `/docs/solutions/admin/ADMIN_API_REFERENCE.md` endpoint count.
- **Any new `.claude/skills/*/SKILL.md` file**  Update `CLAUDE.md` skill list and count references.
- **Any new `src/data/blog-mdx/YYYY-QX/*.mdx` file**  Update blog post counts in relevant docs.