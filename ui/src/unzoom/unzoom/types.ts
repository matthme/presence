import {
  SignedActionHashed,
  AgentPubKey,
  Create,
  Update,
  Delete,
  CreateLink,
  DeleteLink
} from '@holochain/client';

export type SdpOfferInput = {
  timestamp: number;
  offer: string;
  to_agents: AgentPubKey[];
  other_connected_peers?: AgentPubKey[];
}

export type SdpResponseInput = {
  offer_timestamp: number;
  response: string;
  to_agent: AgentPubKey;
}

export type UnzoomSignal = {
  type: 'Pong',
  from_agent: AgentPubKey,
} | {
  type: "SdpOffer",
  from_agent: AgentPubKey,
  timestamp: number,
  offer: string,
} | {
  type: "SdpResponse",
  from_agent: AgentPubKey,
  offer_timestamp: number,
  response: string,
} | {
  type: 'EntryCreated';
  action: SignedActionHashed<Create>;
  app_entry: EntryTypes;
} | {
  type: 'EntryUpdated';
  action: SignedActionHashed<Update>;
  app_entry: EntryTypes;
  original_app_entry: EntryTypes;
} | {
  type: 'EntryDeleted';
  action: SignedActionHashed<Delete>;
  original_app_entry: EntryTypes;
} | {
  type: 'LinkCreated';
  action: SignedActionHashed<CreateLink>;
  link_type: string;
} | {
  type: 'LinkDeleted';
  action: SignedActionHashed<DeleteLink>;
  link_type: string;
};

export type EntryTypes = {};
