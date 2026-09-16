export interface DeviceCredentialLifecycleCoordinator {
  runExclusive<T>(
    deviceId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Single-process reference coordinator. Production deployments with multiple
 * server instances must inject a coordinator backed by a shared/distributed
 * per-device lease or another equivalent serialization primitive.
 */
export class InMemoryDeviceCredentialLifecycleCoordinator
  implements DeviceCredentialLifecycleCoordinator
{
  readonly #tails = new Map<string, Promise<void>>();

  async runExclusive<T>(
    deviceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tails.get(deviceId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(deviceId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(deviceId) === tail) {
        this.#tails.delete(deviceId);
      }
    }
  }
}
