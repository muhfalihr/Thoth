const CDP_TARGET_ID = /^[A-Za-z0-9._-]{1,128}$/;
const DEVTOOLS_TARGET_PATH = /^\/devtools\/(page|browser)\/([A-Za-z0-9._-]{1,128})$/;

export type CdpTargetKind = 'page' | 'browser';

export interface ParsedDevtoolsTargetPath {
  kind: CdpTargetKind;
  targetId: string;
}

export function isCdpTargetId(value: unknown): value is string {
  return typeof value === 'string' && CDP_TARGET_ID.test(value);
}

export function parseDevtoolsTargetPath(path: string): ParsedDevtoolsTargetPath | null {
  const match = DEVTOOLS_TARGET_PATH.exec(path);
  if (!match) return null;
  return { kind: match[1] as CdpTargetKind, targetId: match[2] };
}
