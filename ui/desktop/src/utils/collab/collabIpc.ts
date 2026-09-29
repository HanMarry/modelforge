/**
 * IPC surface for LAN collab (requirement 14). The host session and guest connections all live
 * in the main process; the renderer drives them through `collab-*` handlers and receives state
 * changes over `collab-*` events. All error messages are masked via the credential store.
 */
import { BrowserWindow, type IpcMain } from 'electron';
import {
  connectCollabGuest,
  createCollabHost,
  formatFingerprint,
  type CollabGuest,
  type CollabHost,
  type CollabMember,
  type SharedFile,
} from './collabService';
import type { CollabGuestRole } from './collabPolicy';
import { describeError, toIpcError, type IpcResult } from '../ipcResult';
import { encodeTextState, fileIds, getFileText, setFileText } from './collabDoc';

export interface CollabIpcDeps {
  /** Resolves a project-relative path to the absolute path the host writes back to. */
  writeBack: (path: string, content: string) => Promise<void>;
  log?: (message: string) => void;
  secretValues?: () => string[];
}

export interface CollabHostState {
  port: number;
  bindAddress: string;
  inviteCode: string;
  fingerprint: string;
  fingerprintDisplay: string;
}

interface GuestHandle {
  guest: CollabGuest;
  displayName: string;
}

const guests = new Map<string, GuestHandle>();
let host: CollabHost | null = null;
let deps: CollabIpcDeps = { writeBack: async () => {} };

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

function guarded<T>(task: () => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  return task().catch((error) => ({
    ok: false as const,
    error: toIpcError('UNEXPECTED', describeError(error), deps.secretValues?.() ?? []),
  }));
}

export function registerCollabIpc(ipc: Pick<IpcMain, 'handle'>, options: CollabIpcDeps): void {
  deps = options;

  ipc.handle('collab-host-start', (_event, files: SharedFile[]) =>
    guarded(async (): Promise<IpcResult<CollabHostState>> => {
      if (host) {
        await host.endSession();
        await host.close();
        host = null;
      }
      const next = await createCollabHost({
        files: Array.isArray(files) ? files : [],
        writeBack: (path, content) => deps.writeBack(path, content),
        log: deps.log,
      });
      next.on('join-request', (request) => broadcast('collab-join-request', request));
      next.on('member-change', (members) => broadcast('collab-member-change', members));
      next.on('session-ended', () => broadcast('collab-session-ended', null));
      host = next;
      return {
        ok: true,
        data: {
          port: next.port,
          bindAddress: next.bindAddress,
          inviteCode: next.inviteCode,
          fingerprint: next.fingerprint,
          fingerprintDisplay: formatFingerprint(next.fingerprint),
        },
      };
    })
  );

  ipc.handle('collab-host-approve', (_event, guestId: string, role: CollabGuestRole) =>
    guarded(async (): Promise<IpcResult<null>> => {
      host?.approve(guestId, role);
      return { ok: true, data: null };
    })
  );

  ipc.handle('collab-host-reject', (_event, guestId: string) =>
    guarded(async (): Promise<IpcResult<null>> => {
      host?.reject(guestId);
      return { ok: true, data: null };
    })
  );

  ipc.handle('collab-host-members', () =>
    guarded(async (): Promise<IpcResult<CollabMember[]>> => ({
      ok: true,
      data: host?.members() ?? [],
    }))
  );

  ipc.handle('collab-host-stop', () =>
    guarded(async (): Promise<IpcResult<null>> => {
      if (host) {
        await host.endSession();
        await host.close();
        host = null;
      }
      return { ok: true, data: null };
    })
  );

  ipc.handle(
    'collab-guest-join',
    (_event, options: { address: string; port: number; fingerprint: string; inviteCode: string; displayName: string }) =>
      guarded(async (): Promise<IpcResult<{ guestId: string }>> => {
        const guest = connectCollabGuest({
          address: options.address,
          port: options.port,
          fingerprint: options.fingerprint,
          inviteCode: options.inviteCode,
          displayName: options.displayName,
        });
        const guestId = `guest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        guests.set(guestId, { guest, displayName: options.displayName });
        const forward = (type: string) => (payload: unknown) => broadcast('collab-guest-event', { guestId, type, payload });
        guest.on('approved', forward('approved'));
        guest.on('rejected', forward('rejected'));
        guest.on('session-ended', () => broadcast('collab-guest-event', { guestId, type: 'session-ended', payload: null }));
        guest.on('edit-rejected', () => broadcast('collab-guest-event', { guestId, type: 'edit-rejected', payload: null }));
        guest.on('text-update', forward('text-update'));
        guest.on('annotation-update', forward('annotation-update'));
        return { ok: true, data: { guestId } };
      })
  );

  ipc.handle('collab-guest-send-text', (_event, guestId: string, update: Uint8Array) =>
    guarded(async (): Promise<IpcResult<null>> => {
      guests.get(guestId)?.guest.sendTextUpdate(new Uint8Array(update));
      return { ok: true, data: null };
    })
  );

  ipc.handle('collab-guest-send-annotation', (_event, guestId: string, update: Uint8Array) =>
    guarded(async (): Promise<IpcResult<null>> => {
      guests.get(guestId)?.guest.sendAnnotationUpdate(new Uint8Array(update));
      return { ok: true, data: null };
    })
  );

  ipc.handle('collab-guest-heartbeat', (_event, guestId: string) =>
    guarded(async (): Promise<IpcResult<null>> => {
      guests.get(guestId)?.guest.sendHeartbeat();
      return { ok: true, data: null };
    })
  );

  ipc.handle('collab-guest-leave', (_event, guestId: string) =>
    guarded(async (): Promise<IpcResult<null>> => {
      guests.get(guestId)?.guest.close();
      guests.delete(guestId);
      return { ok: true, data: null };
    })
  );

  ipc.handle('collab-guest-files', (_event, guestId: string) =>
    guarded(async (): Promise<IpcResult<Record<string, string>>> => {
      const guest = guests.get(guestId)?.guest;
      if (!guest) {
        return { ok: true, data: {} };
      }
      const files: Record<string, string> = {};
      for (const fileId of fileIds(guest.docs)) {
        files[fileId] = getFileText(guest.docs, fileId);
      }
      return { ok: true, data: files };
    })
  );

  ipc.handle('collab-guest-set-text', (_event, guestId: string, fileId: string, content: string) =>
    guarded(async (): Promise<IpcResult<null>> => {
      const guest = guests.get(guestId)?.guest;
      if (!guest) {
        return { ok: true, data: null };
      }
      setFileText(guest.docs, fileId, content);
      guest.sendTextUpdate(encodeTextState(guest.docs));
      return { ok: true, data: null };
    })
  );
}

export type { CollabGuestRole };
