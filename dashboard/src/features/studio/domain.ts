import type { ContentSetImportRequest } from "@/api/control-plane";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Return the only legacy Content Set data permitted to cross the Studio boundary. */
export function buildContentSetImportRequest(content: unknown): ContentSetImportRequest {
  if (!isRecord(content)) return { main: {}, footage: [] };
  const mainSource = isRecord(content.main) ? content.main : {};
  const title = optionalString(mainSource.title);
  const description = optionalString(mainSource.description);
  const footage = Array.isArray(content.footage)
    ? content.footage.flatMap((item) => {
        if (!isRecord(item)) return [];
        const footageTitle = optionalString(item.title);
        if (!footageTitle) return [];
        const platform = optionalString(item.platform);
        return [{ title: footageTitle, ...(platform ? { platform } : {}) }];
      }).slice(0, 3)
    : [];
  return {
    main: { ...(title ? { title } : {}), ...(description ? { description } : {}) },
    footage,
  };
}
