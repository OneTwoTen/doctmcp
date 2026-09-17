import { describe, expect, test } from "bun:test";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from "@doctmcp/protocol";
import { BridgeServerTransportError } from "./bridge-server-transport";
import { InMemoryDeviceCredentialProvider } from "./device-credential-provider";
import {
  LocalBridgeReconnectController,
  type LocalBridgeReconnectScheduler,
} from "./local-bridge-reconnect";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREDENTIAL = "A".repeat(43);

class ManualScheduler implements LocalBridgeReconnectScheduler {
  readonly timers = new Map<
    number,
    { readonly callback: () => void; readonly delayMs: number }
  >();
  #nextId = 1;
  #scheduledWaiters: Array<() => void> = [];

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.timers.set(id, { callback, delayMs });
    for (const resolve of this.#scheduledWaiters.splice(0)) resolve();
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  waitForScheduledTimer(): Promise<void> {
    if (this.timers.size > 0) return Promise.resolve();
    return new Promise((resolve) => this.#scheduledWaiters.push(resolve));
  }

  runNext(): void {
    const entry = this.timers.entries().next().value as
      | [number, { readonly callback: () => void; readonly delayMs: number }]
      | undefined;
    if (!entry) throw new Error("Expected reconnect timer");
    this.timers.delete(entry[0]);
    entry[1].callback();
  }
}

class UnavailableTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  start(): Promise<void> {
    const error = new BridgeServerTransportError(
      "SOCKET_ERROR",
      "Bridge server unavailable",
    );
    this.onerror?.(error);
    return Promise.reject(error);
  }

  send(
    _message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }
}

describe("LocalBridgeReconnectController repeated unavailability", () => {
  test("increases bounded backoff without parallel connect attempts", async () => {
    const scheduler = new ManualScheduler();
    let transports = 0;
    let activeConnects = 0;
    let maxActiveConnects = 0;
    const controller = new LocalBridgeReconnectController({
      url: "ws://127.0.0.1:1/bridge",
      credentialProvider: new InMemoryDeviceCredentialProvider({
        deviceId: DEVICE_ID,
        credential: CREDENTIAL,
      }),
      runtime: {
        async connect(transport) {
          activeConnects += 1;
          maxActiveConnects = Math.max(maxActiveConnects, activeConnects);
          try {
            await transport.start();
          } finally {
            activeConnects -= 1;
          }
        },
      },
      transportFactory: () => {
        transports += 1;
        return new UnavailableTransport();
      },
      scheduler,
      random: () => 0.5,
      backoffPolicy: {
        minDelayMs: 100,
        maxDelayMs: 400,
        factor: 2,
        jitterRatio: 0,
        stableReadyMs: 1_000,
      },
    });

    controller.start();
    await scheduler.waitForScheduledTimer();
    expect(controller.snapshot).toMatchObject({
      state: "backoff",
      consecutiveFailures: 1,
      retryDelayMs: 100,
    });

    scheduler.runNext();
    await scheduler.waitForScheduledTimer();
    expect(controller.snapshot).toMatchObject({
      state: "backoff",
      consecutiveFailures: 2,
      retryDelayMs: 200,
    });

    scheduler.runNext();
    await scheduler.waitForScheduledTimer();
    expect(controller.snapshot).toMatchObject({
      state: "backoff",
      consecutiveFailures: 3,
      retryDelayMs: 400,
    });
    expect(transports).toBe(3);
    expect(maxActiveConnects).toBe(1);
  });
});
