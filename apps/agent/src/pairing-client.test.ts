import { describe, expect, test } from "bun:test";
import type {
  DeviceCredentialProvider,
  LocalDeviceCredential,
} from "./device-credential-provider";
import {
  LocalPairingClient,
  type LocalPairingClientOptions,
  type PairingWebSocket,
} from "./pairing-client";

const PAIRING_SESSION_ID = "53d85ceb-60c0-4ef0-9a88-5c66f9e3fa9c";
const DEVICE_ID = "a9dc7bd6-384c-44ca-a212-bcdfa4a62da3";
const CREDENTIAL_ID = "6a2f748b-80f4-48a6-9238-a5e1a9c5ddf4";
const SECRET = "A".repeat(43);

class FakePairingSocket implements PairingWebSocket {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  #listeners = new Map<string, Set<(event: Event | MessageEvent) => void>>();

  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.#emit("open", new Event("open"));
    });
  }

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: Event | MessageEvent) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: Event | MessageEvent) => void,
  ): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
    this.#emit("close", new Event("close"));
  }

  emitMessage(value: unknown): void {
    this.#emit(
      "message",
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }

  #emit(type: string, event: Event | MessageEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function createFixture(
  provider: DeviceCredentialProvider,
  overrides: Partial<LocalPairingClientOptions> = {},
) {
  let socket: FakePairingSocket | undefined;
  const sockets: FakePairingSocket[] = [];
  let requestedUrl = "";
  const client = new LocalPairingClient({
    serverUrl: "https://api.example.test",
    deviceName: "Workstation",
    credentialProvider: provider,
    randomBytes: (length) => new Uint8Array(length),
    fetch: async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          pairingSessionId: PAIRING_SESSION_ID,
          pairingCode: "ABCD-EFGH-JKLM",
          expiresAt: "2026-09-18T12:05:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    },
    createWebSocket: () => {
      socket = new FakePairingSocket();
      sockets.push(socket);
      return socket;
    },
    ...overrides,
  });
  return {
    client,
    getSocket: () => socket,
    getSockets: () => [...sockets],
    getRequestedUrl: () => requestedUrl,
  };
}

async function waitFor<T>(get: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = get();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for fake pairing socket");
}

async function attach(
  client: LocalPairingClient,
  getSocket: () => FakePairingSocket | undefined,
) {
  const started = client.start();
  const socket = await waitFor(getSocket);
  await waitFor(() =>
    socket.sent.find(({ kind }) => kind === "pairing.attach"),
  );
  const attachMessage = socket.sent.find(
    ({ kind }) => kind === "pairing.attach",
  );
  expect(attachMessage).toMatchObject({
    kind: "pairing.attach",
    pairingSessionId: PAIRING_SESSION_ID,
    channelProof: "A".repeat(43),
  });
  socket.emitMessage({
    kind: "pairing.attached",
    pairingSessionId: PAIRING_SESSION_ID,
    expiresAt: "2026-09-18T12:05:00.000Z",
  });
  return started;
}

describe("LocalPairingClient", () => {
  test("posts a fresh proof and exposes the pairing code only after channel attach", async () => {
    const saved: LocalDeviceCredential[] = [];
    const provider: DeviceCredentialProvider = {
      async load() {
        return null;
      },
      async replace(credential) {
        saved.push(credential);
      },
    };
    let shownCode: string | undefined;
    const fixture = createFixture(provider, {
      onPairingCode: (code) => {
        shownCode = code;
      },
    });

    const started = await attach(fixture.client, fixture.getSocket);
    const socket = await waitFor(fixture.getSocket);
    expect(fixture.getRequestedUrl()).toBe(
      "https://api.example.test/pairing/sessions",
    );
    expect(await started).toBeUndefined();
    expect(shownCode).toBe("ABCD-EFGH-JKLM");
    expect(JSON.stringify(socket.sent)).not.toContain("ABCD-EFGH-JKLM");
    await fixture.client.close();
  });

  test("persists the credential before sending the matching ACK", async () => {
    let saved: LocalDeviceCredential | null = null;
    const provider: DeviceCredentialProvider = {
      async load(): Promise<LocalDeviceCredential | null> {
        return saved;
      },
      async replace(credential) {
        saved = credential;
      },
    };
    const fixture = createFixture(provider);
    await attach(fixture.client, fixture.getSocket);
    const socket = await waitFor(fixture.getSocket);
    const waiting = fixture.client.waitForCredential();
    socket.emitMessage({
      kind: "pairing.credential",
      pairingSessionId: PAIRING_SESSION_ID,
      deviceId: DEVICE_ID,
      credentialId: CREDENTIAL_ID,
      version: 1,
      credential: SECRET,
    });

    const credential = await waiting;
    const savedAfter = await provider.load();
    expect(savedAfter).toEqual({ deviceId: DEVICE_ID, credential: SECRET });
    expect(credential).toEqual({ deviceId: DEVICE_ID, credential: SECRET });
    expect(socket.sent.at(-1)).toEqual({
      kind: "pairing.ack",
      pairingSessionId: PAIRING_SESSION_ID,
      deviceId: DEVICE_ID,
      credentialId: CREDENTIAL_ID,
      version: 1,
    });
    await fixture.client.close();
  });

  test("does not ACK storage failure or a credential for another pairing session", async () => {
    const failingProvider: DeviceCredentialProvider = {
      async load() {
        return null;
      },
      async replace() {
        throw new Error("disk secret must not escape");
      },
    };
    const failed = createFixture(failingProvider);
    await attach(failed.client, failed.getSocket);
    const failedSocket = await waitFor(failed.getSocket);
    const failure = failed.client.waitForCredential();
    failedSocket.emitMessage({
      kind: "pairing.credential",
      pairingSessionId: PAIRING_SESSION_ID,
      deviceId: DEVICE_ID,
      credentialId: CREDENTIAL_ID,
      version: 1,
      credential: SECRET,
    });
    await expect(failure).rejects.toMatchObject({
      code: "PAIRING_STORAGE_FAILED",
    });
    expect(failedSocket.sent.some(({ kind }) => kind === "pairing.ack")).toBe(
      false,
    );
    expect(failedSocket.sent.at(-1)).toEqual({
      kind: "pairing.error",
      code: "PAIRING_STORAGE_FAILED",
    });

    const provider: DeviceCredentialProvider = {
      async load() {
        return null;
      },
      async replace() {},
    };
    const wrongSession = createFixture(provider);
    await attach(wrongSession.client, wrongSession.getSocket);
    const wrongSocket = await waitFor(wrongSession.getSocket);
    const wrongWait = wrongSession.client.waitForCredential();
    wrongSocket.emitMessage({
      kind: "pairing.credential",
      pairingSessionId: "f25ccf58-3f4d-43e8-8cb2-0bb9804d38af",
      deviceId: DEVICE_ID,
      credentialId: CREDENTIAL_ID,
      version: 1,
      credential: SECRET,
    });
    await expect(wrongWait).rejects.toMatchObject({
      code: "PAIRING_PROTOCOL_FAILED",
    });
    expect(wrongSocket.sent.some(({ kind }) => kind === "pairing.ack")).toBe(
      false,
    );
  });

  test("aborts an in-flight start and does not open a socket after close", async () => {
    let resolveFetch!: (response: Response) => void;
    let capturedSignal: AbortSignal | undefined;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const provider: DeviceCredentialProvider = {
      async load() {
        return null;
      },
      async replace() {},
    };
    const fixture = createFixture(provider, {
      fetch: async (_input, init) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return responsePromise;
      },
    });
    const started = fixture.client.start();
    await Promise.resolve();
    await fixture.client.close();
    expect(capturedSignal?.aborted).toBe(true);
    resolveFetch(
      new Response(
        JSON.stringify({
          pairingSessionId: PAIRING_SESSION_ID,
          pairingCode: "ABCD-EFGH-JKLM",
          expiresAt: "2026-09-18T12:05:00.000Z",
        }),
        { status: 201 },
      ),
    );
    await expect(started).rejects.toMatchObject({ code: "PAIRING_CLOSED" });
    expect(fixture.getSocket()).toBeUndefined();
  });

  test("rejects start when closed while waiting for channel attach", async () => {
    const provider: DeviceCredentialProvider = {
      async load() {
        return null;
      },
      async replace() {},
    };
    const fixture = createFixture(provider);
    const started = fixture.client.start();
    const socket = await waitFor(fixture.getSocket);
    await waitFor(() =>
      socket.sent.find(({ kind }) => kind === "pairing.attach"),
    );

    await fixture.client.close();

    await expect(started).rejects.toMatchObject({ code: "PAIRING_CLOSED" });
  });
  test("re-attaches with the same proof after a pre-credential disconnect", async () => {
    let saved: LocalDeviceCredential | null = null;
    const provider: DeviceCredentialProvider = {
      async load() {
        return saved;
      },
      async replace(value) {
        saved = value;
      },
    };
    const fixture = createFixture(provider);
    await attach(fixture.client, fixture.getSocket);
    const first = await waitFor(fixture.getSocket);
    const waiting = fixture.client.waitForCredential();

    first.close();

    const second = await waitFor(() => fixture.getSockets()[1]);
    const attachFrame = await waitFor(() =>
      second.sent.find(({ kind }) => kind === "pairing.attach"),
    );
    expect(attachFrame).toMatchObject({
      pairingSessionId: PAIRING_SESSION_ID,
      channelProof: "A".repeat(43),
    });

    second.emitMessage({
      kind: "pairing.attached",
      pairingSessionId: PAIRING_SESSION_ID,
      expiresAt: "2026-09-18T12:05:00.000Z",
    });
    second.emitMessage({
      kind: "pairing.credential",
      pairingSessionId: PAIRING_SESSION_ID,
      deviceId: DEVICE_ID,
      credentialId: CREDENTIAL_ID,
      version: 1,
      credential: SECRET,
    });

    await expect(waiting).resolves.toEqual({
      deviceId: DEVICE_ID,
      credential: SECRET,
    });
    expect(second.sent.at(-1)).toMatchObject({
      kind: "pairing.ack",
      pairingSessionId: PAIRING_SESSION_ID,
      deviceId: DEVICE_ID,
      credentialId: CREDENTIAL_ID,
      version: 1,
    });
    await fixture.client.close();
  });

});
