import { v7 as uuidv7 } from 'uuid';

/** Time-ordered UUID (RFC 9562 v7) — keeps InnoDB primary-key inserts sequential. */
export function newId(): string {
  return uuidv7();
}
