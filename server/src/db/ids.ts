import { v7 as uuidv7 } from "uuid";

// UUIDv7: time-ordered, index-friendly, globally unique.
export function newId(prefix: string): string {
  return `${prefix}_${uuidv7()}`;
}
