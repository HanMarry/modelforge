// @vitest-environment node
/**
 * The main-process ACP stream pins the backend certificate before the upgrade request, which
 * carries the token, is written (requirement 15, task 19.5).
 */
import { EventEmitter } from 'node:events';
import type tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { openPinnedAcpStream, pinnedTlsConnection } from './feishuAcpTransport';

class FakeTlsSocket extends EventEmitter {
  readonly destroy = vi.fn();
  readonly setTimeout = vi.fn();
  constructor(readonly fingerprint256: string | undefined) {
    super();
  }
  getPeerCertificate() {
    return { fingerprint256: this.fingerprint256 };
  }
}

function connectWith(socket: FakeTlsSocket) {
  const connect = vi.fn(() => socket);
  return { connect, typed: connect as unknown as typeof tls.connect };
}

describe('pinnedTlsConnection', () => {
  it('hands the socket over only after the certificate matched the pin', () => {
    const socket = new FakeTlsSocket('AB:CD');
    const { connect, typed } = connectWith(socket);
    const verify = vi.fn((_hostname: string, fingerprint: string) => fingerprint === 'AB:CD');
    const oncreate = vi.fn((_error: Error | null, _socket: Duplex) => {});

    const returned = pinnedTlsConnection(
      '127.0.0.1',
      verify,
      typed
    )({ host: '127.0.0.1', port: 51234 }, oncreate);

    expect(returned).toBeUndefined();
    expect(connect).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 51234,
      servername: '',
      rejectUnauthorized: false,
    });
    expect(oncreate).not.toHaveBeenCalled();

    socket.emit('secureConnect');

    expect(verify).toHaveBeenCalledWith('127.0.0.1', 'AB:CD');
    expect(oncreate).toHaveBeenCalledWith(null, socket);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('drops a connection whose certificate is not the pinned one', () => {
    const socket = new FakeTlsSocket('EF:01');
    const { typed } = connectWith(socket);
    const oncreate = vi.fn((_error: Error | null, _socket: Duplex) => {});

    pinnedTlsConnection('127.0.0.1', () => false, typed)({ host: '127.0.0.1', port: 1 }, oncreate);
    socket.emit('secureConnect');

    expect(socket.destroy).toHaveBeenCalled();
    expect(oncreate).toHaveBeenCalledTimes(1);
    expect(oncreate.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(String(oncreate.mock.calls[0][0])).toContain('does not match the pinned backend');
  });

  it('fails on a socket error before the handshake', () => {
    const socket = new FakeTlsSocket(undefined);
    const { typed } = connectWith(socket);
    const oncreate = vi.fn((_error: Error | null, _socket: Duplex) => {});

    pinnedTlsConnection('localhost', () => true, typed)({ host: 'localhost', port: 1 }, oncreate);
    socket.emit('error', new Error('ECONNREFUSED'));
    socket.emit('secureConnect');

    expect(oncreate).toHaveBeenCalledTimes(1);
    expect(String(oncreate.mock.calls[0][0])).toContain('ECONNREFUSED');
  });
});

describe('openPinnedAcpStream', () => {
  it('only accepts WebSocket URLs', () => {
    expect(() => openPinnedAcpStream('https://127.0.0.1:1/acp', () => true)).toThrow(
      'Unsupported ACP URL protocol'
    );
  });
});
