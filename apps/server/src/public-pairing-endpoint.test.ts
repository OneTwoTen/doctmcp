import { afterEach, describe, expect, test } from "bun:test";
import { InMemoryPairingAbuseGuard } from "./pairing-abuse-guard";
import { createPublicPairingEndpoint } from "./public-pairing-endpoint";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "./server-runtime";

const BASE_URL = "http://127.0.0.1/pairing/sessions";
const PROOF = "A".repeat(43);

describe("public pairing start endpoint", () => {
  const runtimes: DoctmcpServerRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  });

  function createEndpoint(
    maxStartsPerAddress = 10,
    trustedProxyAddresses?: readonly string[],
  ) {
    const runtime = createDoctmcpServerRuntime({
      port: 0,
      idleTimeoutMs: 0,
      pairingAbuseGuard: new InMemoryPairingAbuseGuard({
        maxStartsPerAddress,
      }),
    });
    runtimes.push(runtime);
    const endpoint = createPublicPairingEndpoint({
      pairingService: runtime.pairingService,
      channelCoordinator: runtime.pairingChannelCoordinator,
      abuseGuard: runtime.pairingAbuseGuard,
      ...(trustedProxyAddresses ? { trustedProxyAddresses } : {}),
    });
    return { endpoint, runtime };
  }

  test("validates bounded strict requests and derives rate-limit identity from request context", async () => {
    const { endpoint, runtime } = createEndpoint(1);

    const wrongMethod = await endpoint.fetch(
      new Request(BASE_URL, { method: "GET" }),
    );
    expect(wrongMethod.status).toBe(405);

    const wrongPath = await endpoint.fetch(
      new Request("http://127.0.0.1/elsewhere", { method: "POST" }),
    );
    expect(wrongPath.status).toBe(404);

    const remotePlaintext = await endpoint.fetch(
      new Request(BASE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceName: "Laptop", channelProof: PROOF }),
      }),
      { remoteAddress: "198.51.100.22" },
    );
    expect(remotePlaintext.status).toBe(426);

    const extraField = await endpoint.fetch(
      new Request(BASE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceName: "Laptop",
          channelProof: PROOF,
          ownerId: "forged",
        }),
      }),
      { remoteAddress: "127.0.0.1" },
    );
    expect(extraField.status).toBe(400);

    const created = await endpoint.fetch(
      new Request(BASE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.22",
        },
        body: JSON.stringify({ deviceName: "Laptop", channelProof: PROOF }),
      }),
      { remoteAddress: "127.0.0.1" },
    );
    expect(created.status).toBe(201);
    const result = (await created.json()) as Record<string, unknown>;
    expect(result.pairingSessionId).toBeString();
    expect(result.pairingCode).toBeString();
    expect(result.channelProof).toBeUndefined();
    expect(runtime.pairingChannelCoordinator.pendingCount).toBe(1);

    const attached = new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = new WebSocket(
        runtime.gateway.url.replace(/\/bridge$/u, "/pairing"),
      );
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for pairing attach")),
        2_000,
      );
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            kind: "pairing.attach",
            pairingSessionId: result.pairingSessionId,
            channelProof: PROOF,
          }),
        );
      });
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(
          (event as MessageEvent).data as string,
        ) as Record<string, unknown>;
        if (frame.kind === "pairing.attached") {
          clearTimeout(timeout);
          socket.close();
          resolve(frame);
        }
      });
    });
    expect(await attached).toMatchObject({
      kind: "pairing.attached",
      pairingSessionId: result.pairingSessionId,
    });

    const rateLimited = await endpoint.fetch(
      new Request(BASE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceName: "Second", channelProof: PROOF }),
      }),
      { remoteAddress: "127.0.0.1" },
    );
    expect(rateLimited.status).toBe(429);
    expect(await rateLimited.json()).toEqual({
      error: { code: "PAIRING_RATE_LIMITED" },
    });
  });

  test("rejects oversized and malformed JSON without creating a session", async () => {
    const { endpoint, runtime } = createEndpoint();
    const context = { remoteAddress: "127.0.0.1" };
    const oversized = await endpoint.fetch(
      new Request(BASE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceName: "x".repeat(3000),
          channelProof: PROOF,
        }),
      }),
      context,
    );
    expect(oversized.status).toBe(400);

    const malformed = await endpoint.fetch(
      new Request(BASE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      context,
    );
    expect(malformed.status).toBe(400);
    expect(runtime.pairingChannelCoordinator.pendingCount).toBe(0);
  });

  test("accepts TLS forwarded only from an explicitly trusted proxy address", async () => {
    const { endpoint } = createEndpoint(10, ["10.0.0.2"]);
    const makeRequest = () =>
      new Request(BASE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
        },
        body: JSON.stringify({ deviceName: "Laptop", channelProof: PROOF }),
      });

    const forgedForwardedScheme = await endpoint.fetch(makeRequest(), {
      remoteAddress: "10.0.0.3",
    });
    expect(forgedForwardedScheme.status).toBe(426);

    const trustedProxyRequest = await endpoint.fetch(makeRequest(), {
      remoteAddress: "10.0.0.2",
    });
    expect(trustedProxyRequest.status).toBe(201);
  });

  test("does not trust forwarded TLS when the peer address is missing", async () => {
    const { endpoint } = createEndpoint(10, [""]);
    const response = await endpoint.fetch(
      new Request(BASE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
        },
        body: JSON.stringify({ deviceName: "Laptop", channelProof: PROOF }),
      }),
      { remoteAddress: null },
    );
    expect(response.status).toBe(426);
  });
});
