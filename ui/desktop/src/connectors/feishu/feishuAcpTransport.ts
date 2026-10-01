/**
 * WebSocket stream from the main process to `goose serve`, for the Feishu connector's own ACP
 * connection (requirement 15). The renderer gets there through Chromium, which pins the
 * backend's self-signed certificate (`installBackendCertificateVerifiers` in `main.ts`). Node
 * sockets bypass Chromium, so this module pins the certificate itself: the TLS handshake is
 * checked against the same trust records before the upgrade request, which carries the token,
 * is written.
 */
import net from 'node:net';
import tls from 'node:tls';
import type { ClientRequestArgs } from 'node:http';
import { WebSocket } from 'ws';
import type { Stream } from '@agentclientprotocol/sdk';
import {
  createWebSocketStream,
  type WebSocketConstructor,
} from '@agentclientprotocol/sdk/experimental/ws-client';

const HANDSHAKE_TIMEOUT_MS = 10_000;

/** True when the certificate with this SHA-256 fingerprint is trusted for `hostname`. */
export type CertificateVerifier = (hostname: string, fingerprint256: string) => boolean;

type CreateConnection = NonNullable<ClientRequestArgs['createConnection']>;

/**
 * `createConnection` for the upgrade request: hands the socket over only after the peer
 * certificate matched, so nothing is sent to a server that is not the pinned backend.
 */
export function pinnedTlsConnection(
  hostname: string,
  verify: CertificateVerifier,
  connect: typeof tls.connect = tls.connect
): CreateConnection {
  return (options, oncreate) => {
    const host = typeof options.host === 'string' && options.host ? options.host : hostname;
    const socket = connect({
      host,
      port: Number(options.port),
      servername: net.isIP(host) ? '' : host,
      // The backend certificate is self-signed; it is checked against the pin below.
      rejectUnauthorized: false,
    });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      oncreate(error, socket);
    };
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail(new Error('TLS handshake timed out')));
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      if (settled) {
        return;
      }
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      if (!fingerprint || !verify(hostname, fingerprint)) {
        fail(new Error(`The certificate of ${hostname} does not match the pinned backend`));
        return;
      }
      settled = true;
      socket.setTimeout(0);
      socket.removeListener('error', fail);
      oncreate(null, socket);
    });
    return undefined;
  };
}

/** Opens an ACP stream to `url` (`wss://…/acp?token=…`, or `ws://` for a plain backend). */
export function openPinnedAcpStream(url: string, verify: CertificateVerifier): Stream {
  const target = new URL(url);
  if (target.protocol !== 'wss:' && target.protocol !== 'ws:') {
    throw new Error(`Unsupported ACP URL protocol: ${target.protocol}`);
  }
  const hostname = target.hostname.replace(/^\[(.*)\]$/, '$1');
  const createConnection =
    target.protocol === 'wss:' ? pinnedTlsConnection(hostname, verify) : undefined;

  const requestOptions = (headers?: Record<string, string>): ClientRequestArgs => {
    const options: ClientRequestArgs & { handshakeTimeout: number } = {
      headers,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    };
    if (createConnection) {
      options.createConnection = createConnection;
    }
    return options;
  };

  class PinnedWebSocket extends WebSocket {
    constructor(
      address: string,
      protocols?: string | string[],
      options?: { headers?: Record<string, string> }
    ) {
      super(address, protocols ?? [], requestOptions(options?.headers));
    }
  }

  // `ws`'s overloaded event methods do not line up with the SDK's minimal constructor type.
  return createWebSocketStream(url, {
    WebSocket: PinnedWebSocket as unknown as WebSocketConstructor,
    protocols: [],
  });
}
