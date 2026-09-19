import { ownerIdSchema } from "@doctmcp/schemas";
import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
} from "jose";

const OIDC_DISCOVERY_PATH = "/.well-known/openid-configuration";
const OWNER_ID_DOMAIN = "doctmcp-oidc-owner:v1\0";
const ACCEPTED_JWT_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "PS256",
] as const;

export interface OidcAccessTokenVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly fetch?: OidcFetch;
  readonly discoveryTimeoutMs?: number;
}

export type OidcFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OidcAccessTokenVerifier extends OAuthTokenVerifier {
  readonly oauthMetadata: OAuthMetadata;
}

interface OidcDiscoveryDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly response_types_supported: readonly string[];
  readonly grant_types_supported?: readonly string[];
  readonly code_challenge_methods_supported: readonly string[];
  readonly scopes_supported?: readonly string[];
  readonly registration_endpoint?: string;
  readonly revocation_endpoint?: string;
  readonly response_modes_supported?: readonly string[];
  readonly token_endpoint_auth_methods_supported?: readonly string[];
  readonly token_endpoint_auth_signing_alg_values_supported?: readonly string[];
  readonly client_id_metadata_document_supported?: boolean;
  readonly authorization_response_iss_parameter_supported?: boolean;
  readonly [key: string]: unknown;
}

function requireHttpsUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} phải là URL hợp lệ.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${field} phải là URL HTTPS hợp lệ.`);
  }
  return url;
}

function discoveryUrl(issuer: URL): URL {
  const result = new URL(issuer.href);
  result.pathname = `${issuer.pathname.replace(/\/+$/, "")}${OIDC_DISCOVERY_PATH}`;
  result.search = "";
  result.hash = "";
  return result;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

async function readDiscoveryDocument(
  issuer: string,
  issuerUrl: URL,
  fetcher: OidcFetch,
  timeoutMs: number,
): Promise<OidcDiscoveryDocument> {
  const response = await fetcher(discoveryUrl(issuerUrl), {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error("OIDC discovery không khả dụng.");
  }

  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OIDC discovery trả metadata không hợp lệ.");
  }
  const metadata = value as Partial<OidcDiscoveryDocument>;
  if (
    metadata.issuer !== issuer ||
    typeof metadata.authorization_endpoint !== "string" ||
    typeof metadata.token_endpoint !== "string" ||
    typeof metadata.jwks_uri !== "string"
  ) {
    throw new Error("OIDC discovery không khớp với issuer đã cấu hình.");
  }

  if (
    !isStringArray(metadata.response_types_supported) ||
    !metadata.response_types_supported.includes("code")
  ) {
    throw new Error(
      "Authorization server discovery phải công bố response type code.",
    );
  }
  if (
    !isStringArray(metadata.code_challenge_methods_supported) ||
    !metadata.code_challenge_methods_supported.includes("S256")
  ) {
    throw new Error("Authorization server discovery phải công bố PKCE S256.");
  }
  for (const [field, value] of Object.entries({
    grant_types_supported: metadata.grant_types_supported,
    scopes_supported: metadata.scopes_supported,
    response_modes_supported: metadata.response_modes_supported,
    token_endpoint_auth_methods_supported:
      metadata.token_endpoint_auth_methods_supported,
    token_endpoint_auth_signing_alg_values_supported:
      metadata.token_endpoint_auth_signing_alg_values_supported,
  })) {
    if (value !== undefined && !isStringArray(value)) {
      throw new Error(`OIDC discovery có trường ${field} không hợp lệ.`);
    }
  }
  for (const [field, value] of Object.entries({
    client_id_metadata_document_supported:
      metadata.client_id_metadata_document_supported,
    authorization_response_iss_parameter_supported:
      metadata.authorization_response_iss_parameter_supported,
  })) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`OIDC discovery có trường ${field} không hợp lệ.`);
    }
  }

  requireHttpsUrl(metadata.authorization_endpoint, "authorization_endpoint");
  requireHttpsUrl(metadata.token_endpoint, "token_endpoint");
  requireHttpsUrl(metadata.jwks_uri, "jwks_uri");
  if (metadata.registration_endpoint) {
    requireHttpsUrl(metadata.registration_endpoint, "registration_endpoint");
  }
  if (metadata.revocation_endpoint) {
    requireHttpsUrl(metadata.revocation_endpoint, "revocation_endpoint");
  }
  return metadata as OidcDiscoveryDocument;
}

function scopesFromPayload(payload: Record<string, unknown>): string[] {
  const scope = payload.scope;
  if (typeof scope === "string") {
    return [...new Set(scope.split(/\s+/u).filter(Boolean))];
  }
  const scp = payload.scp;
  if (Array.isArray(scp) && scp.every((entry) => typeof entry === "string")) {
    return [...new Set(scp)];
  }
  return [];
}

function clientIdFromPayload(
  payload: Record<string, unknown>,
): string | undefined {
  for (const candidate of [payload.client_id, payload.azp]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function invalidToken(): OAuthError {
  return new OAuthError(
    OAuthErrorCode.InvalidToken,
    "Bearer access token không hợp lệ.",
  );
}

export async function deriveOidcOwnerId(
  issuer: string,
  subject: string,
): Promise<string> {
  requireHttpsUrl(issuer, "issuer");
  if (!subject || subject.trim() !== subject || subject.length > 1000) {
    throw new Error("OIDC subject không hợp lệ.");
  }
  const material = new TextEncoder().encode(
    `${OWNER_ID_DOMAIN}${issuer}\0${subject}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", material);
  const encoded = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  const ownerId = `oidc:v1:${encoded}`;
  return ownerIdSchema.parse(ownerId);
}

export async function createOidcAccessTokenVerifier(
  options: OidcAccessTokenVerifierOptions,
): Promise<OidcAccessTokenVerifier> {
  const issuer = options.issuer;
  const issuerUrl = requireHttpsUrl(issuer, "issuer");
  const audience = requireHttpsUrl(options.audience, "audience");
  if (audience.href !== options.audience) {
    throw new Error("audience phải ở dạng URL canonical HTTPS.");
  }
  const timeoutMs = options.discoveryTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("discoveryTimeoutMs phải là số nguyên dương.");
  }

  const fetcher: OidcFetch =
    options.fetch ?? ((input, init) => fetch(input, init));
  const discovery = await readDiscoveryDocument(
    issuer,
    issuerUrl,
    fetcher,
    timeoutMs,
  );
  const keySet = createRemoteJWKSet(new URL(discovery.jwks_uri), {
    timeoutDuration: timeoutMs,
    [customFetch]: async (url, init) =>
      fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      }),
  });

  const oauthMetadata: OAuthMetadata = {
    issuer: discovery.issuer,
    authorization_endpoint: discovery.authorization_endpoint,
    token_endpoint: discovery.token_endpoint,
    response_types_supported: [...discovery.response_types_supported],
    ...(discovery.grant_types_supported
      ? { grant_types_supported: [...discovery.grant_types_supported] }
      : {}),
    code_challenge_methods_supported: [
      ...discovery.code_challenge_methods_supported,
    ],
    ...(discovery.scopes_supported
      ? { scopes_supported: [...discovery.scopes_supported] }
      : {}),
    ...(discovery.registration_endpoint
      ? { registration_endpoint: discovery.registration_endpoint }
      : {}),
    ...(discovery.revocation_endpoint
      ? { revocation_endpoint: discovery.revocation_endpoint }
      : {}),
    ...(discovery.response_modes_supported
      ? { response_modes_supported: [...discovery.response_modes_supported] }
      : {}),
    ...(discovery.token_endpoint_auth_methods_supported
      ? {
          token_endpoint_auth_methods_supported: [
            ...discovery.token_endpoint_auth_methods_supported,
          ],
        }
      : {}),
    ...(discovery.token_endpoint_auth_signing_alg_values_supported
      ? {
          token_endpoint_auth_signing_alg_values_supported: [
            ...discovery.token_endpoint_auth_signing_alg_values_supported,
          ],
        }
      : {}),
    ...(discovery.client_id_metadata_document_supported !== undefined
      ? {
          client_id_metadata_document_supported:
            discovery.client_id_metadata_document_supported,
        }
      : {}),
    ...(discovery.authorization_response_iss_parameter_supported !== undefined
      ? {
          authorization_response_iss_parameter_supported:
            discovery.authorization_response_iss_parameter_supported,
        }
      : {}),
  };

  const verifyAccessToken = async (token: string): Promise<AuthInfo> => {
    try {
      const { payload } = await jwtVerify(token, keySet, {
        issuer,
        audience: audience.href,
        algorithms: [...ACCEPTED_JWT_ALGORITHMS],
      });
      if (
        typeof payload.sub !== "string" ||
        !payload.sub.trim() ||
        payload.sub.trim() !== payload.sub ||
        payload.sub.length > 1000 ||
        !Number.isSafeInteger(payload.exp) ||
        payload.exp === undefined
      ) {
        throw invalidToken();
      }

      const clientId = clientIdFromPayload(payload);
      if (!clientId) throw invalidToken();
      const ownerId = await deriveOidcOwnerId(issuer, payload.sub);
      return {
        token,
        clientId,
        scopes: scopesFromPayload(payload),
        expiresAt: payload.exp,
        resource: audience,
        extra: { ownerId },
      };
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      if (error instanceof joseErrors.JOSEError) throw invalidToken();
      throw error;
    }
  };

  return Object.freeze({ oauthMetadata, verifyAccessToken });
}
