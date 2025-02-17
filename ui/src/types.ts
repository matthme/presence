import {
  SignedActionHashed,
  AgentPubKey,
  Create,
  Update,
  Delete,
  CreateLink,
  DeleteLink,
  DnaHash,
  AgentPubKeyB64,
} from '@holochain/client';
import { WeaveClient } from '@theweave/api';
import { createContext } from '@lit/context';
import SimplePeer from 'simple-peer';

export const weaveClientContext = createContext<WeaveClient>('we_client');


/**
 * Frontend
 */

export type ConnectionId = string;

export type RTCMessage =
  | {
      type: 'action';
      message: 'video-off' | 'video-on' | 'audio-off' | 'audio-on' | 'change-audio-input' | 'change-video-input';
    }
  | {
      type: 'text';
      message: string;
    };

export type OpenConnectionInfo = {
  connectionId: ConnectionId;
  peer: SimplePeer.Instance;
  video: boolean;
  audio: boolean;
  connected: boolean;
  direction: 'outgoing' | 'incoming' | 'duplex'; // In which direction streams are expected
};

export type PendingInit = {
  /**
   * UUID to identify the connection
   */
  connectionId: ConnectionId;
  /**
   * Timestamp when init was sent. If InitAccept is not received within a certain duration
   * after t0, a next InitRequest is sent.
   */
  t0: number;
};

export type PendingAccept = {
  /**
   * UUID to identify the connection
   */
  connectionId: ConnectionId;
  /**
   * Peer instance that was created with this accept. Gets destroyed if another Peer object makes it through
   * to connected state instead for a connection with the same Agent.
   */
  peer: SimplePeer.Instance;
};

export type StreamInfo = {
  active: boolean;
};

export type TrackInfo = {
  kind: 'audio' | 'video';
  enabled: boolean;
  muted: boolean;
  readyState: 'live' | 'ended';
};

export type StreamAndTrackInfo = {
  stream: StreamInfo | null;
  tracks: TrackInfo[];
};

export type PongMetaData<T> = {
  formatVersion: number;
  data: T;
};

export type PongMetaDataV1 = {
  connectionStatuses: ConnectionStatuses;
  screenShareConnectionStatuses?: ConnectionStatuses;
  knownAgents?: Record<AgentPubKeyB64, AgentInfo>;
  appVersion?: string;
  /**
   * Info about how we see the stream of the peer to
   * which we're sending this PongMetaData
   */
  streamInfo?: StreamAndTrackInfo;
  /**
   * Info of whether we consider the audio of the peer
   * to be on or off
   */
  audio?: boolean;
  /**
   * Info of whether we consider the video of the peer
   * to be on or off
   */
  video?: boolean;
};

export type ConnectionStatuses = Record<AgentPubKeyB64, ConnectionStatus>;

/**
 * Connection status with a peer
 */
export type ConnectionStatus =
  | {
      /**
       * No WebRTC connection or freshly disconnected
       */
      type: 'Disconnected';
    }
  | {
      /**
       * Agent has been blocked by us
       */
      type: 'Blocked';
    }
  | {
      /**
       * Waiting for an init of a peer whose pubkey is alphabetically higher than ours
       */
      type: 'AwaitingInit';
    }
  | {
      /**
       * Waiting for an Accept of a peer whose pubkey is alphabetically lower than ours
       */
      type: 'InitSent';
      attemptCount?: number;
    }
  | {
      /**
       * Waiting for SDP exchange to start
       */
      type: 'AcceptSent';
      attemptCount?: number;
    }
  | {
      /**
       * SDP exchange is ongoing
       */
      type: 'SdpExchange';
    }
  | {
      /**
       * WebRTC connection is established
       */
      type: 'Connected';
    };

export type AgentInfo = {
  pubkey: AgentPubKeyB64;
  /**
   * If I know from the all_agents anchor that this agent exists in the Room, the
   * type is "known". If I've learnt about this agent only from other's Pong meta data
   * or from receiving a Pong from that agent themselves the type is "told".
   */
  type: 'known' | 'told';
  /**
   * last time when a PongUi from this agent was received
   */
  lastSeen?: number;
  appVersion?: string;
};

/**
 * EVENTS:
 *
 * my-video-on
 * my-video-off
 * my-audio-on
 * my-audio-off
 * my-screen-share-on
 * my-screen-share-off
 *
 * peer-connected
 * peer-disconnected
 * peer-audio-on
 * peer-audio-off
 * peer-video-on
 * peer-video-off
 *
 * error
 *
 */

export type StoreEventPayload =
  | {
      type: 'my-video-on';
    }
  | {
      type: 'my-video-off';
    }
  | {
      type: 'my-audio-on';
    }
  | {
      type: 'my-audio-off';
    }
  | {
      type: 'my-screen-share-on';
    }
  | {
      type: 'my-screen-share-off';
    }
  | {
      type: 'peer-audio-on';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-stream';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
      stream: MediaStream;
    }
  | {
      type: 'peer-audio-off';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-video-on';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-video-off';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-screen-share-stream';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
      stream: MediaStream;
    }
  | {
      type: 'peer-screen-share-track';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
      track: MediaStreamTrack;
    }
  | {
      type: 'peer-connected';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-disconnected';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-screen-share-connected';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'peer-screen-share-disconnected';
      pubKeyB64: AgentPubKeyB64;
      connectionId: ConnectionId;
    }
  | {
      type: 'error';
      error: string;
    };



/**
 * Backend
 */

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
