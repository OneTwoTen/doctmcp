import { afterEach, describe, expect, test } from "bun:test";
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeHello,
  bridgeHelloSchema,
} from "@doctmcp/protocol";
import {
  BridgeServerTransport,
  type BridgeServerTransportError,
} from "./bridge-server-transport";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREDENTIAL = "A".repeat(43);

interface AuthPeer {
  readonly url: string;
  readonly hello: Promise<BridgeHello>;
  readonly requestUrls: readonly string[];
  stop(): Promise<void>;
}

function createAuthPeer(mode: "ack" | "auth-failed" = "ack"): AuthPeer {
  let resolveHello: ((hello: BridgeHello) => void) | undefined;
  const hello = new Promise<BridgeHello>((resolve) => {
    resolveHello = resolve;
  });
  const requestUrls: string[] = [];

  const server = Bun.serve({
    port: 0,
    websocket: {
      message(socket, raw) {
        const text =
          typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        const parsed = bridgeHelloSchema.safeParse(JSON.parse(text));
        if (!parsed.success) return;
        resolveHello?.(parsed.data);

        if (mode === "auth-failed") {
          socket.send(
            JSON.stringify({
              kind: "bridge.error",
              code: "AUTH_FAILED",
              message: "Device authentication failed",
            }),
          );
          return;
        }

        socket.send(
          JSON.stringify({
            kind: "bridge.hello.ack",
            bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
            role: "public-server",
            sessionId: parsed.data.sessionId,
          }),
        );
      },
    },
    fetch(request, serverInstance) {
      requestUrls.push(request.url);
      if (serverInstance.upgrade(request)) return;
      return new Response("WebSocket upgrade required", { status: 400 });
    },
  });

  return {
    url: `ws://${server.hostname}:${server.port}`,
    hello,
    requestUrls,
    async stop() {
      await server.stop(true);
    },
  };
}

describe("BridgeServerTransport device auth", () => {
  const peers: AuthPeer[] = [];
  const transports: BridgeServerTransport[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      transports.splice(0).map((transport) => transport.close()),
    );
    await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
  });

  test("sends device credential only inside bridge.hello and becomes ready after ack", async () => {
    const peer = createAuthPeer();
    peers.push(peer);
    const transport = new BridgeServerTransport({
      url: peer.url,
      sessionId: "authenticated-local-session",
      auth: { deviceId: DEVICE_ID, credential: CREDENTIAL },
    });
    transports.push(transport);

    await transport.start();
    const hello = await peer.hello;

    expect(hello).toEqual({
      kind: "bridge.hello",
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      role: "local-agent",
      sessionId: "authenticated-local-session",
      auth: {
        mode: "device",
        deviceId: DEVICE_ID,
        credential: CREDENTIAL,
      },
    });
    expect(transport.state).toBe("ready");
    expect(peer.requestUrls).toHaveLength(1);
    expect(peer.requestUrls[0]).not.toContain(CREDENTIAL);
  });

  test("keeps legacy hello explicit when auth is not configured", async () => {
    const peer = createAuthPeer();
    peers.push(peer);
    const transport = new BridgeServerTransport({
      url: peer.url,
      sessionId: "legacy-session",
    });
    transports.push(transport);

    await transport.start();
    const hello = await peer.hello;

    expect(hello.auth).toBeUndefined();
    expect(transport.state).toBe("ready");
  });

  test("preserves generic AUTH_FAILED from gateway without echoing credential", async () => {
    const peer = createAuthPeer("auth-failed");
    peers.push(peer);
    const transport = new BridgeServerTransport({
      url: peer.url,
      auth: { deviceId: DEVICE_ID, credential: CREDENTIAL },
    });
    transports.push(transport);

    let failure: unknown;
    try {
      await transport.start();
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "AUTH_FAILED",
      message: "Device authentication failed",
    } satisfies Partial<BridgeServerTransportError>);
    expect(String((failure as Error | undefined)?.message)).not.toContain(
      CREDENTIAL,
    );
  });

  test("rejects incomplete auth configuration before opening a socket", () => {
    expect(
      () =>
        new BridgeServerTransport({
          url: "ws://127.0.0.1:1",
          auth: { deviceId: DEVICE_ID, credential: "" },
        }),
    ).toThrowError(/requires deviceId and credential/);
  });
});
