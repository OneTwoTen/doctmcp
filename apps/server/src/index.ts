import { createBridgeGateway } from "./gateway";

export const SERVER_COMPONENT = "doctmcp-server";

export {
  BridgeClientTransport,
  BridgeClientTransportError,
  type BridgeClientTransportErrorCode,
} from "./bridge-client-transport";
export {
  type DeviceClock,
  type DeviceIdGenerator,
  type DeviceRepository,
  DeviceRepositoryError,
  type DeviceRepositoryErrorCode,
  InMemoryDeviceRepository,
  type InMemoryDeviceRepositoryOptions,
} from "./device-repository";
export {
  type BridgeGateway,
  BridgeGatewayError,
  type BridgeGatewayLogger,
  type BridgeGatewaySession,
  type CreateBridgeGatewayOptions,
  createBridgeGateway,
  DEFAULT_BRIDGE_PATH,
} from "./gateway";

if (import.meta.main) {
  const gateway = createBridgeGateway({
    port: Number(process.env.PORT ?? 3000),
  });
  console.log(`${SERVER_COMPONENT}: listening on ${gateway.url}`);
}
