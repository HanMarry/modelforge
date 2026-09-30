// @vitest-environment node
/**
 * Integration test of the LAN collab service (task 18.9, requirement 14.4, 14.6–14.8): a real
 * TLS WebSocket host bound to the loopback address and real guest connections, with a
 * self-signed certificate generated once for the file. mDNS advertising stays off, so nothing
 * leaves the machine. The heartbeat test injects the host clock and a short timeout in place
 * of the 30 seconds of requirement 14.8.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  addAnnotation,
  encodeAnnotationState,
  encodeTextState,
  fileIds,
  getFileText,
  setFileText,
} from './collabDoc';
import type { CollabGuestRole } from './collabPolicy';
import {
  connectCollabGuest,
  createCollabHost,
  generateSelfSignedCertificate,
  type CollabGuest,
  type CollabHost,
  type CollabHostOptions,
  type CollabMember,
  type GeneratedCertificate,
  type JoinRequest,
} from './collabService';

const LOOPBACK = '127.0.0.1';
const PAPER_PATH = 'paper/main.tex';
const PAPER = '\\section{模型建立}\n设 $x_i$ 为第 i 个镜面的位置。\n\\section{求解}\n';
const EDITED = '\\section{模型建立}\n设 $x_i$ 为第 i 个定日镜的位置。\n\\section{求解}\n';
const TEST_TIMEOUT_MS = 20_000;

let certificate: GeneratedCertificate;
const hosts: CollabHost[] = [];
const guests: CollabGuest[] = [];

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves with the first value a listener receives after subscribing, or fails after a while. */
function nextEvent<T>(
  subscribe: (listener: (value: T) => void) => void,
  label: string,
  timeoutMs = 5_000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, timeoutMs);
    subscribe((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function until(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await delay(20);
  }
}

async function startHost(options: Partial<CollabHostOptions> = {}): Promise<CollabHost> {
  const host = await createCollabHost({
    files: [{ path: PAPER_PATH, content: PAPER }],
    bindAddress: LOOPBACK,
    certificate,
    advertise: false,
    ...options,
  });
  hosts.push(host);
  return host;
}

function connect(
  host: CollabHost,
  displayName: string,
  overrides: { inviteCode?: string; fingerprint?: string } = {}
): CollabGuest {
  const guest = connectCollabGuest({
    address: LOOPBACK,
    port: host.port,
    fingerprint: overrides.fingerprint ?? host.fingerprint,
    inviteCode: overrides.inviteCode ?? host.inviteCode,
    displayName,
  });
  guests.push(guest);
  return guest;
}

/** Joins with the host's invite code and waits for the host's join request. */
async function requestJoin(host: CollabHost, displayName: string) {
  const request = nextEvent<JoinRequest>(
    (listener) => host.on('join-request', listener),
    `join request of ${displayName}`
  );
  const guest = connect(host, displayName);
  return { guest, request: await request };
}

/** Joins, gets approved with `role` and waits until the shared text has arrived. */
async function admit(host: CollabHost, displayName: string, role: CollabGuestRole) {
  const { guest, request } = await requestJoin(host, displayName);
  const approved = nextEvent<{ role: CollabGuestRole; files: string[] }>(
    (listener) => guest.on('approved', listener),
    'approval'
  );
  const synced = nextEvent<Uint8Array>((listener) => guest.on('text-update', listener), 'text');
  host.approve(request.guestId, role);
  const approval = await approved;
  await synced;
  return { guest, guestId: request.guestId, approval };
}

function rejection(guest: CollabGuest): Promise<string> {
  return nextEvent<string>((listener) => guest.on('rejected', listener), 'rejection');
}

function editText(guest: CollabGuest, content: string): void {
  setFileText(guest.docs, PAPER_PATH, content);
  guest.sendTextUpdate(encodeTextState(guest.docs));
}

function otherCode(code: string): string {
  return code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
}

beforeAll(async () => {
  certificate = await generateSelfSignedCertificate();
}, 60_000);

afterEach(async () => {
  for (const guest of guests.splice(0)) {
    guest.close();
  }
  // A host that cannot close must not hang the remaining tests.
  await Promise.all(hosts.splice(0).map((host) => Promise.race([host.close(), delay(5_000)])));
});

describe('collab service on the loopback address', () => {
  it(
    'admits an approved guest, syncs the shared file and writes edits back',
    async () => {
      const writes: Array<[string, string]> = [];
      const host = await startHost({
        writeBack: async (path, content) => {
          writes.push([path, content]);
        },
      });
      expect(host.bindAddress).toBe(LOOPBACK);
      expect(host.inviteCode).toMatch(/^[A-Z0-9]{6}$/);
      expect(host.fingerprint).toBe(certificate.fingerprint);

      const { guest, request } = await requestJoin(host, 'Alice');
      expect(request.displayName).toBe('Alice');
      // Nothing is shared before the host approves (requirement 14.6).
      expect(fileIds(guest.docs)).toEqual([]);
      expect(host.members()).toEqual([]);

      const memberChange = nextEvent<CollabMember[]>(
        (listener) => host.on('member-change', listener),
        'member change'
      );
      const approved = nextEvent<{ role: CollabGuestRole; files: string[] }>(
        (listener) => guest.on('approved', listener),
        'approval'
      );
      host.approve(request.guestId, 'editable');

      expect(await approved).toEqual({ role: 'editable', files: [PAPER_PATH] });
      expect(await memberChange).toEqual([
        { guestId: request.guestId, displayName: 'Alice', role: 'editable' },
      ]);
      await until(() => getFileText(guest.docs, PAPER_PATH) === PAPER, 'initial text');
      expect(guest.role).toBe('editable');

      editText(guest, EDITED);

      await until(() => host.getText(PAPER_PATH) === EDITED, 'edit on the host');
      // The host writes the synced text back after its debounce.
      await until(() => writes.length > 0, 'write back', 5_000);
      expect(writes.at(-1)).toEqual([PAPER_PATH, EDITED]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses an invite code that was already used, a wrong code and a wrong fingerprint',
    async () => {
      const host = await startHost();
      const joinRequests: JoinRequest[] = [];
      await admit(host, 'Alice', 'read-only');
      host.on('join-request', (request) => joinRequests.push(request));

      const reused = connect(host, 'Mallory');
      expect(await rejection(reused)).toBe('used');

      const wrongCode = connect(host, 'Mallory', { inviteCode: otherCode(host.inviteCode) });
      expect(await rejection(wrongCode)).toBe('invalid');

      // The guest checks the pinned fingerprint before sending anything.
      const wrongFingerprint = connect(host, 'Mallory', { fingerprint: '0'.repeat(64) });
      expect(await rejection(wrongFingerprint)).toBe('fingerprint');

      await delay(200);
      expect(joinRequests).toEqual([]);
      expect(host.members().map((member) => member.displayName)).toEqual(['Alice']);
      for (const guest of [reused, wrongCode, wrongFingerprint]) {
        expect(fileIds(guest.docs)).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    'shares nothing with a guest the host rejects or does not answer in time',
    async () => {
      const host = await startHost();
      const { guest, request } = await requestJoin(host, 'Bob');
      const rejected = rejection(guest);
      host.reject(request.guestId);
      expect(await rejected).toBe('rejected');
      expect(fileIds(guest.docs)).toEqual([]);

      const slowHost = await startHost({ approvalTimeoutMs: 200 });
      const { guest: waiting } = await requestJoin(slowHost, 'Carol');
      expect(await rejection(waiting)).toBe('timeout');
      expect(fileIds(waiting.docs)).toEqual([]);
      expect(slowHost.members()).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'rejects text edits of a read-only guest and keeps the file (requirement 14.7)',
    async () => {
      const host = await startHost();
      const { guest, guestId } = await admit(host, 'Bob', 'read-only');
      const hostRejections: string[] = [];
      let guestRejections = 0;
      host.on('edit-rejected', (id) => hostRejections.push(id));
      guest.on('edit-rejected', () => {
        guestRejections += 1;
      });

      // An annotation goes first on the same connection; it is not treated as an edit.
      addAnnotation(guest.docs, PAPER_PATH, 'Bob', '这里的记号与第 2 节不一致', 1);
      guest.sendAnnotationUpdate(encodeAnnotationState(guest.docs));
      editText(guest, 'vandalized');

      await until(() => hostRejections.length > 0 && guestRejections > 0, 'edit rejection');
      await delay(200);
      expect(hostRejections).toEqual([guestId]);
      expect(guestRejections).toBe(1);
      expect(host.getText(PAPER_PATH)).toBe(PAPER);
      expect(host.members()).toEqual([{ guestId, displayName: 'Bob', role: 'read-only' }]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'removes a guest whose heartbeat stops for longer than the timeout (requirement 14.8)',
    async () => {
      let clock = 0;
      const host = await startHost({ now: () => clock, heartbeatTimeoutMs: 200 });
      const { guest } = await admit(host, 'Alice', 'editable');
      const departures: CollabMember[][] = [];
      host.on('member-change', (members) => departures.push(members));

      // A heartbeat followed by an edit on the same connection: once the edit has arrived, the
      // heartbeat has been counted too.
      clock = 150;
      guest.sendHeartbeat();
      editText(guest, EDITED);
      await until(() => host.getText(PAPER_PATH) === EDITED, 'edit on the host');

      // Past the join time plus the timeout, but not past the heartbeat plus the timeout.
      clock = 300;
      await delay(700);
      expect(host.members()).toHaveLength(1);
      expect(departures).toEqual([]);

      clock = 351;
      await until(() => host.members().length === 0, 'removal of the silent guest');
      expect(departures.at(-1)).toEqual([]);
      // The host keeps the last synced content.
      expect(host.getText(PAPER_PATH)).toBe(EDITED);

      // Coming back needs a new invite code: the old one is spent.
      const again = connect(host, 'Alice');
      expect(await rejection(again)).toBe('used');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'ends the session within 2 seconds, telling the guest and voiding the invite (requirement 14.4)',
    async () => {
      const host = await startHost();
      const { guest } = await admit(host, 'Alice', 'editable');
      editText(guest, EDITED);
      await until(() => host.getText(PAPER_PATH) === EDITED, 'edit on the host');

      const guestEnded = nextEvent<void>(
        (listener) => guest.on('session-ended', () => listener()),
        'session end on the guest'
      );
      const hostEnded = nextEvent<void>(
        (listener) => host.on('session-ended', () => listener()),
        'session end on the host'
      );
      const startedAt = Date.now();
      await host.endSession();
      await Promise.all([guestEnded, hostEnded]);

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(host.members()).toEqual([]);
      expect(host.getText(PAPER_PATH)).toBe(EDITED);

      const late = connect(host, 'Alice');
      expect(await rejection(late)).toBe('invalid');
    },
    TEST_TIMEOUT_MS
  );
});
