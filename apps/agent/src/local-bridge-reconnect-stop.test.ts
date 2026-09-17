import { describe, expect, test } from "bun:test";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from "@doctmcp/protocol";
import { InMemoryDeviceCredentialProvider } from "./device-credential-provider";
import { LocalBridgeReconnectController } from "./local-bridge-reconnect";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREDENTIAL = "A".repeat(43);

class DeferredCloseTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  closeCalls = 0;
  #resolveClose?: () => void;

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(
    _message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      this.#resolveClose = resolve;
    });
  }

  finishClose(): void {
    this.#resolveClose?.();
    this.onclose?.();
  }
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("LocalBridgeReconnectController stop lifecycle", () => {
  test("repeated stop is idempotent and does not advance lifecycle generation", async () => {
    const controller = new LocalBridgeReconnectController({
      url: "ws://127.0.0.1:8080/bridge",
      runtime: { connect: () => Promise.resolve() },
      credentialProvider: new InMemoryDeviceCredentialProvider({
        deviceId: DEVICE_ID,
        credential: CREDENTIAL,
      }),
    });

    await controller.stop();
    const stopped = controller.snapshot;

    await controller.stop();

    expect(controller.snapshot).toEqual(stopped);
  });

  test("concurrent stop calls share cleanup and start cannot overlap a closing generation", async () => {
    const transports: DeferredCloseTransport[] = [];
    const controller = new LocalBridgeReconnectController({
      url: "ws://127.0.0.1:8080/bridge",
      runtime: { connect: (transport) => transport.start() },
      credentialProvider: new InMemoryDeviceCredentialProvider({
        deviceId: DEVICE_ID,
        credential: CREDENTIAL,
      }),
      transportFactory: () => {
        const transport = new DeferredCloseTransport();
        transports.push(transport);
        return transport;
      },
    });

    controller.start();
    await flushAsync();
    expect(controller.snapshot.state).toBe("ready");
    expect(transports).toHaveLength(1);

    const lifecycleBeforeStop = controller.snapshot.lifecycleGeneration;
    const firstStop = controller.stop();
    let secondStopResolved = false;
    const secondStop = controller.stop().then(() => {
      secondStopResolved = true;
    });

    controller.start();
    await flushAsync();

    expect(controller.snapshot.state).toBe("stopped");
    expect(controller.snapshot.lifecycleGeneration).toBe(
      lifecycleBeforeStop + 1,
    );
    expect(transports).toHaveLength(1);
    expect(transports[0]?.closeCalls).toBe(1);
    expect(secondStopResolved).toBe(false);

    transports[0]?.finishClose();
    await Promise.all([firstStop, secondStop]);

    controller.start();
    await flushAsync();
    expect(transports).toHaveLength(2);
    expect(controller.snapshot.state).toBe("ready");

    const finalStop = controller.stop();
    transports[1]?.finishClose();
    await finalStop;
  });
});
