// Minimal ambient types for the subset of libsodium-wrappers used by the GitHub secret-sealing helper
// (apps/api/src/integrations/providers/github-seal.ts). The DefinitelyTyped @types/libsodium-wrappers package is,
// at the version matching libsodium-wrappers 0.7.x, an empty stub, so the few symbols we call are declared here.
declare module 'libsodium-wrappers' {
  interface Sodium {
    ready: Promise<void>
    crypto_box_PUBLICKEYBYTES: number
    base64_variants: { ORIGINAL: number; readonly [variant: string]: number }
    from_base64(input: string, variant?: number): Uint8Array
    to_base64(input: Uint8Array, variant?: number): string
    from_string(input: string): Uint8Array
    to_string(input: Uint8Array): string
    crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array
    crypto_box_seal_open(ciphertext: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array
    crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string }
  }
  const sodium: Sodium
  export default sodium
}
