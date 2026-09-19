import {
  InMemoryDeviceCredentialRepository,
} from "./device-credential";
import { InMemoryDeviceRepository } from "./device-repository";
import { InMemoryPairingSessionRepository } from "./pairing";
import { describePersistentRepositoryContract } from "./persistent-repository-contract-suite";

describePersistentRepositoryContract("InMemory", ({ now, generateDeviceId }) => {
  const devices = new InMemoryDeviceRepository({ now, generateDeviceId });
  return {
    devices,
    credentials: new InMemoryDeviceCredentialRepository(),
    pairings: new InMemoryPairingSessionRepository(devices, { now }),
  };
});
