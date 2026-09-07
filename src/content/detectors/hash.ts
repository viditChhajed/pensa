/**
 * FNV-1a 64-bit, hex-padded to 64 chars so it satisfies the Sha256 schema shape.
 *
 * Why not real SHA-256: WebCrypto's digest is async, and the detectors are synchronous pure
 * functions by contract (that is what lets them run in Node against a serialized DOM). The
 * hash is used for deduplication and for keeping raw text out of the persisted record — not
 * for any security property — so a fast non-cryptographic hash is the right tool. If this
 * ever needs to resist preimage attacks, it must move to WebCrypto and the detector
 * contract has to become async.
 */
export function createHash(input: string): string {
  let h1 = 0xcbf29ce4n;
  let h2 = 0x84222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    const c = BigInt(input.charCodeAt(i));
    h1 = ((h1 ^ c) * prime) & mask;
    h2 = ((h2 ^ (c + 0x9e37n)) * prime) & mask;
  }
  const a = h1.toString(16).padStart(16, "0");
  const b = h2.toString(16).padStart(16, "0");
  return (a + b + a + b).slice(0, 64);
}
