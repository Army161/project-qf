import { createHash } from 'node:crypto';
export const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
