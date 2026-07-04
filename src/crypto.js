import { createPublicKey, verify } from 'node:crypto';

export function verifyEd25519Signature({ publicKeyJwk, message, signatureBase64 }) {
  try {
    const publicKey = createPublicKey({
      key: publicKeyJwk,
      format: 'jwk'
    });

    return verify(null, Buffer.from(message), publicKey, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
