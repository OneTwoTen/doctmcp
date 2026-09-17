import { describe, expect, test } from "bun:test";
import { InMemoryDeviceCredentialProvider } from "./device-credential-provider";
import { LocalBridgeReconnectController } from "./local-bridge-reconnect";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREDENTIAL = "A".repeat(43);

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
});
