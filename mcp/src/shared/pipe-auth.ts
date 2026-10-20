import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Private pipe protocol v2. A connector never sends its bearer credential to
// an endpoint before proving that the endpoint knows the paired secret.
export const PIPE_PROTOCOL = 2;
export const isNonce = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const keyId = (tokenHash: string): string => tokenHash.slice(0, 24);
export function tokenHash(token: string): string {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) throw new Error('invalid_pairing_credential');
  return createHash('sha256').update(token).digest('hex');
}
export function proof(hash: string, role: 'server' | 'client' | 'accepted', clientNonce: string, serverNonce: string, epoch: string): string {
  return createHmac('sha256', Buffer.from(hash, 'hex')).update(JSON.stringify(['umouse-pipe-v2', role, clientNonce, serverNonce, epoch])).digest('hex');
}
export function validProof(actual: unknown, expected: string): boolean {
  return isNonce(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
