import {
  PAIRING_CHANNEL_MAX_MESSAGE_BYTES,
  type PairingChannelErrorCode,
  pairingChannelMessageSchema,
} from "@doctmcp/protocol";
import type {
  GatewayWebSocketConnection,
  GatewayWebSocketRoute,
} from "./gateway";
import {
  type PairingChannelCoordinator,
  PairingChannelError,
} from "./pairing-channel";

export const PAIRING_CHANNEL_PATH = "/pairing";
export const PAIRING_CHANNEL_ATTACH_TIMEOUT_MS = 10_000;
export const PAIRING_CHANNEL_MAX_OPEN_SOCKETS = 512;

function encodeError(code: PairingChannelErrorCode): string {
  return JSON.stringify({ kind: "pairing.error", code });
}

function decodeFrame(frame: string | Buffer): unknown {
  const text =
    typeof frame === "string"
      ? frame
      : new TextDecoder("utf-8", { fatal: true }).decode(frame);
  return JSON.parse(text) as unknown;
}

export function createPairingChannelWebSocketRoute(
  coordinator: PairingChannelCoordinator,
): GatewayWebSocketRoute {
  const sessionIdBySocket = new Map<string, string>();
  const attachTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const openSockets = new Set<string>();

  const closeWithError = async (
    connection: GatewayWebSocketConnection,
    code: PairingChannelErrorCode,
    closeCode: number,
  ): Promise<void> => {
    try {
      await connection.send(encodeError(code));
    } catch {
      // Native close remains authoritative if the socket cannot send an error frame.
    }
    connection.close(closeCode, "Pairing channel unavailable");
  };

  return Object.freeze({
    path: PAIRING_CHANNEL_PATH,
    maxMessageBytes: PAIRING_CHANNEL_MAX_MESSAGE_BYTES,
    open(connection: GatewayWebSocketConnection) {
      if (openSockets.size >= PAIRING_CHANNEL_MAX_OPEN_SOCKETS) {
        connection.close(1013, "Pairing capacity reached");
        return;
      }
      openSockets.add(connection.id);
      attachTimers.set(
        connection.id,
        setTimeout(
          () => connection.close(1008, "Pairing attach timed out"),
          PAIRING_CHANNEL_ATTACH_TIMEOUT_MS,
        ),
      );
    },
    async message(
      connection: GatewayWebSocketConnection,
      frame: string | Buffer,
    ) {
      let value: unknown;
      try {
        value = decodeFrame(frame);
      } catch {
        await closeWithError(connection, "PROTOCOL_ERROR", 1002);
        return;
      }

      const parsed = pairingChannelMessageSchema.safeParse(value);
      if (!parsed.success) {
        await closeWithError(connection, "PROTOCOL_ERROR", 1002);
        return;
      }

      try {
        switch (parsed.data.kind) {
          case "pairing.attach": {
            if (sessionIdBySocket.has(connection.id)) {
              throw new PairingChannelError("PAIRING_UNAVAILABLE");
            }
            await coordinator.attach(
              parsed.data.pairingSessionId,
              parsed.data.channelProof,
              connection,
            );
            sessionIdBySocket.set(connection.id, parsed.data.pairingSessionId);
            const timer = attachTimers.get(connection.id);
            if (timer !== undefined) clearTimeout(timer);
            attachTimers.delete(connection.id);
            break;
          }
          case "pairing.ack":
            await coordinator.acknowledge(connection, parsed.data);
            sessionIdBySocket.delete(connection.id);
            break;
          case "pairing.error":
            if (parsed.data.code !== "PAIRING_STORAGE_FAILED") {
              throw new PairingChannelError("PROTOCOL_ERROR");
            }
            coordinator.reportClientError(connection);
            break;
          case "pairing.close": {
            const pairingSessionId = sessionIdBySocket.get(connection.id);
            if (pairingSessionId) {
              await coordinator.cancel(pairingSessionId, connection);
              sessionIdBySocket.delete(connection.id);
            }
            connection.close(1000, "Pairing closed");
            break;
          }
          case "pairing.attached":
          case "pairing.credential":
            throw new PairingChannelError("PROTOCOL_ERROR");
        }
      } catch (error) {
        const code =
          error instanceof PairingChannelError
            ? error.code
            : "PAIRING_UNAVAILABLE";
        await closeWithError(
          connection,
          code,
          code === "PROTOCOL_ERROR" ? 1002 : 1008,
        );
      }
    },
    close(connection: GatewayWebSocketConnection) {
      openSockets.delete(connection.id);
      const timer = attachTimers.get(connection.id);
      if (timer !== undefined) clearTimeout(timer);
      attachTimers.delete(connection.id);
      const pairingSessionId = sessionIdBySocket.get(connection.id);
      if (pairingSessionId) {
        coordinator.detach(pairingSessionId, connection);
        sessionIdBySocket.delete(connection.id);
      }
    },
  });
}
