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

interface AnchorId {
  client: number;
  clock: number;
}

/**
 * JSON form of a `Y.RelativePosition` (`Y.relativePositionToJSON`): `item` is the character the
 * anchor sits on; `type` / `tname` identify the text when the anchor sits at its end.
 */
export interface AnnotationAnchor {
  type?: AnchorId;
  tname?: string;
  item?: AnchorId;
  assoc?: number;
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

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Replaces a file's content with the smallest single edit: the shared prefix and suffix stay
 * untouched, so annotation anchors on unchanged lines keep pointing at their original characters.
 * Rewriting the whole text would delete every character and push all anchors to the end.
 */
export function setFileText(docs: CollabDocs, fileId: string, content: string): void {
  const text = getOrCreateFileText(docs, fileId);
  const current = text.toString();
  if (current === content) {
    return;
  }

  const maxPrefix = Math.min(current.length, content.length);
  let prefix = 0;
  while (prefix < maxPrefix && current.charCodeAt(prefix) === content.charCodeAt(prefix)) {
    prefix += 1;
  }
  // Never cut between the two halves of a surrogate pair.
  if (prefix > 0 && isHighSurrogate(current.charCodeAt(prefix - 1))) {
    prefix -= 1;
  }

  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    current.charCodeAt(current.length - 1 - suffix) === content.charCodeAt(content.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  if (suffix > 0 && isLowSurrogate(current.charCodeAt(current.length - suffix))) {
    suffix -= 1;
  }

  const deleteCount = current.length - prefix - suffix;
  const inserted = content.slice(prefix, content.length - suffix);
  docs.text.transact(() => {
    if (deleteCount > 0) {
      text.delete(prefix, deleteCount);
    }
    if (inserted) {
      text.insert(prefix, inserted);
    }
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
  // assoc 0 anchors to the first character of the line, so the anchor moves with that line
  // when lines are inserted or removed above it.
  const relative = Y.createRelativePositionFromTypeIndex(text, lineStartIndex(text.toString(), line), 0);
  const anchor = toAnchor(Y.relativePositionToJSON(relative) as AnnotationAnchor);
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

/** Copies the relative-position JSON into plain objects, dropping absent fields. */
function toAnchor(json: AnnotationAnchor): AnnotationAnchor {
  const anchor: AnnotationAnchor = {};
  if (json.type) anchor.type = { client: json.type.client, clock: json.type.clock };
  if (json.tname) anchor.tname = json.tname;
  if (json.item) anchor.item = { client: json.item.client, clock: json.item.clock };
  if (json.assoc !== undefined && json.assoc !== null) anchor.assoc = json.assoc;
  return anchor;
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
    const { anchor } = record;
    // An anchor with neither a character nor a text reference cannot be placed on any line.
    if (!anchor.item && !anchor.type && !anchor.tname) {
      resolved.push({
        id: record.id,
        fileId,
        author: record.author,
        content: record.content,
        line: -1,
        createdAt: record.createdAt,
      });
      continue;
    }
    const relative = Y.createRelativePositionFromJSON(anchor);
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
