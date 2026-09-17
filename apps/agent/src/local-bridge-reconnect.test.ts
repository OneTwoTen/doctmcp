import { describe, expect, test } from "bun:test";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/server";
import { BridgeServerTransportError } from "./bridge-server-transport";
import { InMemoryDeviceCredentialProvider } from "./device-credential-provider";
import {
  calculateReconnectDelay,
  classifyBridgeFailure,
  DEFAULT_LOCAL_BRIDGE_BACKOFF_POLICY,
  LocalBridgeReconnectController,
  type LocalBridgeReconnectScheduler,
  type LocalBridgeTransportFactory,
} from "./local-bridge-reconnect";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREDENTIAL = "A".repeat(43);

class FakeScheduler implements LocalBridgeReconnectScheduler {
  readonly timers = new Map<
    number,
    { readonly callback: () => void; readonly delayMs: number }
  >();
  #nextId = 1;

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.timers.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  get delays(): readonly number[] {
    return [...this.timers.values()].map((timer) => timer.delayMs);
  }

  runNext(): void {
    const entry = this.timers.entries().next().value as
      | [number, { readonly callback: () => void; readonly delayMs: number }]
      | undefined;
    if (!entry) throw new Error("Expected a scheduled timer");
    this.timers.delete(entry[0]);
    entry[1].callback();
  }
}

class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  readonly auth: { readonly deviceId: string; readonly credential: string };
  started = false;
  closed = false;
  closeCalls = 0;
  #resolveStart?: () => void;
  #rejectStart?: (error: Error) => void;

  constructor(auth: { readonly deviceId: string; readonly credential: string }) {
    this.auth = auth;
  }

  start(): Promise<void> {
    this.started = true;
    return new Promise<void>((resolve, reject) => {
      this.#resolveStart = resolve;
      this.#rejectStart = reject;
    });
  }

  send(
    _message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.onclose?.();
    return Promise.resolve();
  }

  becomeReady(): void {
    this.#resolveStart?.();
  }

  rejectStart(error: Error): void {
    this.onerror?.(error);
    this.#rejectStart?.(error);
  }

  disconnect(error?: Error): void {
    if (error) this.onerror?.(error);
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

function createHarness(options: {
  readonly credentialProvider?: InMemoryDeviceCredentialProvider;
  readonly random?: () => number;
} = {}) {
  const scheduler = new FakeScheduler();
  const transports: FakeTransport[] = [];
  let activeConnects = 0;
  let maxActiveConnects = 0;

  const runtime = {
    async connect(transport: Transport): Promise<void> {
      activeConnects += 1;
      maxActiveConnects = Math.max(maxActiveConnects, activeConnects);
      try {
        await transport.start();
      } finally {
        activeConnects -= 1;
      }
    },
  };

  const transportFactory: LocalBridgeTransportFactory = (transportOptions) => {
    if (!transportOptions.auth) throw new Error("Expected device auth");
    const transport = new FakeTransport(transportOptions.auth);
    transports.push(transport);
    return transport;
  };

  const controller = new LocalBridgeReconnectController({
    url: "ws://127.0.0.1:8080/bridge",
    runtime,
    credentialProvider:
      options.credentialProvider ??
      new InMemoryDeviceCredentialProvider({
        deviceId: DEVICE_ID,
        credential: CREDENTIAL,
      }),
    scheduler,
    random: options.random ?? (() => 0.5),
    backoffPolicy: {
      minDelayMs: 100,
      maxDelayMs: 800,
      factor: 2,
      jitterRatio: 0,
      stableReadyMs: 1_000,
    },
    transportFactory,
  });

  return {
    controller,
    scheduler,
    transports,
    get maxActiveConnects() {
      return maxActiveConnects;
    },
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("local bridge reconnect policy", () => {
  test("calculates bounded exponential backoff with deterministic jitter", () => {
    const policy = DEFAULT_LOCAL_BRIDGE_BACKOFF_POLICY;

    expect(calculateReconnectDelay(1, policy, () => 0)).toBe(500);
    expect(calculateReconnectDelay(2, policy, () => 0.5)).toBe(1_000);
    expect(calculateReconnectDelay(3, policy, () => 1)).toBe(2_400);
    expect(calculateReconnectDelay(20, policy, () => 1)).toBe(30_000);
  });

  test("classifies auth and protocol failures as terminal but timeouts as retryable", () => {
    expect(
      classifyBridgeFailure(
        new BridgeServerTransportError("AUTH_FAILED", "auth failed"),
      ),
    ).toBe("auth-failed");
    expect(
      classifyBridgeFailure(
        new BridgeServerTransportError("UNSUPPORTED_VERSION", "bad version"),
      ),
    ).toBe("protocol-failed");
    expect(
      classifyBridgeFailure(new BridgeServerTransportError("TIMEOUT", "timeout")),
    ).toBe("retry");
  });
});

describe("LocalBridgeReconnectController", () => {
  test("reconnects transient disconnect with the same credential and never overlaps connect attempts", async () => {
    const harness = createHarness();

    harness.controller.start();
    await flushAsync();
    const first = harness.transports[0];
    expect(first).toBeDefined();
    first?.becomeReady();
    await flushAsync();
    expect(harness.controller.snapshot.state).toBe("ready");

    first?.disconnect(
      new BridgeServerTransportError("SOCKET_ERROR", "socket failed"),
    );
    await flushAsync();
    expect(harness.controller.snapshot.state).toBe("backoff");
    expect(harness.scheduler.delays).toEqual([100]);

    harness.scheduler.runNext();
    await flushAsync();
    const second = harness.transports[1];
    expect(second?.auth).toEqual({ deviceId: DEVICE_ID, credential: CREDENTIAL });
    expect(harness.maxActiveConnects).toBe(1);

    second?.becomeReady();
    await flushAsync();
    expect(harness.controller.snapshot.state).toBe("ready");
  });

  test("missing credential and provider failure enter action-required states without retry timers", async () => {
    const missing = createHarness({
      credentialProvider: new InMemoryDeviceCredentialProvider(),
    });
    missing.controller.start();
    await flushAsync();
    expect(missing.controller.snapshot.state).toBe("pairing-required");
    expect(missing.scheduler.timers.size).toBe(0);
    expect(missing.transports).toHaveLength(0);

    const failingProvider = new InMemoryDeviceCredentialProvider();
    failingProvider.load = () => Promise.reject(new Error(`storage ${CREDENTIAL}`));
    const failed = createHarness({ credentialProvider: failingProvider });
    failed.controller.start();
    await flushAsync();
    expect(failed.controller.snapshot.state).toBe("credential-failed");
    expect(JSON.stringify(failed.controller.snapshot)).not.toContain(CREDENTIAL);
    expect(failed.scheduler.timers.size).toBe(0);
  });

  test("auth and protocol rejection stop instead of arming reconnect backoff", async () => {
    const auth = createHarness();
    auth.controller.start();
    await flushAsync();
    auth.transports[0]?.rejectStart(
      new BridgeServerTransportError("AUTH_FAILED", "generic auth failure"),
    );
    await flushAsync();
    expect(auth.controller.snapshot.state).toBe("auth-failed");
    expect(auth.scheduler.timers.size).toBe(0);

    const protocol = createHarness();
    protocol.controller.start();
    await flushAsync();
    protocol.transports[0]?.rejectStart(
      new BridgeServerTransportError(
        "UNSUPPORTED_VERSION",
        "unsupported bridge protocol",
      ),
    );
    await flushAsync();
    expect(protocol.controller.snapshot.state).toBe("protocol-failed");
    expect(protocol.scheduler.timers.size).toBe(0);
  });

  test("stop cancels backoff and a connect in progress without stale reconnect", async () => {
    const backoff = createHarness();
    backoff.controller.start();
    await flushAsync();
    backoff.transports[0]?.rejectStart(
      new BridgeServerTransportError("TIMEOUT", "timeout"),
    );
    await flushAsync();
    expect(backoff.controller.snapshot.state).toBe("backoff");
    expect(backoff.scheduler.timers.size).toBe(1);

    await backoff.controller.stop();
    expect(backoff.controller.snapshot.state).toBe("stopped");
    expect(backoff.scheduler.timers.size).toBe(0);

    const connecting = createHarness();
    connecting.controller.start();
    await flushAsync();
    const transport = connecting.transports[0];
    expect(transport?.started).toBe(true);
    await connecting.controller.stop();
    expect(transport?.closeCalls).toBe(1);
    expect(connecting.controller.snapshot.state).toBe("stopped");
    expect(connecting.scheduler.timers.size).toBe(0);
  });

  test("only resets failure counter after a stable-ready window", async () => {
    const harness = createHarness();
    harness.controller.start();
    await flushAsync();
    harness.transports[0]?.rejectStart(
      new BridgeServerTransportError("TIMEOUT", "first"),
    );
    await flushAsync();
    expect(harness.controller.snapshot.consecutiveFailures).toBe(1);

    harness.scheduler.runNext();
    await flushAsync();
    const second = harness.transports[1];
    second?.becomeReady();
    await flushAsync();
    expect(harness.controller.snapshot.consecutiveFailures).toBe(1);
    expect(harness.scheduler.delays).toEqual([1_000]);

    second?.disconnect(new BridgeServerTransportError("TIMEOUT", "second"));
    await flushAsync();
    expect(harness.controller.snapshot.consecutiveFailures).toBe(2);
    expect(harness.scheduler.delays).toEqual([200]);

    harness.scheduler.runNext();
    await flushAsync();
    harness.transports[2]?.becomeReady();
    await flushAsync();
    expect(harness.scheduler.delays).toEqual([1_000]);
    harness.scheduler.runNext();
    await flushAsync();
    expect(harness.controller.snapshot.consecutiveFailures).toBe(0);
  });

  test("stale callbacks from an old attempt cannot mutate a newer ready generation", async () => {
    const harness = createHarness();
    harness.controller.start();
    await flushAsync();
    const first = harness.transports[0];
    const staleClose = first?.onclose;
    const staleError = first?.onerror;
    first?.becomeReady();
    await flushAsync();
    first?.disconnect(new BridgeServerTransportError("TIMEOUT", "old"));
    await flushAsync();
    harness.scheduler.runNext();
    await flushAsync();
    const second = harness.transports[1];
    second?.becomeReady();
    await flushAsync();
    const currentGeneration = harness.controller.snapshot.attemptGeneration;

    staleError?.(new BridgeServerTransportError("AUTH_FAILED", "stale"));
    staleClose?.();
    await flushAsync();

    expect(harness.controller.snapshot.state).toBe("ready");
    expect(harness.controller.snapshot.attemptGeneration).toBe(
      currentGeneration,
    );
    expect(harness.transports).toHaveLength(2);
  });
});
