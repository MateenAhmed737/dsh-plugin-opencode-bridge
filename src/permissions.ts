/**
 * Permission policy, matching T3 Code's non-full-access policy
 * (packages/provider-opencode/src/server/adapter.ts, `openCodePermissionRules`,
 * Copyright (c) 2026 T3 Tools Inc., MIT License — see NOTICE.md), with one
 * deliberate difference: nothing is configured as `deny`.
 *
 * Why no `deny`: a `deny` rule in config makes OpenCode Zen's free tier answer
 * 403 `FreeTierError` (measured by the dsh-opencode-xdbridge author). So every
 * restricted permission is `ask`, and this plugin answers each ask itself —
 * with a `reject` reply (plus a message the model sees) unless the user allows it.
 */

export type PermissionAction = 'allow' | 'ask' | 'deny'
export interface PermissionRule {
  permission: string
  pattern: string
  action: PermissionAction
}

/** Always allowed, same list as T3 Code. */
export const ALWAYS_ALLOWED = ['question', 'read', 'glob', 'grep', 'lsp', 'todowrite', 'task', 'skill'] as const

/** Restricted: asked, then approved by the user or rejected. Same list as T3 Code. */
export const RESTRICTED = ['bash', 'edit', 'webfetch', 'websearch', 'codesearch', 'external_directory', 'doom_loop'] as const

/**
 * Session permission ruleset. OpenCode evaluates rules last-match-wins, so the
 * catch-all comes first and the specific rules after it.
 */
export function permissionRules(): PermissionRule[] {
  return [
    { permission: '*', pattern: '*', action: 'ask' },
    ...RESTRICTED.map((permission) => ({ permission, pattern: '*', action: 'ask' as const })),
    ...ALWAYS_ALLOWED.map((permission) => ({ permission, pattern: '*', action: 'allow' as const })),
    // Secrets in dotenv files stay behind an ask, like T3 Code.
    { permission: 'read', pattern: '*.env', action: 'ask' },
    { permission: 'read', pattern: '*.env.*', action: 'ask' },
    { permission: 'read', pattern: '*.env.example', action: 'allow' },
  ]
}

/** Same policy in OpenCode config form (`permission` key of opencode.json). */
export function permissionConfig(): Record<string, PermissionAction | Record<string, PermissionAction>> {
  const config: Record<string, PermissionAction | Record<string, PermissionAction>> = { '*': 'ask' }
  for (const permission of RESTRICTED) config[permission] = 'ask'
  for (const permission of ALWAYS_ALLOWED) config[permission] = 'allow'
  config.read = { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask', '*.env.example': 'allow' }
  return config
}

/**
 * Build `OPENCODE_CONFIG_CONTENT`: only the permission policy. If the user
 * already sets OPENCODE_CONFIG_CONTENT, keep it and override `permission` only.
 */
export function configContent(existing: string | undefined): string {
  let base: Record<string, unknown> = {}
  if (existing && existing.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>
    } catch {
      // Not JSON (OpenCode also accepts JSONC); do not guess. Use our policy alone.
    }
  }
  return JSON.stringify({ ...base, permission: permissionConfig() })
}

/** Message the model receives when a restricted tool is rejected. */
export function rejectionMessage(permission: string, reason: 'policy' | 'user' | 'unavailable' | 'cancelled'): string {
  const why = {
    policy: 'it is restricted by the DeepSeek Harness OpenCode bridge policy',
    user: 'the user rejected it',
    unavailable: 'no approval prompt was available, so the bridge rejected it',
    cancelled: 'the approval was cancelled',
  }[reason]
  return `Permission "${permission}" was not granted: ${why}. Do not retry this action; continue without it or tell the user what you would need.`
}

/** One-line human description of a permission request (for approval prompts and status text). */
export function describePermission(request: { permission: string; patterns?: readonly string[]; metadata?: Record<string, unknown> }): string {
  const metadata = request.metadata ?? {}
  const command = typeof metadata.command === 'string' ? metadata.command : undefined
  const file = typeof metadata.filepath === 'string' ? metadata.filepath : typeof metadata.filePath === 'string' ? metadata.filePath : undefined
  const url = typeof metadata.url === 'string' ? metadata.url : undefined
  const target = command ?? file ?? url ?? (request.patterns ?? []).filter((p) => p !== '*').join(', ')
  const clipped = target.length > 300 ? `${target.slice(0, 300)}…` : target
  return clipped ? `${request.permission}: ${clipped}` : request.permission
}
