/**
 * LAN collab service (requirement 14.1–14.8). The host runs a TLS WebSocket server on a
 * private subnet address (never a relay), advertises the session with mDNS (bonjour), and
 * issues single-use invite codes. Guests connect from the main process, verifying the host's
 * self-signed certificate fingerprint against the one the user checked. Text and annotations
 * sync as two separate yjs channels so the host can drop a read-only guest's text updates
 * while still accepting their annotations.
 *
 * This is deliberately not designed for exposure to the internet.
 */
import { EventEmitter } from 'node:events';
import { X509Certificate, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import os from 'node:os';
import https from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { Bonjour } from 'bonjour-service';
import selfsigned from 'selfsigned';
import {
  authorize,
  MANDATORY_EXCLUDE_PATTERNS,
  type CollabGuestRole,
} from './collabPolicy';
import { createInviteRegistry } from './inviteRegistry';
import {
  applyAnnotationUpdate,
  applyTextUpdate,
  createCollabDocs,
  encodeAnnotationState,
  encodeTextState,
  getFileText,
  setFileText,
  type CollabDocs,
} from './collabDoc';

export const COLLAB_SERVICE_TYPE = '_modelforge-collab._tcp';
export const HEARTBEAT_TIMEOUT_MS = 30_000;
export const APPROVAL_TIMEOUT_MS = 120_000;
export const WRITE_BACK_DEBOUNCE_MS = 2_000;

const TEXT_CHANNEL = 0;
const ANNOTATION_CHANNEL = 1;

export interface SharedFile {
  /** Project-relative path, also the share-set key and yjs file id. */
  path: string;
  content: string;
}

export interface GeneratedCertificate {
  cert: string;
  key: string;
  fingerprint: string;
}

export async function generateSelfSignedCertificate(): Promise<GeneratedCertificate> {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'modelforge-collab' }], {
    keySize: 2048,
    algorithm: 'sha256',
  });
  const cert = new X509Certificate(pems.cert);
  return { cert: pems.cert, key: pems.private, fingerprint: cert.fingerprint256.replace(/:/g, '').toLowerCase() };
}

/** SHA-256 fingerprint of a PEM certificate, in lowercase hex without separators. */
export function certificateFingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();
}

/** Colon-grouped fingerprint for display next to the invite code. */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,2}/g)?.join(':').toUpperCase() ?? fingerprint;
}

function isIpv4Private(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 0)
  );
}

function isIpv6Private(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('fe80:') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd')
  );
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return isIpv4Private(ip);
  }
  if (family === 6) {
    return isIpv6Private(ip);
  }
  return false;
}

export function listPrivateAddresses(): string[] {
  const result: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const iface of interfaces ?? []) {
      if (!iface.internal && isPrivateAddress(iface.address)) {
        result.push(iface.address);
      }
    }
  }
  return [...new Set(result)];
}

interface PendingJoin {
  guestId: string;
  displayName: string;
  socket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

export interface CollabMember {
  guestId: string;
  displayName: string;
  role: CollabGuestRole;
}

export interface JoinRequest {
  guestId: string;
  displayName: string;
}

export interface CollabHostEvents {
  'join-request': (request: JoinRequest) => void;
  'member-change': (members: CollabMember[]) => void;
  'session-ended': () => void;
  'edit-rejected': (guestId: string) => void;
}

export interface CollabHostOptions {
  files: SharedFile[];
  bindAddress?: string;
  port?: number;
  now?: () => number;
  heartbeatTimeoutMs?: number;
  approvalTimeoutMs?: number;
  certificate?: GeneratedCertificate;
  advertise?: boolean;
  randomInt?: (max: number) => number;
  writeBack?: (path: string, content: string) => Promise<void>;
  log?: (message: string) => void;
}

export interface CollabHost {
  readonly fingerprint: string;
  readonly inviteCode: string;
  readonly port: number;
  readonly bindAddress: string;
  approve: (guestId: string, role: CollabGuestRole) => void;
  reject: (guestId: string) => void;
  members: () => CollabMember[];
  getText: (path: string) => string;
  setFiles: (files: SharedFile[]) => void;
  endSession: () => Promise<void>;
  on: <K extends keyof CollabHostEvents>(event: K, listener: CollabHostEvents[K]) => void;
  close: () => Promise<void>;
}

const SHARE_EXCLUDE: readonly string[] = MANDATORY_EXCLUDE_PATTERNS;

export async function createCollabHost(options: CollabHostOptions): Promise<CollabHost> {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
  const certificate = options.certificate ?? (await generateSelfSignedCertificate());

  const events = new EventEmitter();
  const registry = createInviteRegistry({ randomInt: options.randomInt });
  const docs = createCollabDocs();
  let shareSet = new Set<string>(options.files.map((file) => file.path));
  for (const file of options.files) {
    setFileText(docs, file.path, file.content);
  }

  const pendingJoins = new Map<string, PendingJoin>();
  const members = new Map<string, CollabMember>();
  const sockets = new Map<string, WebSocket>();
  const lastSeen = new Map<string, number>();
  const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const inviteCode = registry.issue(now());

  const bindAddress = options.bindAddress ?? listPrivateAddresses()[0] ?? '127.0.0.1';

  const server = https.createServer({ cert: certificate.cert, key: certificate.key });
  const wss = new WebSocketServer({ server });
  let bonjour: Bonjour | null = null;

  const scheduleWriteBack = (path: string): void => {
    if (!options.writeBack) {
      return;
    }
    const existing = writeTimers.get(path);
    if (existing) {
      clearTimeout(existing);
    }
    writeTimers.set(
      path,
      setTimeout(() => {
        writeTimers.delete(path);
        void options.writeBack!(path, getFileText(docs, path));
      }, WRITE_BACK_DEBOUNCE_MS)
    );
  };

  const sendJson = (socket: WebSocket, payload: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const sendUpdate = (socket: WebSocket, channel: number, update: Uint8Array): void => {
    if (socket.readyState === WebSocket.OPEN) {
      const frame = new Uint8Array(update.length + 1);
      frame[0] = channel;
      frame.set(update, 1);
      socket.send(frame, { binary: true });
    }
  };

  const removeGuest = (guestId: string, reason: 'ended' | 'timeout' | 'left'): void => {
    const socket = sockets.get(guestId);
    sockets.delete(guestId);
    lastSeen.delete(guestId);
    members.delete(guestId);
    if (socket) {
      if (reason === 'ended') {
        sendJson(socket, { type: 'session-ended' });
      }
      socket.close();
    }
    registry.setGuestCount(members.size);
    events.emit('member-change', [...members.values()]);
  };

  const heartbeatTimer = setInterval(() => {
    const cutoff = now() - heartbeatTimeoutMs;
    for (const [guestId, seen] of [...lastSeen]) {
      if (seen < cutoff) {
        log(`guest ${guestId} heartbeat timeout`);
        removeGuest(guestId, 'timeout');
      }
    }
  }, Math.min(heartbeatTimeoutMs, 10_000));
  heartbeatTimer.unref?.();

  const rejectJoin = (socket: WebSocket, reason: string): void => {
    sendJson(socket, { type: 'rejected', reason });
    socket.close();
  };

  wss.on('connection', (socket, request) => {
    const remoteAddress = request.socket.remoteAddress ?? '';
    const remoteIp = remoteAddress.replace(/^::ffff:/, '');
    if (!isPrivateAddress(remoteIp)) {
      log(`rejected non-private peer ${remoteIp}`);
      socket.close();
      return;
    }

    // ws 8 hands text frames over as Buffers too, so `isBinary` tells updates from JSON.
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (!Buffer.isBuffer(raw)) {
          return;
        }
        const bytes = new Uint8Array(raw);
        const channel = bytes[0];
        const update = bytes.slice(1);
        const guestId = [...sockets].find(([, s]) => s === socket)?.[0];
        if (!guestId) {
          return;
        }
        const member = members.get(guestId);
        if (!member) {
          return;
        }
        if (channel === TEXT_CHANNEL) {
          if (member.role !== 'editable') {
            sendJson(socket, { type: 'edit-rejected' });
            events.emit('edit-rejected', guestId);
            return;
          }
          applyTextUpdate(docs, update);
          for (const [otherId, otherSocket] of sockets) {
            if (otherId !== guestId) {
              sendUpdate(otherSocket, TEXT_CHANNEL, update);
            }
          }
          for (const file of shareSet) {
            scheduleWriteBack(file);
          }
          return;
        }
        if (channel === ANNOTATION_CHANNEL) {
          applyAnnotationUpdate(docs, update);
          for (const [otherId, otherSocket] of sockets) {
            if (otherId !== guestId) {
              sendUpdate(otherSocket, ANNOTATION_CHANNEL, update);
            }
          }
          return;
        }
        return;
      }

      let message: { type: string } & Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.type === 'join') {
        const displayName = typeof message.displayName === 'string' ? message.displayName : '';
        const fingerprint = typeof message.fingerprint === 'string' ? message.fingerprint : '';
        if (fingerprint !== certificate.fingerprint) {
          rejectJoin(socket, '指纹不匹配');
          return;
        }
        const code = typeof message.inviteCode === 'string' ? message.inviteCode : '';
        const result = registry.redeem(code, now());
        if (result !== 'ok') {
          rejectJoin(socket, result);
          return;
        }
        const guestId = randomUUID();
        const pending: PendingJoin = {
          guestId,
          displayName,
          socket,
          timer: setTimeout(() => {
            pendingJoins.delete(guestId);
            rejectJoin(socket, 'timeout');
            registry.revoke(code);
          }, approvalTimeoutMs),
        };
        pending.timer.unref?.();
        pendingJoins.set(guestId, pending);
        events.emit('join-request', { guestId, displayName });
        return;
      }

      const guestId = [...sockets].find(([, s]) => s === socket)?.[0];
      if (!guestId) {
        return;
      }
      if (message.type === 'heartbeat') {
        lastSeen.set(guestId, now());
        return;
      }
      if (message.type === 'list-files') {
        const member = members.get(guestId);
        if (!member) {
          return;
        }
        const allowed = [...shareSet].filter(
          (path) => authorize({ kind: 'list', path }, member, shareSet, SHARE_EXCLUDE)
        );
        sendJson(socket, { type: 'file-list', files: allowed });
        return;
      }
    });

    socket.on('close', () => {
      const guestId = [...sockets].find(([, s]) => s === socket)?.[0];
      if (guestId) {
        removeGuest(guestId, 'left');
      }
    });
  });

  const promise = new Promise<CollabHost>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, bindAddress, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      if (options.advertise) {
        bonjour = new Bonjour();
        bonjour.publish({ name: 'ModelForge Collab', type: COLLAB_SERVICE_TYPE, port });
      }

      const host: CollabHost = {
        fingerprint: certificate.fingerprint,
        inviteCode,
        port,
        bindAddress,
        approve: (guestId, role) => {
          const pending = pendingJoins.get(guestId);
          if (!pending) {
            return;
          }
          pendingJoins.delete(guestId);
          clearTimeout(pending.timer);
          if (members.size >= 2) {
            rejectJoin(pending.socket, 'full');
            return;
          }
          members.set(guestId, { guestId, displayName: pending.displayName, role });
          sockets.set(guestId, pending.socket);
          lastSeen.set(guestId, now());
          registry.setGuestCount(members.size);
          sendJson(pending.socket, {
            type: 'approved',
            guestId,
            role,
            files: [...shareSet],
            fingerprint: certificate.fingerprint,
          });
          sendUpdate(pending.socket, TEXT_CHANNEL, encodeTextState(docs));
          sendUpdate(pending.socket, ANNOTATION_CHANNEL, encodeAnnotationState(docs));
          events.emit('member-change', [...members.values()]);
        },
        reject: (guestId) => {
          const pending = pendingJoins.get(guestId);
          if (!pending) {
            return;
          }
          pendingJoins.delete(guestId);
          clearTimeout(pending.timer);
          rejectJoin(pending.socket, 'rejected');
        },
        members: () => [...members.values()],
        getText: (path) => getFileText(docs, path),
        setFiles: (files) => {
          shareSet = new Set(files.map((file) => file.path));
          for (const file of files) {
            setFileText(docs, file.path, file.content);
          }
          const textUpdate = encodeTextState(docs);
          for (const socket of sockets.values()) {
            sendUpdate(socket, TEXT_CHANNEL, textUpdate);
          }
        },
        endSession: async () => {
          registry.revokeAll();
          for (const [guestId] of [...sockets]) {
            removeGuest(guestId, 'ended');
          }
          events.emit('session-ended');
        },
        on: (event, listener) => {
          events.on(event, listener);
        },
        close: async () => {
          clearInterval(heartbeatTimer);
          for (const timer of writeTimers.values()) {
            clearTimeout(timer);
          }
          for (const pending of pendingJoins.values()) {
            clearTimeout(pending.timer);
          }
          for (const socket of sockets.values()) {
            socket.close();
          }
          bonjour?.destroy();
          await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        },
      };
      resolve(host);
    });
  });

  return promise;
}

export interface CollabGuestEvents {
  approved: (payload: { role: CollabGuestRole; files: string[] }) => void;
  rejected: (reason: string) => void;
  'session-ended': () => void;
  'edit-rejected': () => void;
  'text-update': (update: Uint8Array) => void;
  'annotation-update': (update: Uint8Array) => void;
}

export interface CollabGuestOptions {
  address: string;
  port: number;
  fingerprint: string;
  inviteCode: string;
  displayName: string;
  log?: (message: string) => void;
}

export interface CollabGuest {
  docs: CollabDocs;
  readonly role: CollabGuestRole | null;
  sendTextUpdate: (update: Uint8Array) => void;
  sendAnnotationUpdate: (update: Uint8Array) => void;
  sendHeartbeat: () => void;
  on: <K extends keyof CollabGuestEvents>(event: K, listener: CollabGuestEvents[K]) => void;
  close: () => void;
}

export function connectCollabGuest(options: CollabGuestOptions): CollabGuest {
  const events = new EventEmitter();
  const docs = createCollabDocs();
  let role: CollabGuestRole | null = null;
  const url = `wss://${options.address}:${options.port}`;
  const socket = new WebSocket(url, { rejectUnauthorized: false });

  const sendJson = (payload: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const sendUpdate = (channel: number, update: Uint8Array): void => {
    if (socket.readyState === WebSocket.OPEN) {
      const frame = new Uint8Array(update.length + 1);
      frame[0] = channel;
      frame.set(update, 1);
      socket.send(frame, { binary: true });
    }
  };

  socket.on('open', () => {
    const peer = (
      socket as unknown as { _socket: { getPeerCertificate: () => { fingerprint256: string } } }
    )._socket.getPeerCertificate();
    const fingerprint = (peer.fingerprint256 ?? '').replace(/:/g, '').toLowerCase();
    if (fingerprint !== options.fingerprint) {
      events.emit('rejected', 'fingerprint');
      socket.close();
      return;
    }
    sendJson({
      type: 'join',
      inviteCode: options.inviteCode,
      displayName: options.displayName,
      fingerprint,
    });
  });

  // As on the host, text frames arrive as Buffers; only binary frames carry yjs updates.
  socket.on('message', (raw, isBinary) => {
    if (isBinary) {
      if (!Buffer.isBuffer(raw)) {
        return;
      }
      const bytes = new Uint8Array(raw);
      const channel = bytes[0];
      const update = bytes.slice(1);
      if (channel === TEXT_CHANNEL) {
        applyTextUpdate(docs, update);
        events.emit('text-update', update);
      } else {
        applyAnnotationUpdate(docs, update);
        events.emit('annotation-update', update);
      }
      return;
    }
    let message: { type: string } & Record<string, unknown>;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === 'approved') {
      role = (message.role as CollabGuestRole) ?? 'read-only';
      events.emit('approved', { role, files: (message.files as string[]) ?? [] });
    } else if (message.type === 'rejected') {
      events.emit('rejected', String(message.reason ?? 'rejected'));
    } else if (message.type === 'session-ended') {
      events.emit('session-ended');
    } else if (message.type === 'edit-rejected') {
      events.emit('edit-rejected');
    }
  });

  return {
    docs,
    get role() {
      return role;
    },
    sendTextUpdate: (update) => sendUpdate(TEXT_CHANNEL, update),
    sendAnnotationUpdate: (update) => sendUpdate(ANNOTATION_CHANNEL, update),
    sendHeartbeat: () => sendJson({ type: 'heartbeat' }),
    on: (event, listener) => {
      events.on(event, listener);
    },
    close: () => socket.close(),
  };
}
