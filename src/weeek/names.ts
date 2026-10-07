import type { Member } from './types.ts';

export function memberName(member: Member): string {
  const name = [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
  return name || member.email || member.id;
}

export function sameName(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

export function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
}
