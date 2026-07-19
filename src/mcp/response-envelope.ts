export interface McpTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface McpResponseEnvelope<T extends Record<string, unknown>> {
  readonly structuredContent: T;
  readonly content: readonly McpTextContent[];
}

const renderStructuredContent = (structuredContent: Record<string, unknown>): string => {
  const disclosure = typeof structuredContent.disclosure === "string"
    ? `${structuredContent.disclosure}\n`
    : "";
  return `${disclosure}${JSON.stringify(structuredContent, null, 2)}`;
};

export const createResponseEnvelope = <T extends Record<string, unknown>>(
  structuredContent: T
): McpResponseEnvelope<T> => Object.freeze({
  structuredContent,
  content: Object.freeze([{ type: "text" as const, text: renderStructuredContent(structuredContent) }])
});
