import { beforeAll, describe, expect, test } from "bun:test";
import { type OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import {
  createOidcAccessTokenVerifier,
  deriveOidcOwnerId,
  type OidcFetch,
} from "./public-mcp-auth";

const ISSUER = "https://login.example.test/";
const AUDIENCE = "https://api.example.test/mcp";

describe("OIDC public MCP token verifier", () => {
  const keyPairPromise = generateKeyPair("RS256");
  let sign: (claims?: JWTPayload) => Promise<string>;
  let signCustom: (options: {
    claims?: JWTPayload;
    issuer?: string;
    audience?: string;
    subject?: string;
    expiration?: string;
  }) => Promise<string>;
  let fetchImpl: OidcFetch;
  const requestedUrls: string[] = [];

  beforeAll(async () => {
    const { publicKey, privateKey } = await keyPairPromise;
    const jwk = await exportJWK(publicKey);
    jwk.kid = "mcp-test-key";
    jwk.alg = "RS256";
    const jwks = { keys: [jwk] };
    fetchImpl = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (
        url === "https://login.example.test/.well-known/openid-configuration"
      ) {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: "https://login.example.test/authorize",
          token_endpoint: "https://login.example.test/token",
          jwks_uri: "https://login.example.test/.well-known/jwks.json",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
          token_endpoint_auth_signing_alg_values_supported: ["RS256"],
        });
      }
      if (url === "https://login.example.test/.well-known/jwks.json") {
        return Response.json(jwks);
      }
      return new Response("not found", { status: 404 });
    };
    sign = (claims = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "mcp-test-key" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject("user-123")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    signCustom = ({
      claims = {},
      issuer = ISSUER,
      audience = AUDIENCE,
      subject = "user-123",
      expiration = "5m",
    }) => {
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "mcp-test-key" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt();
      if (subject) jwt.setSubject(subject);
      if (expiration) jwt.setExpirationTime(expiration);
      return jwt.sign(privateKey);
    };
  });

  test("discovers issuer metadata, verifies JWT, and derives a stable opaque owner", async () => {
    const verifier = await createOidcAccessTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: fetchImpl,
    });
    const token = await sign({ scope: "mcp profile", client_id: "chatgpt" });
    const info = await verifier.verifyAccessToken(token);

    expect(info.clientId).toBe("chatgpt");
    expect(info.scopes).toEqual(["mcp", "profile"]);
    expect(info.extra?.ownerId).toMatch(/^oidc:v1:[A-Za-z0-9_-]{43}$/);
    expect(info.extra?.ownerId).toBe(
      (await verifier.verifyAccessToken(token)).extra?.ownerId,
    );
    const sameUserDifferentClient = await verifier.verifyAccessToken(
      await sign({ scope: "mcp", client_id: "another-client" }),
    );
    expect(sameUserDifferentClient.extra?.ownerId).toBe(info.extra?.ownerId);
    const differentUser = await verifier.verifyAccessToken(
      await signCustom({
        subject: "user-456",
        claims: { scope: "mcp", client_id: "chatgpt" },
      }),
    );
    expect(differentUser.extra?.ownerId).not.toBe(info.extra?.ownerId);
    expect(verifier.oauthMetadata.issuer).toBe(ISSUER);
    expect(verifier.oauthMetadata).toMatchObject({
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      token_endpoint_auth_signing_alg_values_supported: ["RS256"],
    });
  });

  test("requires the authorization server to advertise PKCE S256", async () => {
    const withoutPkce: OidcFetch = async (input, init) => {
      const response = await fetchImpl(input, init);
      if (
        String(input) ===
        "https://login.example.test/.well-known/openid-configuration"
      ) {
        const metadata = await response.json();
        return Response.json({
          ...(metadata as Record<string, unknown>),
          code_challenge_methods_supported: ["plain"],
        });
      }
      return response;
    };

    await expect(
      createOidcAccessTokenVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        fetch: withoutPkce,
      }),
    ).rejects.toThrow();
  });

  test("does not advertise a refresh grant the authorization server omits", async () => {
    const withoutRefreshGrant: OidcFetch = async (input, init) => {
      const response = await fetchImpl(input, init);
      if (
        String(input) ===
        "https://login.example.test/.well-known/openid-configuration"
      ) {
        const metadata = (await response.json()) as Record<string, unknown>;
        delete metadata.grant_types_supported;
        return Response.json(metadata);
      }
      return response;
    };
    const verifier = await createOidcAccessTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: withoutRefreshGrant,
    });

    expect(verifier.oauthMetadata.grant_types_supported).toBeUndefined();
  });

  test("rejects token with wrong issuer or audience", async () => {
    const verifier = await createOidcAccessTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: fetchImpl,
    });
    const wrongIssuer = await signCustom({ issuer: "https://attacker.test/" });
    const wrongAudience = await signCustom({
      audience: "https://other.example.test/",
    });

    await expect(verifier.verifyAccessToken(wrongIssuer)).rejects.toThrow();
    await expect(verifier.verifyAccessToken(wrongAudience)).rejects.toThrow();
  });

  test("rejects missing subject or expiry and expired tokens", async () => {
    const verifier = await createOidcAccessTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: fetchImpl,
    });
    const noSubject = await signCustom({ subject: "" });
    const noExpiry = await new SignJWT({ scope: "mcp", client_id: "chatgpt" })
      .setProtectedHeader({ alg: "RS256", kid: "mcp-test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("user-123")
      .sign((await keyPairPromise).privateKey);
    const noClientId = await signCustom({
      claims: { scope: "mcp" },
    });
    const expired = await signCustom({ expiration: "-1m" });

    await expect(verifier.verifyAccessToken(noSubject)).rejects.toThrow();
    await expect(verifier.verifyAccessToken(noExpiry)).rejects.toThrow();
    await expect(verifier.verifyAccessToken(noClientId)).rejects.toThrow();
    await expect(verifier.verifyAccessToken(expired)).rejects.toThrow();
  });

  test("rejects a cryptographically valid subject with surrounding whitespace as an invalid token", async () => {
    const verifier = await createOidcAccessTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: fetchImpl,
    });

    await expect(
      verifier.verifyAccessToken(
        await signCustom({
          subject: " user-123",
          claims: { scope: "mcp", client_id: "chatgpt" },
        }),
      ),
    ).rejects.toMatchObject({
      code: OAuthErrorCode.InvalidToken,
    } satisfies Partial<OAuthError>);
  });

  test("rejects a cryptographically valid subject longer than 1000 characters as an invalid token", async () => {
    const verifier = await createOidcAccessTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: fetchImpl,
    });

    await expect(
      verifier.verifyAccessToken(
        await signCustom({
          subject: "a".repeat(1001),
          claims: { scope: "mcp", client_id: "chatgpt" },
        }),
      ),
    ).rejects.toMatchObject({
      code: OAuthErrorCode.InvalidToken,
    } satisfies Partial<OAuthError>);
  });

  test("rejects a JWT with a forged signature even when it reuses the trusted key id", async () => {
    const verifier = await createOidcAccessTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: fetchImpl,
    });
    const forgedKey = await generateKeyPair("RS256");
    const forged = await new SignJWT({ scope: "mcp", client_id: "chatgpt" })
      .setProtectedHeader({ alg: "RS256", kid: "mcp-test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("user-123")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(forgedKey.privateKey);

    await expect(verifier.verifyAccessToken(forged)).rejects.toThrow();
  });

  test("rejects issuer discovery metadata that does not match configured issuer", async () => {
    const mismatchedFetch: OidcFetch = async () =>
      Response.json({
        issuer: "https://different.example.test/",
        authorization_endpoint: "https://different.example.test/authorize",
        token_endpoint: "https://different.example.test/token",
        jwks_uri: "https://different.example.test/jwks",
      });

    await expect(
      createOidcAccessTokenVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        fetch: mismatchedFetch,
      }),
    ).rejects.toThrow();
  });

  test("preserves an issuer without a trailing slash for discovery, JWT, and owner identity", async () => {
    const issuer = "https://login.example.test";
    const issuerFetch: OidcFetch = async (input, init) => {
      const response = await fetchImpl(input, init);
      if (
        String(input) ===
        "https://login.example.test/.well-known/openid-configuration"
      ) {
        const metadata = (await response.json()) as Record<string, unknown>;
        return Response.json({ ...metadata, issuer });
      }
      return response;
    };
    const verifier = await createOidcAccessTokenVerifier({
      issuer,
      audience: AUDIENCE,
      fetch: issuerFetch,
    });
    const info = await verifier.verifyAccessToken(
      await signCustom({
        issuer,
        claims: { scope: "mcp", client_id: "chatgpt" },
      }),
    );

    expect(verifier.oauthMetadata.issuer).toBe(issuer);
    expect(info.extra?.ownerId).toBe(
      await deriveOidcOwnerId(issuer, "user-123"),
    );
    expect(info.extra?.ownerId).not.toBe(
      await deriveOidcOwnerId(`${issuer}/`, "user-123"),
    );
  });

  test("rejects discovery issuer that differs only by trailing slash", async () => {
    const issuer = "https://login.example.test";
    const mismatchedFetch: OidcFetch = async (input, init) => {
      const response = await fetchImpl(input, init);
      if (
        String(input) ===
        "https://login.example.test/.well-known/openid-configuration"
      ) {
        const metadata = (await response.json()) as Record<string, unknown>;
        return Response.json({ ...metadata, issuer: `${issuer}/` });
      }
      return response;
    };

    await expect(
      createOidcAccessTokenVerifier({
        issuer,
        audience: AUDIENCE,
        fetch: mismatchedFetch,
      }),
    ).rejects.toThrow();
  });

  test("pins remote JWKS loading to the configured fetch and audience", async () => {
    requestedUrls.length = 0;
    const verifier = await createOidcAccessTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: fetchImpl,
    });
    expect(
      await verifier.verifyAccessToken(
        await sign({ scp: ["mcp"], client_id: "chatgpt" }),
      ),
    ).toMatchObject({
      scopes: ["mcp"],
    });
    expect(requestedUrls).toEqual([
      "https://login.example.test/.well-known/openid-configuration",
      "https://login.example.test/.well-known/jwks.json",
    ]);
  });
});
