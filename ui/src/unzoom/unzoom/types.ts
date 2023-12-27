import {
  SignedActionHashed,
  AgentPubKey,
  Create,
  Update,
  Delete,
  CreateLink,
  DeleteLink,
} from '@holochain/client';

export type InitAcceptInput = {
  connection_id: string;
  to_agent: AgentPubKey;
};

export type InitRequestInput = {
  connection_id: string;
  to_agent: AgentPubKey;
};

export type SdpDataInput = {
  to_agent: AgentPubKey;
  connection_id: string;
  data: string;
};

export type UnzoomSignal =
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
    }
  | {
      type: 'SdpData';
      from_agent: AgentPubKey;
      connection_id: string;
      data: string;
    }
  | {
      type: 'InitRequest';
      from_agent: AgentPubKey;
      connection_id: string;
    }
  | {
      type: 'InitAccept';
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
