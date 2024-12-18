import {
  SignedActionHashed,
  AgentPubKey,
  Create,
  Update,
  Delete,
  CreateLink,
  DeleteLink,
  DnaHash,
} from '@holochain/client';
import { WeaveClient } from '@theweave/api';
import { createContext } from '@lit/context';

export const weaveClientContext = createContext<WeaveClient>('we_client');

export type RoomInfo = {
  name: string;
  icon_src: string | undefined;
  meta_data: string | undefined;
};

export type Attachment = {
  wal: string;
};

export type DescendentRoom = {
  network_seed_appendix: string;
  dna_hash: DnaHash;
  name: string;
  icon_src: string | undefined;
  meta_data: string | undefined;
};

export type PongInput = {
  to_agent: AgentPubKey;
  meta_data: string;
};

export type InitAcceptInput = {
  connection_id: string;
  to_agent: AgentPubKey;
  connection_type?: 'screen' | 'video';
};

export type InitRequestInput = {
  connection_id: string;
  to_agent: AgentPubKey;
  connection_type?: 'screen' | 'video';
};

export type SdpDataInput = {
  to_agent: AgentPubKey;
  connection_id: string;
  data: string;
};

export type RoomSignal =
  | {
      type: 'Pong';
      from_agent: AgentPubKey;
    }
  | {
      type: 'PingUi';
      from_agent: AgentPubKey;
    }
  | {
      type: 'PongUi';
      from_agent: AgentPubKey;
      meta_data: string;
    }
  | {
      type: 'SdpData';
      from_agent: AgentPubKey;
      connection_id: string;
      data: string;
    }
  | {
      type: 'InitRequest';
      connection_type: string | undefined;
      from_agent: AgentPubKey;
      connection_id: string;
    }
  | {
      type: 'InitAccept';
      connection_type: string | undefined;
      from_agent: AgentPubKey;
      connection_id: string;
    }
  | {
      type: 'EntryCreated';
      action: SignedActionHashed<Create>;
      app_entry: EntryTypes;
    }
  | {
      type: 'EntryUpdated';
      action: SignedActionHashed<Update>;
      app_entry: EntryTypes;
      original_app_entry: EntryTypes;
    }
  | {
      type: 'EntryDeleted';
      action: SignedActionHashed<Delete>;
      original_app_entry: EntryTypes;
    }
  | {
      type: 'LinkCreated';
      action: SignedActionHashed<CreateLink>;
      link_type: string;
    }
  | {
      type: 'LinkDeleted';
      action: SignedActionHashed<DeleteLink>;
      link_type: string;
    };

export type EntryTypes = {};
