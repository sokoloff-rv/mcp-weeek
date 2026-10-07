export type JsonSchema = { [key: string]: unknown };

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type ToolCallContext = {
  signal: AbortSignal;
};

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>, context: ToolCallContext) => Promise<string>;
};
