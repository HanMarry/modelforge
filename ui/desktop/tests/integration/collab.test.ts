import { afterEach, describe, expect, it } from 'vitest';
import {
  connectCollabGuest,
  createCollabHost,
  type CollabGuest,
  type CollabHost,
  type SharedFile,
} from '../../src/utils/collab/collabService';
import { encodeTextState, setFileText } from '../../src/utils/collab/collabDoc';

type Emitter = { on: (event: string, listener: (arg: never) => void) => void };

function once<T>(emitter: Emitter, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    emitter.on(event, (arg) => {
      clearTimeout(timer);
      resolve(arg as T);
    });
  });
}

const files: SharedFile[] = [
  { path: 'paper.tex', content: 'original paper' },
  { path: 'data.csv', content: 'a,b,c' },
];

const hosts: CollabHost[] = [];
const guests: CollabGuest[] = [];

afterEach(async () => {
  for (const guest of guests) {
    guest.close();
  }
  for (const host of hosts) {
    await host.close();
  }
  hosts.length = 0;
  guests.length = 0;
});

describe('collab service on loopback (integration)', () => {
  it('guest joins after approval and is granted the requested role', async () => {
    const host = await createCollabHost({ files, bindAddress: '127.0.0.1', port: 0 });
    hosts.push(host);

    const joinRequest = once<{ guestId: string; displayName: string }>(host as unknown as Emitter, 'join-request');
    const guest = connectCollabGuest({
      address: '127.0.0.1',
      port: host.port,
      fingerprint: host.fingerprint,
      inviteCode: host.inviteCode,
      displayName: 'alice',
    });
    guests.push(guest);

    const approved = once<{ role: string; files: string[] }>(guest as unknown as Emitter, 'approved');
    const request = await joinRequest;
    host.approve(request.guestId, 'read-only');

    const payload = await approved;
    expect(payload.role).toBe('read-only');
    expect(payload.files).toEqual(['paper.tex', 'data.csv']);
    expect(host.members()).toHaveLength(1);
  });

  it('rejects a read-only guest text edit but keeps the host content unchanged', async () => {
    const host = await createCollabHost({ files, bindAddress: '127.0.0.1', port: 0 });
    hosts.push(host);
    const joinRequest = once<{ guestId: string }>(host as unknown as Emitter, 'join-request');
    const guest = connectCollabGuest({
      address: '127.0.0.1',
      port: host.port,
      fingerprint: host.fingerprint,
      inviteCode: host.inviteCode,
      displayName: 'bob',
    });
    guests.push(guest);
    const approved = once<{ role: string }>(guest as unknown as Emitter, 'approved');
    host.approve((await joinRequest).guestId, 'read-only');
    await approved;

    const editRejected = once<null>(guest as unknown as Emitter, 'edit-rejected');
    setFileText(guest.docs, 'paper.tex', 'tampered');
    guest.sendTextUpdate(encodeTextState(guest.docs));
    await editRejected;

    expect(host.getText('paper.tex')).toBe('original paper');
  });

  it('removes a guest whose heartbeats stop and requires a fresh join', async () => {
    const host = await createCollabHost({
      files,
      bindAddress: '127.0.0.1',
      port: 0,
      heartbeatTimeoutMs: 250,
    });
    hosts.push(host);
    const joinRequest = once<{ guestId: string }>(host as unknown as Emitter, 'join-request');
    const guest = connectCollabGuest({
      address: '127.0.0.1',
      port: host.port,
      fingerprint: host.fingerprint,
      inviteCode: host.inviteCode,
      displayName: 'carol',
    });
    guests.push(guest);
    const approved = once<{ role: string }>(guest as unknown as Emitter, 'approved');
    host.approve((await joinRequest).guestId, 'read-only');
    await approved;
    expect(host.members()).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(host.members()).toHaveLength(0);
  });

  it('ends the session and notifies the guest', async () => {
    const host = await createCollabHost({ files, bindAddress: '127.0.0.1', port: 0 });
    hosts.push(host);
    const joinRequest = once<{ guestId: string }>(host as unknown as Emitter, 'join-request');
    const guest = connectCollabGuest({
      address: '127.0.0.1',
      port: host.port,
      fingerprint: host.fingerprint,
      inviteCode: host.inviteCode,
      displayName: 'dave',
    });
    guests.push(guest);
    const approved = once<{ role: string }>(guest as unknown as Emitter, 'approved');
    host.approve((await joinRequest).guestId, 'editable');
    await approved;

    const ended = once<null>(guest as unknown as Emitter, 'session-ended');
    await host.endSession();
    await ended;
    expect(host.members()).toHaveLength(0);
  });
});
