// One validation-failure shape for the whole API (issue #80).
//
// Routes that passed a hook answered `{ error: 'VALIDATION_ERROR', message }`, as
// .claude/rules/api-design.md requires. Routes that did not answered zValidator's default: a raw
// ZodError, which is a different contract for the same class of failure and exposes internal
// field paths and limits. (It does not echo the submitted value — that was checked — so this is
// contract drift, not a leak.) The hook was also copy-pasted into three route files.

export const validationHook = (
  result: { success: boolean; error?: { issues: { message: string }[] } },
  c: { json: (body: unknown, status: 400) => Response },
) => {
  if (!result.success) {
    return c.json({ error: 'VALIDATION_ERROR', message: result.error?.issues[0]?.message ?? 'Invalid request' }, 400)
  }
  return undefined
}
