interface RequestMetadataShape {
  metadata?: { user_id?: string };
}

export function extractSessionId(body: unknown): string | undefined {
  const shaped = body as RequestMetadataShape;
  const raw = shaped?.metadata?.user_id;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    return typeof parsed.session_id === "string" ? parsed.session_id : undefined;
  } catch {
    return undefined;
  }
}
