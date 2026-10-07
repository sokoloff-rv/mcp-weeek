import { UserError } from '../errors.ts';
import type { Ref } from '../resolve.ts';

type Options = { required?: boolean };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export type DateValue = { kind: 'date'; value: string } | { kind: 'dateTime'; value: string } | { kind: 'clear' };

export class Args {
  readonly #tool: string;
  readonly #raw: Record<string, unknown>;

  constructor(tool: string, raw: Record<string, unknown>, allowed: readonly string[]) {
    this.#tool = tool;
    this.#raw = raw;
    const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
      throw new UserError(
        `Unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.map((key) => `"${key}"`).join(', ')} for ${tool}. Allowed: ${allowed.join(', ') || 'none'}.`,
      );
    }
  }

  has(name: string): boolean {
    return this.#raw[name] !== undefined;
  }

  string(name: string, options: Options & { required: true }): string;
  string(name: string, options?: Options): string | undefined;
  string(name: string, options: Options = {}): string | undefined {
    const value = this.#raw[name];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      return this.#missing(name, options);
    }
    if (typeof value !== 'string') throw this.#invalid(name, 'must be a string');
    return value;
  }

  id(name: string, options: Options & { required: true }): number;
  id(name: string, options?: Options): number | undefined;
  id(name: string, options: Options = {}): number | undefined {
    const value = this.#raw[name];
    if (value === undefined || value === null || value === '') return this.#missing(name, options);
    const number = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) throw this.#invalid(name, 'must be a positive integer id');
    return number;
  }

  ref(name: string, options: Options & { required: true }): Ref;
  ref(name: string, options?: Options): Ref | undefined;
  ref(name: string, options: Options = {}): Ref | undefined {
    const value = this.#raw[name];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return this.#missing(name, options);
    if (typeof value === 'number' || typeof value === 'string') return typeof value === 'string' ? value.trim() : value;
    throw this.#invalid(name, 'must be a name, alias or id');
  }

  boolean(name: string): boolean | undefined {
    const value = this.#raw[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
    throw this.#invalid(name, 'must be true or false');
  }

  refs(name: string): Ref[] | undefined {
    const value = this.#raw[name];
    if (value === undefined || value === null) return undefined;
    const list = Array.isArray(value) ? value : [value];
    if (!list.every((item) => (typeof item === 'string' && item.trim() !== '') || typeof item === 'number')) {
      throw this.#invalid(name, 'must be a list of names or ids');
    }
    return list.map((item: string | number) => (typeof item === 'string' ? item.trim() : item));
  }

  strings(name: string, options: Options = {}): string[] | undefined {
    const list = this.refs(name);
    if (list === undefined || list.length === 0) return this.#missing(name, options);
    return list.map(String);
  }

  oneOf<T extends string>(name: string, values: readonly T[]): T | undefined {
    const value = this.string(name);
    if (value === undefined) return undefined;
    const normalized = value.trim().toLowerCase();
    const match = values.find((candidate) => candidate === normalized);
    if (!match) throw this.#invalid(name, `must be one of: ${values.join(', ')}`);
    return match;
  }

  date(name: string): DateValue | undefined {
    const value = this.#raw[name];
    if (value === undefined) return undefined;
    if (value === null || (typeof value === 'string' && value.trim() === '')) return { kind: 'clear' };
    if (typeof value !== 'string') throw this.#invalid(name, 'must be a date string');
    const text = value.trim();
    if (DATE.test(text) && isRealDate(text)) return { kind: 'date', value: text };
    if (DATE_TIME.test(text) && !Number.isNaN(Date.parse(text))) {
      return { kind: 'dateTime', value: new Date(text).toISOString().replace(/\.\d{3}Z$/, 'Z') };
    }
    throw this.#invalid(name, 'must be YYYY-MM-DD or an ISO date-time with a time zone, e.g. 2026-10-10T15:00:00+03:00');
  }

  #missing(name: string, options: Options): undefined {
    if (options.required) throw new UserError(`Parameter "${name}" is required for ${this.#tool}.`);
    return undefined;
  }

  #invalid(name: string, problem: string): UserError {
    return new UserError(`Parameter "${name}" ${problem} (${this.#tool}).`);
  }
}

function isRealDate(text: string): boolean {
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}
