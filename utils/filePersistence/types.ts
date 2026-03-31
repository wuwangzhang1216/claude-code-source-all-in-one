export const DEFAULT_UPLOAD_CONCURRENCY = 5;
export const FILE_COUNT_LIMIT = 100;
export const OUTPUTS_SUBDIR = 'outputs';
export type FilesPersistedEventData = Record<string, unknown>;
export type PersistedFile = { path: string; content: string };
export type TurnStartTime = number;
export default {};
