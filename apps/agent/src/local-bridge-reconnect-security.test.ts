import { describe, expect, test } from "bun:test";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from "@doctmcp/protocol";
import { BridgeServerTransportError } from "./bridge-server-transport";
import { InMemoryDeviceCredentialProvider } from "./device-credential-provider";
import { LocalBridgeReconnectController } from "./local-bridge-reconnect";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREDENTIAL = "A".repeat(43);

class RejectingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  start(): Promise<void> {
    const error = new BridgeServerTransportError(
      "AUTH_FAILED",
      `Device authentication failed for ${CREDENTIAL}`,
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

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("LocalBridgeReconnectController security boundary", () => {
  test("logger and public snapshot never expose raw credential or transport error message", async () => {
    const logs: Array<{
      readonly event: string;
      readonly details?: Readonly<Record<string, string>>;
    }> = [];
    const controller = new LocalBridgeReconnectController({
      url: "ws://127.0.0.1:8080/bridge",
      runtime: {
        connect: (transport) => transport.start(),
      },
      credentialProvider: new InMemoryDeviceCredentialProvider({
        deviceId: DEVICE_ID,
        credential: CREDENTIAL,
      }),
      transportFactory: () => new RejectingTransport(),
      logger: (event, details) => logs.push({ event, details }),
    });

    controller.start();
    await flushAsync();

    expect(controller.snapshot.state).toBe("auth-failed");
    const serialized = JSON.stringify({ logs, snapshot: controller.snapshot });
    expect(serialized).not.toContain(CREDENTIAL);
    expect(serialized).not.toContain("Device authentication failed for");
  });
});
