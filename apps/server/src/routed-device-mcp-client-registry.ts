import type {
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/client";
import { BridgeClientTransport } from "./bridge-client-transport";
import type { DeviceRoutingService } from "./device-routing";
import { DeviceRoutingError } from "./device-routing";
import type { BridgeGatewaySession } from "./gateway";

interface BridgeMcpClientEntry {
  readonly client: Client;
  readonly transport: BridgeClientTransport;
}

function routeFailed(session: BridgeGatewaySession): DeviceRoutingError {
  return session.state === "ready"
    ? new DeviceRoutingError(
        "ROUTING_UNAVAILABLE",
        "Không thể xử lý yêu cầu MCP trên thiết bị.",
      )
    : new DeviceRoutingError("DEVICE_OFFLINE", "Device hiện không trực tuyến.");
}

/** Keeps one initialized MCP client bound to each authenticated bridge session. */
export class RoutedDeviceMcpClientRegistry {
  readonly #deviceRouter: DeviceRoutingService;
  readonly #bySession = new WeakMap<
    BridgeGatewaySession,
    Promise<BridgeMcpClientEntry>
  >();
  readonly #entries = new Set<BridgeMcpClientEntry>();
  readonly #toolCatalogByDevice = new Map<
    string,
    { readonly ownerId: string; readonly result: ListToolsResult }
  >();
  #closed = false;

  constructor(deviceRouter: DeviceRoutingService) {
    this.#deviceRouter = deviceRouter;
  }

  async listTools(ownerId: string, deviceId: string): Promise<ListToolsResult> {
    const route = await this.#deviceRouter.resolve(ownerId, deviceId);
    const entry = await this.#getEntry(route.session);
    try {
      const result = await entry.client.listTools();
      this.#toolCatalogByDevice.set(deviceId, {
        ownerId,
        result: structuredClone(result),
      });
      return result;
    } catch {
      throw routeFailed(route.session);
    }
  }

  getCachedTools(
    ownerId: string,
    deviceId: string,
  ): ListToolsResult | undefined {
    const cached = this.#toolCatalogByDevice.get(deviceId);
    if (!cached || cached.ownerId !== ownerId) return undefined;
    return structuredClone(cached.result);
  }

  async callTool(
    ownerId: string,
    deviceId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const route = await this.#deviceRouter.resolve(ownerId, deviceId);
    const entry = await this.#getEntry(route.session);
    try {
      return await entry.client.callTool({ name, arguments: args });
    } catch {
      throw routeFailed(route.session);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#entries];
    const results = await Promise.allSettled(
      entries.map(({ client }) => client.close()),
    );
    this.#entries.clear();
    this.#toolCatalogByDevice.clear();
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
  }

  async #getEntry(
    session: BridgeGatewaySession,
  ): Promise<BridgeMcpClientEntry> {
    if (this.#closed) {
      throw new DeviceRoutingError(
        "ROUTING_UNAVAILABLE",
        "Device routing hiện không khả dụng.",
      );
    }
    if (session.state !== "ready") throw routeFailed(session);

    let pending = this.#bySession.get(session);
    if (!pending) {
      pending = this.#connect(session);
      this.#bySession.set(session, pending);
    }

    try {
      return await pending;
    } catch {
      this.#bySession.delete(session);
      throw routeFailed(session);
    }
  }

  async #connect(session: BridgeGatewaySession): Promise<BridgeMcpClientEntry> {
    const transport = new BridgeClientTransport(session);
    const client = new Client({
      name: "doctmcp-public-router",
      version: "0.1.0",
    });
    const entry = Object.freeze({ client, transport });

    try {
      await client.connect(transport);
      if (this.#closed || session.state !== "ready") {
        await client.close();
        throw routeFailed(session);
      }
      const onclose = transport.onclose;
      transport.onclose = () => {
        this.#entries.delete(entry);
        onclose?.();
      };
      this.#entries.add(entry);
      return entry;
    } catch (error) {
      this.#bySession.delete(session);
      if (transport.state !== "closed") {
        await transport.close().catch(() => undefined);
      }
      throw error;
    }
  }
}
