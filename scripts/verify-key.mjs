
#!/usr/bin/env node
// Offline verifier: proves a backed-up key matches production's encryption_keys.check_value.
// Nothing is printed except pass/fail. No key material is logged.

const KEY = process.env.PROD_KEY || ''
const CHECK = process.env.CHECK_VALUE || ''
const EXPECTED = 'hushvault-key-check-v1'

if (!KEY || !CHECK) {
  console.error('Usage: PROD_KEY=<base64-key> CHECK_VALUE=<iv:ct> node verify-key.mjs')
  process.exit(2)
}

const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'))
const [ivB64, ctB64] = CHECK.split(':')
if (!ivB64 || !ctB64) { console.error('FAIL: check_value is not in iv:ct form'); process.exit(1) }

const key = await crypto.subtle.importKey('raw', b64(KEY), { name: 'AES-GCM' }, false, ['decrypt'])
try {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(ivB64) }, key, b64(ctB64))
  const text = new TextDecoder().decode(pt)
  if (text === EXPECTED) { console.log('PASS — backed-up key IS the production master key.'); process.exit(0) }
  console.error('FAIL — key decrypts, but plaintext does not match canary.')
  process.exit(1)
} catch {
  console.error('FAIL — backed-up key does NOT decrypt production check_value.')
  console.error('       Either the key is wrong, or you copied the wrong check_value.')
  process.exit(1)
}

