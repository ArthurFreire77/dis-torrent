import type { UserIdentity } from '../identity/identity'
import type { StorageDriver } from './driver'

const KEY_ID = 'identity'
const KEY_PRIV = 'identity:priv' // separado, nunca exposto para UI diretamente

export class IdentityStore {
  constructor(private driver: StorageDriver) {}
  load(): UserIdentity | null { return this.driver.get<UserIdentity>(KEY_ID) }
  loadPrivHex(): string | null { return this.driver.get<string>(KEY_PRIV) }
  save(identity: UserIdentity, privHex: string): void {
    this.driver.set(KEY_ID, identity)
    this.driver.set(KEY_PRIV, privHex)
  }
  clear(): void { this.driver.remove(KEY_ID); this.driver.remove(KEY_PRIV) }
}
