import { lazyLoadAndPoll } from '@holochain-open-dev/stores';
import { LazyHoloHashMap } from '@holochain-open-dev/utils';
import { ActionHash } from '@holochain/client';

import { UnzoomClient } from './unzoom-client.js';

export class UnzoomStore {
  constructor(public client: UnzoomClient) {}

  /** Post */

  allAgents = lazyLoadAndPoll(async () => this.client.getAllAgents(), 3000);
}
