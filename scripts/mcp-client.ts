import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };

export type ToolCallResult = { text: string; isError: boolean };

/** Минимальный MCP-клиент поверх stdio: для смоук-теста и живой проверки. */
export class StdioClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, Pending>();
  readonly stderr: string[] = [];
  #nextId = 1;

  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.#child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString('utf8')));
    createInterface({ input: this.#child.stdout }).on('line', (line) => this.#receive(line));
    this.#child.on('exit', () => {
      for (const pending of this.#pending.values()) pending.reject(new Error(`Server exited. stderr:\n${this.stderr.join('')}`));
      this.#pending.clear();
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'mcp-weeek-script', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return result;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const result = await this.request('tools/call', { name, arguments: args });
    const content = Array.isArray(result.content) ? (result.content as { type: string; text?: string }[]) : [];
    return { text: content.map((item) => item.text ?? '').join('\n'), isError: result.isError === true };
  }

  close(): Promise<number | null> {
    return new Promise((resolve) => {
      this.#child.once('exit', (code) => resolve(code));
      this.#child.stdin.end();
    });
  }

  #receive(line: string): void {
    let message: { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };
    try {
      message = JSON.parse(line);
    } catch {
      this.stderr.push(`non-JSON line on stdout: ${line}\n`);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result ?? {});
  }
}
