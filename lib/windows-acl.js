import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const command = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$item = Get-Item -LiteralPath $env:DSH_ACL_TARGET
$acl = Get-Acl -LiteralPath $item.FullName
[pscustomobject]@{
  path = $item.FullName
  owner = $acl.Owner
  inheritance_disabled = $acl.AreAccessRulesProtected
  rules = @($acl.Access | ForEach-Object {
    [pscustomobject]@{
      identity = $_.IdentityReference.Value
      type = $_.AccessControlType.ToString()
      rights = $_.FileSystemRights.ToString()
      inherited = $_.IsInherited
    }
  })
} | ConvertTo-Json -Depth 5
`

// The fixed query only reads a descriptor; it does not infer effective access.
export async function inspectWindowsAcl(path, { executeFile = execute } = {}) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new TypeError('An ACL target path is required')
  let stdout
  try {
    ;({ stdout } = await executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, DSH_ACL_TARGET: path }, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    }))
  } catch (cause) {
    const reason = cause.killed ? 'TIMEOUT' : /^[A-Z_]+$/.test(String(cause.code)) ? cause.code : 'PROCESS_FAILED'
    throw Object.assign(new Error(`Windows ACL diagnostic unavailable (${reason})`), { code: 'ACL_DIAGNOSTIC_UNAVAILABLE' })
  }
  try {
    const result = JSON.parse(stdout.replace(/^\uFEFF/, ''))
    if (!result || typeof result.path !== 'string' || typeof result.owner !== 'string'
      || typeof result.inheritance_disabled !== 'boolean' || !Array.isArray(result.rules)
      || result.rules.some(rule => !rule || typeof rule.identity !== 'string' || typeof rule.type !== 'string'
        || typeof rule.rights !== 'string' || typeof rule.inherited !== 'boolean')) throw new Error('Invalid ACL shape')
    return result
  } catch { throw Object.assign(new Error('Windows ACL diagnostic returned invalid JSON data'), { code: 'ACL_INVALID_RESPONSE' }) }
}
