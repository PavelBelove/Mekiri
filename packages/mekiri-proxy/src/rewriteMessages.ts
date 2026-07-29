export interface RewriteMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RewriteRule {
  keepFromIndex: number;
  replacement: RewriteMessage[];
}
