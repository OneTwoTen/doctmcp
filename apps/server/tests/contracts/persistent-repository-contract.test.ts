import { InMemoryDeviceCredentialRepository } from "../../src/device-credential";
import { InMemoryDeviceRepository } from "../../src/device-repository";
import { InMemoryPairingSessionRepository } from "../../src/pairing";
import { describeDeviceRepositoryContract } from "./device-repository-contract-suite";
import { describePersistentRepositoryContract } from "./persistent-repository-contract-suite";

describePersistentRepositoryContract(
  "InMemory",
  ({ now, generateDeviceId }) => {
    const devices = new InMemoryDeviceRepository({ now, generateDeviceId });
    return {
      devices,
      credentials: new InMemoryDeviceCredentialRepository(),
      pairings: new InMemoryPairingSessionRepository(devices, { now }),
    };
  },
);

describeDeviceRepositoryContract("InMemory", (options) => ({
  repository: new InMemoryDeviceRepository(options),
}));
