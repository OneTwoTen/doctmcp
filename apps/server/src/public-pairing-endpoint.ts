import { deviceNameSchema } from "@doctmcp/schemas";
import type { BridgeGatewayHttpContext } from "./gateway";
import { type PairingService, PairingServiceError } from "./pairing";
import {
  PairingAbuseError,
  type PairingAbuseGuard,
} from "./pairing-abuse-guard";
import {
  type PairingChannelCoordinator,
  PairingChannelError,
} from "./pairing-channel";

export const PUBLIC_PAIRING_START_PATH = "/pairing/sessions";
export const PUBLIC_PAIRING_START_MAX_BODY_BYTES = 2_048;

export interface CreatePublicPairingEndpointOptions {
  readonly pairingService: PairingService;
  readonly channelCoordinator: PairingChannelCoordinator;
  readonly abuseGuard: PairingAbuseGuard;
  readonly trustedProxyAddresses?: readonly string[];
}

export interface PublicPairingEndpoint {
  readonly fetch: (
    request: Request,
    context?: BridgeGatewayHttpContext,
  ) => Promise<Response>;
  close(): Promise<void>;
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      return null;
    }
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

function responseForError(error: unknown): Response {
  if (error instanceof PairingAbuseError) {
    return jsonResponse({ error: { code: "PAIRING_RATE_LIMITED" } }, 429);
  }
  if (error instanceof PairingChannelError) {
    const status = error.code === "PAIRING_RATE_LIMITED" ? 429 : 503;
    return jsonResponse({ error: { code: error.code } }, status);
  }
  if (error instanceof PairingServiceError) {
    return jsonResponse({ error: { code: "PAIRING_UNAVAILABLE" } }, 503);
  }
  return jsonResponse({ error: { code: "PAIRING_UNAVAILABLE" } }, 503);
}

function isLoopbackAddress(remoteAddress: string | null): boolean {
  if (!remoteAddress) return false;
  const address =
    remoteAddress.replace(/^::ffff:/iu, "").split("%", 1)[0] ?? "";
  return address === "::1" || address.startsWith("127.");
}

function normalizeRemoteAddress(remoteAddress: string | null): string | null {
  if (!remoteAddress) return null;
  return remoteAddress.replace(/^::ffff:/iu, "").split("%", 1)[0] ?? null;
}

export function createPublicPairingEndpoint(
  options: CreatePublicPairingEndpointOptions,
): PublicPairingEndpoint {
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    async fetch(
      request: Request,
      context: BridgeGatewayHttpContext = { remoteAddress: null },
    ) {
      const url = new URL(request.url);
      if (url.pathname !== PUBLIC_PAIRING_START_PATH) {
        return new Response("Not found", { status: 404 });
      }
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      const remoteAddress = normalizeRemoteAddress(context.remoteAddress);
      const trustedProxy =
        remoteAddress !== null &&
        (options.trustedProxyAddresses ?? []).some(
          (address) => normalizeRemoteAddress(address) === remoteAddress,
        );
      const proxyForwardedHttps =
        trustedProxy &&
        request.headers.get("x-forwarded-proto")?.trim().toLowerCase() ===
          "https";
      if (
        url.protocol !== "https:" &&
        !isLoopbackAddress(remoteAddress) &&
        !proxyForwardedHttps
      ) {
        return new Response("TLS required", { status: 426 });
      }
      if (
        request.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      ) {
        return jsonResponse({ error: { code: "INVALID_REQUEST" } }, 400);
      }

      const body = await readLimitedBody(
        request,
        PUBLIC_PAIRING_START_MAX_BODY_BYTES,
      );
      if (body === null) {
        return jsonResponse({ error: { code: "INVALID_REQUEST" } }, 400);
      }

      let input: unknown;
      try {
        input = JSON.parse(body) as unknown;
      } catch {
        return jsonResponse({ error: { code: "INVALID_REQUEST" } }, 400);
      }
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return jsonResponse({ error: { code: "INVALID_REQUEST" } }, 400);
      }
      const record = input as Record<string, unknown>;
      if (
        Object.keys(record).length !== 2 ||
        !deviceNameSchema.safeParse(record.deviceName).success ||
        typeof record.channelProof !== "string"
      ) {
        return jsonResponse({ error: { code: "INVALID_REQUEST" } }, 400);
      }

      try {
        await options.abuseGuard.beforeStart(
          context.remoteAddress ?? undefined,
        );
        const created = await options.pairingService.createPairingSession();
        try {
          await options.channelCoordinator.register(
            created.session,
            record.channelProof,
          );
        } catch (error) {
          await options.pairingService
            .cancelPairingSession(created.session.pairingSessionId)
            .catch(() => undefined);
          throw error;
        }
        return jsonResponse(
          {
            pairingSessionId: created.session.pairingSessionId,
            pairingCode: created.pairingCode,
            expiresAt: created.session.expiresAt.toISOString(),
          },
          201,
        );
      } catch (error) {
        return responseForError(error);
      }
    },
    close(): Promise<void> {
      closePromise ??= Promise.resolve();
      return closePromise;
    },
  });
}
