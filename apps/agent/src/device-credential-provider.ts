export interface LocalDeviceCredential {
  readonly deviceId: string;
  readonly credential: string;
}

export type LocalDeviceCredentialProviderErrorCode =
  | "INVALID_CREDENTIAL_RECORD"
  | "CREDENTIAL_STORAGE_INVALID"
  | "CREDENTIAL_STORAGE_FAILED";

export class LocalDeviceCredentialProviderError extends Error {
  constructor(
    public readonly code: LocalDeviceCredentialProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalDeviceCredentialProviderError";
  }
}

export interface DeviceCredentialProvider {
  load(): Promise<LocalDeviceCredential | null>;
  replace(credential: LocalDeviceCredential): Promise<void>;
}

export class InMemoryDeviceCredentialProvider
  implements DeviceCredentialProvider
{
  load(): Promise<LocalDeviceCredential | null> {
    return Promise.resolve(null);
  }

  replace(_credential: LocalDeviceCredential): Promise<void> {
    return Promise.reject(new Error("Not implemented"));
  }
}

export class FileDeviceCredentialProvider implements DeviceCredentialProvider {
  constructor(readonly path: string) {}

  load(): Promise<LocalDeviceCredential | null> {
    return Promise.resolve(null);
  }

  replace(_credential: LocalDeviceCredential): Promise<void> {
    return Promise.reject(new Error("Not implemented"));
  }
}
