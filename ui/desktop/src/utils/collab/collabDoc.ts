/**
 * Yjs document model for a LAN collab session (requirement 14.3, 14.7).
 *
 * Each shared file is one `Y.Text`; annotations live in a `Y.Map` and are anchored to a line
 * with a `Y.RelativePosition`, so they stay aligned to the same line after edits. Text and
 * annotations are kept in two separate `Y.Doc`s so the host can sync them over two channels and
 * drop a read-only guest's text updates while still accepting their annotations.
 */
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';

export const FILES_MAP_KEY = 'files';
export const ANNOTATIONS_MAP_KEY = 'annotations';

export interface AnnotationAnchor {
  client: number;
  clock: number;
  assoc: number;
}

export interface CollabAnnotationRecord {
  id: string;
  fileId: string;
  author: string;
  content: string;
  anchor: AnnotationAnchor;
  createdAt: number;
}

export interface ResolvedAnnotation {
  id: string;
  fileId: string;
  author: string;
  content: string;
  /** Zero-based line number computed from the resolved anchor. */
  line: number;
  createdAt: number;
}

export interface CollabDocs {
  text: Y.Doc;
  annotations: Y.Doc;
}

export function createCollabDocs(): CollabDocs {
  const text = new Y.Doc();
  const annotations = new Y.Doc();
  text.getMap<Y.Text>(FILES_MAP_KEY);
  annotations.getMap<CollabAnnotationRecord>(ANNOTATIONS_MAP_KEY);
  return { text, annotations };
}

export function fileTexts(docs: CollabDocs): Y.Map<Y.Text> {
  return docs.text.getMap<Y.Text>(FILES_MAP_KEY);
}

export function fileIds(docs: CollabDocs): string[] {
  return [...fileTexts(docs).keys()];
}

export function getOrCreateFileText(docs: CollabDocs, fileId: string): Y.Text {
  const files = fileTexts(docs);
  let text = files.get(fileId);
  if (!text) {
    text = new Y.Text();
    files.set(fileId, text);
  }
  return text;
}

export function setFileText(docs: CollabDocs, fileId: string, content: string): void {
  const text = getOrCreateFileText(docs, fileId);
  docs.text.transact(() => {
    text.delete(0, text.length);
    text.insert(0, content);
  });
}

export function getFileText(docs: CollabDocs, fileId: string): string {
  return fileTexts(docs).get(fileId)?.toString() ?? '';
}

function lineStartIndex(text: string, line: number): number {
  let index = 0;
  for (let i = 0; i < line; i += 1) {
    const next = text.indexOf('\n', index);
    if (next === -1) {
      return text.length;
    }
    index = next + 1;
  }
  return index;
}

function lineOf(text: string, index: number): number {
  let line = 0;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

export function addAnnotation(
  docs: CollabDocs,
  fileId: string,
  author: string,
  content: string,
  line: number,
  id = randomUUID()
): string {
  const text = getOrCreateFileText(docs, fileId);
  const relative = Y.createRelativePositionFromTypeIndex(text, lineStartIndex(text.toString(), line), -1);
  const json = Y.relativePositionToJSON(relative) as { client: number; clock: number; assoc: number };
  const anchor: AnnotationAnchor = { client: json.client, clock: json.clock, assoc: json.assoc };
  docs.annotations.getMap<CollabAnnotationRecord>(ANNOTATIONS_MAP_KEY).set(id, {
    id,
    fileId,
    author,
    content,
    anchor,
    createdAt: Date.now(),
  });
  return id;
}

export function listAnnotationRecords(docs: CollabDocs): CollabAnnotationRecord[] {
  return [...docs.annotations.getMap<CollabAnnotationRecord>(ANNOTATIONS_MAP_KEY).values()];
}

export function listResolvedAnnotations(docs: CollabDocs, fileId: string): ResolvedAnnotation[] {
  const text = getFileText(docs, fileId);
  const resolved: ResolvedAnnotation[] = [];
  for (const record of listAnnotationRecords(docs)) {
    if (record.fileId !== fileId) {
      continue;
    }
    const relative = Y.createRelativePositionFromJSON({
      client: record.anchor.client,
      clock: record.anchor.clock,
      assoc: record.anchor.assoc,
    });
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, docs.text);
    resolved.push({
      id: record.id,
      fileId,
      author: record.author,
      content: record.content,
      line: absolute ? lineOf(text, absolute.index) : -1,
      createdAt: record.createdAt,
    });
  }
  return resolved.sort((a, b) => a.line - b.line || a.createdAt - b.createdAt);
}

export function encodeTextState(docs: CollabDocs): Uint8Array {
  return Y.encodeStateAsUpdate(docs.text);
}

export function encodeAnnotationState(docs: CollabDocs): Uint8Array {
  return Y.encodeStateAsUpdate(docs.annotations);
}

export function applyTextUpdate(docs: CollabDocs, update: Uint8Array): void {
  Y.applyUpdate(docs.text, update);
}

export function applyAnnotationUpdate(docs: CollabDocs, update: Uint8Array): void {
  Y.applyUpdate(docs.annotations, update);
}
