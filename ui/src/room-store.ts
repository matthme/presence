import { asyncDerived, lazyLoadAndPoll } from '@holochain-open-dev/stores';
import { encodeHashToBase64 } from '@holochain/client';

import { RoomClient } from './room-client.js';

export class RoomStore {
  constructor(public client: RoomClient) {}

  /** Post */
  allAgents = lazyLoadAndPoll(async () => {
    const allAgents = await this.client.getAllAgents();
    return allAgents.filter((agent) => agent.toString() !== this.client.client.myPubKey.toString())
}, 3000);

  /**
   * Connections are to be initiated with agents who's public keys are alphabetically "lower" than our own public key
   */
  agentsToInitiate = asyncDerived(this.allAgents, (allAgents) => allAgents.filter((pubkey) => encodeHashToBase64(this.client.client.myPubKey) > encodeHashToBase64(pubkey)))
}
