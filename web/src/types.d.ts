// Shared TypeScript types for the SPA.
//
// Mirrors src/services/conversations.ts (server) for the toolCalls
// shape on persisted assistant messages. The Bubble component reads
// this directly from each message.

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  truncated: boolean;
  iteration: number;
}
