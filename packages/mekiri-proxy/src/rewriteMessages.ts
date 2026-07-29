export interface RewriteMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RewriteRule {
  keepFromIndex: number;
  replacement: RewriteMessage[];
}

export function rewriteMessages(messages: unknown[], rule: RewriteRule | undefined): unknown[] {
  if (!rule) return messages;
  const kept = messages.slice(rule.keepFromIndex);
  return [...rule.replacement, ...kept];
}
