import SimplePeer from 'simple-peer';
import {
  AgentPubKey,
  AgentPubKeyB64,
  decodeHashFromBase64,
  encodeHashToBase64,
} from '@holochain/client';
import { get, writable, Writable } from '@holochain-open-dev/stores';
import { v4 as uuidv4 } from 'uuid';
import { RoomSignal } from './types';
import { RoomClient } from './room-client';
import { RoomStore } from './room-store';

declare const __APP_VERSION__: string;

const ICE_CONFIG = [
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/**
 * If an InitRequest does not succeed within this duration (ms) another InitRequest will be sent
 */
const INIT_RETRY_THRESHOLD = 5000;

const PING_INTERVAL = 2000;

type ConnectionId = string;

type RTCMessage =
  | {
      type: 'action';
      message: 'video-off' | 'audio-off' | 'audio-on';
    }
  | {
      type: 'text';
      message: string;
    };

type OpenConnectionInfo = {
  connectionId: ConnectionId;
  peer: SimplePeer.Instance;
  video: boolean;
  audio: boolean;
  connected: boolean;
  direction: 'outgoing' | 'incoming' | 'duplex'; // In which direction streams are expected
};

type PendingInit = {
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

type PendingAccept = {
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

type PongMetaData<T> = {
  formatVersion: number;
  data: T;
};

type PongMetaDataV1 = {
  connectionStatuses: ConnectionStatuses;
  screenShareConnectionStatuses?: ConnectionStatuses;
  knownAgents?: Record<AgentPubKeyB64, AgentInfo>;
  appVersion?: string;
};

type ConnectionStatuses = Record<AgentPubKeyB64, ConnectionStatus>;

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

type AgentInfo = {
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
 * A store that handles the creation and management of WebRTC streams with
 * holochain peers
 */
export class StreamsStore {
  roomClient: RoomClient;

  myPubKey: AgentPubKey;

  myPubKeyB64: AgentPubKeyB64;

  signalUnsubscribe: () => void;

  pingInterval: number | undefined;

  roomStore: RoomStore;

  allAgents: AgentPubKey[] = [];

  screenSourceSelection: () => Promise<string>;

  constructor(roomStore: RoomStore, screenSourceSelection: () => Promise<string>) {
    this.roomStore = roomStore;
    this.screenSourceSelection = screenSourceSelection;
    const roomClient = roomStore.client;
    this.roomClient = roomClient;
    this.myPubKey = roomClient.client.myPubKey;
    this.myPubKeyB64 = encodeHashToBase64(roomClient.client.myPubKey);
    // TODO potentially move this to a connect() method which also returns
    // the Unsubscribe function
    this.signalUnsubscribe = this.roomClient.onSignal(async signal =>
      this.handleSignal(signal)
    );
  }

  async connect(roomStore: RoomStore, screenSourceSelection: () => Promise<string>): Promise<StreamsStore> {
    const streamsStore = new StreamsStore(roomStore, screenSourceSelection);

    this.roomStore.allAgents.subscribe(val => {
      if (val.status === 'complete') {
        this.allAgents = val.value;
      } else if (val.status === 'error') {
        console.error('Failed to get all agents: ', val.error);
      }
    });

    // ping all agents that are not already connected to you every PING_INTERVAL milliseconds
    await this.pingAgents();
    this.pingInterval = window.setInterval(async () => {
      await this.pingAgents();
    }, PING_INTERVAL);
    return streamsStore;
  }

  async disconnect() {
    if (this.pingInterval) window.clearInterval(this.pingInterval);
    if (this.signalUnsubscribe) this.signalUnsubscribe();
    // TODO Close all connections and stop all streams
    Object.values(get(this._openConnections)).forEach(conn => {
      conn.peer.destroy();
    });
    this.videoOff();
    this.audioOff();
    this.screenShareOff();
    this.mainStream = null;
    this.screenShareStream = null;
    this._openConnections.set({});
    this._screenShareConnectionsOutgoing.set({});
    this._screenShareConnectionsIncoming.set({});
    this._pendingAccepts = {};
    this._pendingInits = {};
  }

  async pingAgents() {
    const knownAgents = get(this._knownAgents);
    this.allAgents
      .map(agent => encodeHashToBase64(agent))
      .forEach(agentB64 => {
        if (agentB64 !== this.myPubKeyB64) {
          const alreadyKnown = knownAgents[agentB64];
          if (alreadyKnown && alreadyKnown.type !== 'known') {
            knownAgents[agentB64] = {
              pubkey: agentB64,
              type: 'known',
              lastSeen: alreadyKnown.lastSeen,
              appVersion: alreadyKnown.appVersion,
            };
          } else if (!alreadyKnown) {
            knownAgents[agentB64] = {
              pubkey: agentB64,
              type: 'known',
              lastSeen: undefined,
              appVersion: undefined,
            };
          }
        }
      });
    // NOTE: There is a minor chance that this._knownAgents changes as a result from code
    // elsewhere while we looped through this.allAgents above and we're overwriting these
    // changes from elsewhere here. But we consider this possibility negligible for now.
    this._knownAgents.set(knownAgents);

    // Update connection statuses with known people for which we do not yet have a connection status
    this._connectionStatuses.update(currentValue => {
      const connectionStatuses = currentValue;
      Object.keys(get(this._knownAgents)).forEach(agentB64 => {
        if (!connectionStatuses[agentB64]) {
          connectionStatuses[agentB64] = {
            type: 'Disconnected',
          };
        }
      });
      return connectionStatuses;
    });

    // Ping known agents
    // This could potentially be optimized by only pinging agents that are online according to Moss (which would only work in shared rooms though)
    const agentsToPing = Object.keys(get(this._knownAgents)).map(pubkeyB64 =>
      decodeHashFromBase64(pubkeyB64)
    );
    await this.roomStore.client.pingFrontend(agentsToPing);
  }

  async videoOn() {
    if (this.mainStream) {
      if (this.mainStream.getVideoTracks()[0]) {
        console.log('### CASE A');
        this.mainStream.getVideoTracks()[0].enabled = true;
      } else {
        console.log('### CASE B');
        let videoStream: MediaStream | undefined;
        try {
          videoStream = await navigator.mediaDevices.getUserMedia({
            video: true,
          });
        } catch (e: any) {
          console.error(`Failed to get media devices (video): ${e.toString()}`);

          // TODO CALL ERROR CALLBACK
          return;
        }
        if (!videoStream) {
          // TODO CALL ERROR CALLBACK
          console.error('Video stream undefined after getUserMedia.');
          return;
        }
        this.mainStream.addTrack(videoStream.getVideoTracks()[0]);
        /// TODO CALL OWN VIDEO ON CALLBACK
        try {
          Object.values(get(this._openConnections)).forEach(conn => {
            conn.peer.addTrack(
              videoStream.getVideoTracks()[0],
              this.mainStream!
            );
          });
        } catch (e: any) {
          console.error(`Failed to add video track: ${e.toString()}`);
        }
      }
    } else {
      try {
        this.mainStream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
      } catch (e: any) {
        console.error(`Failed to get media devices (video): ${e.toString()}`);
        // TODO CALL ERROR CALLBACK
        return;
      }
      /// TODO CALL OWN VIDEO ON CALLBACK
      try {
        Object.values(get(this._openConnections)).forEach(conn => {
          conn.peer.addStream(this.mainStream!);
        });
      } catch (e: any) {
        console.error(`Failed to add video track: ${e.toString()}`);
        // TODO CALL ERROR CALLBACK
      }
    }
  }

  videoOff() {
    if (this.mainStream) {
      this.mainStream.getVideoTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.stop();
      });
      Object.values(get(this._openConnections)).forEach(conn => {
        try {
          this.mainStream!.getVideoTracks().forEach(track => {
            conn.peer.removeTrack(track, this.mainStream!);
          });
        } catch (e) {
          console.warn('Could not remove video track from peer: ', e);
          // TODO CALL WARN CALLBACK
        }
        const msg: RTCMessage = {
          type: 'action',
          message: 'video-off',
        };
        try {
          conn.peer.send(JSON.stringify(msg));
        } catch (e) {
          console.warn('Could not send video-off message to peer: ', e);
          // TODO CALL WARN CALLBACK
        }
      });
      this.mainStream.getVideoTracks().forEach(track => {
        this.mainStream!.removeTrack(track);
      });
      // TODO CALL MY-VIDEO-OFF CALLBACK
    }
  }

  async audioOn() {
    if (this.mainStream) {
      if (this.mainStream.getAudioTracks()[0]) {
        this.mainStream.getAudioTracks()[0].enabled = true;
      } else {
        let audioStream: MediaStream | undefined;
        try {
          audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              noiseSuppression: true,
              echoCancellation: true,
            },
          });
        } catch (e: any) {
          console.error(`Failed to get media devices (audio): ${e.toString()}`);
          // TODO CALL ERROR CALLBACK
          return;
        }
        try {
          this.mainStream.addTrack(audioStream.getAudioTracks()[0]);
          Object.values(get(this._openConnections)).forEach(conn => {
            conn.peer.addTrack(
              audioStream.getAudioTracks()[0],
              this.mainStream!
            );
          });
        } catch (e: any) {
          console.error(`Failed to add video track: ${e.toString()}`);
        }
      }
    } else {
      try {
        this.mainStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: true,
            echoCancellation: true,
          },
        });
        // TODO CALL MY-AUDIO-ON CALLBACK
      } catch (e: any) {
        console.error(`Failed to get media devices (audio): ${e.toString()}`);
        // TODO CALL ERROR CALLBACK
        return;
      }
      Object.values(get(this._openConnections)).forEach(conn => {
        conn.peer.addStream(this.mainStream!);
      });
    }
    // TODO CALL MY-AUDIO-ON CALLBACK
    Object.values(get(this._openConnections)).forEach(conn => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'audio-on',
      };
      try {
        conn.peer.send(JSON.stringify(msg));
      } catch (e: any) {
        console.error(
          "Failed to send 'audio-on' message to peer: ",
          e.toString()
        );
        // TODO CALL ERROR CALLBACK
      }
    });
  }

  audioOff() {
    console.log('### AUDIO OFF');
    console.log(
      'this._mainStream.getTracks(): ',
      this.mainStream?.getTracks()
    );
    if (this.mainStream) {
      console.log('### DISABLING ALL AUDIO TRACKS');
      this.mainStream.getAudioTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = false;
        console.log('### DISABLED AUDIO TRACK: ', track);
      });
      Object.values(get(this._openConnections)).forEach(conn => {
        const msg: RTCMessage = {
          type: 'action',
          message: 'audio-off',
        };
        try {
          conn.peer.send(JSON.stringify(msg));
        } catch (e: any) {
          console.error(
            'Failed to send audio-off message to peer: ',
            e.toString()
          );
        }
      });
      // TODO CALL MY-AUDIO-OFF CALLBACK
    }
  }

  async screenShareOn() {
    if (this.screenShareStream) {
      this.screenShareStream.getVideoTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = true;
      });
    } else {
      try {
        const screenSource = await this.screenSourceSelection();
        this.screenShareStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSource,
            },
          } as any,
        });
      } catch (e: any) {
        console.error(
          `Failed to get media devices (screen share): ${e.toString()}`
        );
      }
      // TODO CALL MY-SCREEN-SHARE-ON CALLBACK
      Object.values(get(this._screenShareConnectionsOutgoing)).forEach(conn => {
        if (this.screenShareStream) {
          conn.peer.addStream(this.screenShareStream);
        }
      });
    }
  }

  /**
   * Turning screen sharing off is equivalent to closing the corresponding peer connection
   */
  screenShareOff() {
    if (this.screenShareStream) {
      this.screenShareStream.getVideoTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.stop();
      });
      Object.values(get(this._screenShareConnectionsOutgoing)).forEach(conn => {
        conn.peer.destroy();
      });
      this.screenShareStream = null;
      // TODO CALL MY-SCREEN-SHARE-OFF CALLBACK
    }
  }

  // ===========================================================================================
  // WEBRTC STREAMS
  // ===========================================================================================

  /**
   * Our own video/audio stream
   */
  mainStream: MediaStream | undefined | null;

  /**
   * Our own screen share stream
   */
  screenShareStream: MediaStream | undefined | null;

  // ===========================================================================================
  // CONNECTION ESTABLISHMENT
  // ===========================================================================================

  /**
   * Pending Init requests
   */
  _pendingInits: Record<AgentPubKeyB64, PendingInit[]> = {};

  /**
   * Pending Accepts
   */
  _pendingAccepts: Record<AgentPubKeyB64, PendingAccept[]> = {};

  /**
   * Pending Init requests for screen sharing
   */
  _pendingScreenShareInits: Record<AgentPubKeyB64, PendingInit[]> = {};

  /**
   * Pending Init Accepts for screen sharing
   */
  _pendingScreenShareAccepts: Record<AgentPubKeyB64, PendingAccept[]> = {};

  // ********************************************************************************************
  //
  //   W R I T A B L E   S T O R E S
  //
  // ********************************************************************************************

  // ===========================================================================================
  // ACTIVE CONNECTIONS
  // ===========================================================================================

  /**
   * Connections where the Init/Accept handshake succeeded and we have an active WebRTC connection
   */
  _openConnections: Writable<Record<AgentPubKeyB64, OpenConnectionInfo>> =
    writable({});

  /**
   * Connections where we are sharing our own screen and the Init/Accept handshake succeeded
   */
  _screenShareConnectionsOutgoing: Writable<
    Record<AgentPubKeyB64, OpenConnectionInfo>
  > = writable({});

  /**
   * Connections where others are sharing their screen and the Init/Accept handshake succeeded
   */
  _screenShareConnectionsIncoming: Writable<
    Record<AgentPubKeyB64, OpenConnectionInfo>
  > = writable({});

  // ===========================================================================================
  // CONNECTION META DATA
  // ===========================================================================================

  /**
   * Agents in the room that we know exist either because we saw their public key
   * linked from the ALL_AGENTS anchor ourselves or because we learnt via remote
   * signals from other peers that their public key is linked from the ALL_AGENTS
   * anchor (in case this hasn't gossiped to us yet).
   */
  _knownAgents: Writable<Record<AgentPubKeyB64, AgentInfo>> = writable({});

  /**
   * The statuses of WebRTC main stream connections to peers
   */
  _connectionStatuses: Writable<ConnectionStatuses> = writable({});

  /**
   * The statuses of WebRTC connections with peers to our own screen share
   * stream
   */
  _screenShareConnectionStatuses: Writable<ConnectionStatuses> = writable({});

  /**
   * Connection statuses of other peers from their perspective. Is sent to us
   * via remote signals (as part of pingAgents())
   */
  _othersConnectionStatuses: Writable<
    Record<
      AgentPubKeyB64,
      {
        lastUpdated: number;
        statuses: ConnectionStatuses;
        /**
         * Connection statuses to their screen share in case their sharing screen
         */
        screenShareStatuses?: ConnectionStatuses;
        knownAgents?: Record<AgentPubKeyB64, AgentInfo>;
      }
    >
  > = writable({});

  // ********************************************************************************************
  //
  //   S I M P L E   P E E R   H A N D L I N G
  //
  // ********************************************************************************************

  createPeer(
    connectingAgent: AgentPubKey,
    connectionId: string,
    initiator: boolean
  ): SimplePeer.Instance {
    const pubKey64 = encodeHashToBase64(connectingAgent);
    const options: SimplePeer.Options = {
      initiator,
      config: {
        iceServers: ICE_CONFIG,
      },
      objectMode: true,
      trickle: true,
    };
    const peer = new SimplePeer(options);
    peer.on('signal', async data => {
      this.roomClient.sendSdpData({
        to_agent: connectingAgent,
        connection_id: connectionId,
        data: JSON.stringify(data),
      });
    });
    peer.on('data', data => {
      try {
        const msg: RTCMessage = JSON.parse(data);
        if (msg.type === 'action') {
          if (msg.message === 'video-off') {
            this._openConnections.update(currentValue => {
              const openConnections = currentValue;
              const relevantConnection = openConnections[pubKey64];
              relevantConnection.video = false;
              openConnections[pubKey64] = relevantConnection;
              return openConnections;
            });
          }
          if (msg.message === 'audio-off') {
            this._openConnections.update(currentValue => {
              const openConnections = currentValue;
              const relevantConnection = openConnections[pubKey64];
              relevantConnection.audio = false;
              openConnections[pubKey64] = relevantConnection;
              return openConnections;
            });
          }
          if (msg.message === 'audio-on') {
            this._openConnections.update(currentValue => {
              const openConnections = currentValue;
              const relevantConnection = openConnections[pubKey64];
              relevantConnection.audio = true;
              openConnections[pubKey64] = relevantConnection;
              return openConnections;
            });
          }
        }
      } catch (e) {
        console.warn(
          `Failed to parse RTCMessage: ${JSON.stringify(
            e
          )}. Got message: ${data}}`
        );
      }
    });
    peer.on('stream', stream => {
      console.log('#### GOT STREAM with tracks: ', stream.getTracks());
      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        const relevantConnection = openConnections[pubKey64];
        if (relevantConnection) {
          if (stream.getAudioTracks().length > 0) {
            relevantConnection.audio = true;
          }
          if (stream.getVideoTracks().length > 0) {
            relevantConnection.video = true;
          }
          openConnections[encodeHashToBase64(connectingAgent)] =
            relevantConnection;
          // TODO CALL CALLBACK HERE FOR AGENT JOINED --> should make sure that video element is ready.
          // try {
          //   const videoEl = this.shadowRoot?.getElementById(connectionId) as
          //     | HTMLVideoElement
          //     | undefined;
          //   if (videoEl) {
          //     videoEl.autoplay = true;
          //     videoEl.srcObject = stream;
          //   }
          // } catch (e) {
          //   console.error('Failed to play video: ', e);
          // }
        }
        return openConnections;
      });
    });
    peer.on('track', track => {
      console.log('#### GOT TRACK: ', track);
      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        const relevantConnection = openConnections[pubKey64];
        if (track.kind === 'audio') {
          relevantConnection.audio = true;
        }
        if (track.kind === 'video') {
          relevantConnection.video = true;
        }
        openConnections[pubKey64] = relevantConnection;
        return openConnections;
      });
    });
    peer.on('connect', async () => {
      console.log('#### CONNECTED');
      delete this._pendingInits[pubKey64];

      const openConnections = get(this._openConnections);
      const relevantConnection = openConnections[pubKey64];
      relevantConnection.connected = true;

      // if we are already sharing video or audio, add the relevant streams
      if (this.mainStream) {
        relevantConnection.peer.addStream(this.mainStream);
      }

      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        openConnections[pubKey64] = relevantConnection;
        return openConnections;
      });

      this.updateConnectionStatus(pubKey64, { type: 'Connected' });
    });
    peer.on('close', async () => {
      console.log('#### GOT CLOSE EVENT ####');

      peer.destroy();

      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        delete openConnections[pubKey64];
        return openConnections;
      });

      this.updateConnectionStatus(pubKey64, { type: 'Disconnected' });

      // TODO CALL CALLBACK THAT AGENT LEFT;
    });
    peer.on('error', e => {
      console.log('#### GOT ERROR EVENT ####: ', e);
      peer.destroy();

      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        delete openConnections[pubKey64];
        return openConnections;
      });

      this.updateConnectionStatus(pubKey64, { type: 'Disconnected' });

      // TODO CALL CALLBACK THAT AGENT LEFT;
    });

    return peer;
  }

  createScreenSharePeer(
    connectingAgent: AgentPubKey,
    connectionId: string,
    initiator: boolean
  ): SimplePeer.Instance {
    const pubKey64 = encodeHashToBase64(connectingAgent);
    const options: SimplePeer.Options = {
      initiator,
      config: { iceServers: ICE_CONFIG },
      objectMode: true,
      trickle: true,
    };
    const peer = new SimplePeer(options);
    peer.on('signal', async data => {
      this.roomStore.client.sendSdpData({
        to_agent: connectingAgent,
        connection_id: connectionId,
        data: JSON.stringify(data),
      });
    });
    peer.on('stream', stream => {
      console.log(
        '#### GOT SCREEN SHARE STREAM. With tracks: ',
        stream.getTracks()
      );

      this._screenShareConnectionsIncoming.update(currentValue => {
        const screenShareConnections = currentValue;
        const relevantConnection = screenShareConnections[pubKey64];
        if (relevantConnection) {
          if (stream.getAudioTracks().length > 0) {
            relevantConnection.audio = true;
          }
          if (stream.getVideoTracks().length > 0) {
            relevantConnection.video = true;
          }
          screenShareConnections[pubKey64] = relevantConnection;
          return screenShareConnections;
        }
      });

      // TODO CALL CALLBACK THAT SCREEN SHARE CONNECTED (Should turn on video autoplay)
    });
    peer.on('track', track => {
      console.log('#### GOT TRACK: ', track);
      this._screenShareConnectionsIncoming.update(currentValue => {
        const screenShareConnections = currentValue;
        const relevantConnection = screenShareConnections[pubKey64];
        if (track.kind === 'audio') {
          relevantConnection.audio = true;
        }
        if (track.kind === 'video') {
          relevantConnection.video = true;
        }
        screenShareConnections[pubKey64] = relevantConnection;
        return screenShareConnections;
      });
    });
    peer.on('connect', () => {
      console.log('#### SCREEN SHARE CONNECTED');

      const screenShareConnections = initiator
        ? get(this._screenShareConnectionsOutgoing)
        : get(this._screenShareConnectionsIncoming);

      const relevantConnection = screenShareConnections[pubKey64];

      relevantConnection.connected = true;

      // if we are already sharing the screen, add the relevant stream
      if (
        this.screenShareStream &&
        relevantConnection.direction === 'outgoing'
      ) {
        relevantConnection.peer.addStream(this.screenShareStream);
      }

      screenShareConnections[pubKey64] = relevantConnection;

      if (initiator) {
        this._screenShareConnectionsOutgoing.update(currentValue => {
          const screenShareConnections = currentValue;
          screenShareConnections[pubKey64] = relevantConnection;
          return screenShareConnections;
        });
      } else {
        this._screenShareConnectionsIncoming.update(currentValue => {
          const screenShareConnections = currentValue;
          screenShareConnections[pubKey64] = relevantConnection;
          return screenShareConnections;
        });
      }

      this.updateScreenShareConnectionStatus(pubKey64, { type: 'Connected' });
    });
    peer.on('close', () => {
      console.log('#### GOT SCREEN SHARE CLOSE EVENT ####');

      peer.destroy();

      if (initiator) {
        this._screenShareConnectionsOutgoing.update(currentValue => {
          const screenShareConnections = currentValue;
          delete screenShareConnections[pubKey64];
          return screenShareConnections;
        });
      } else {
        this._screenShareConnectionsIncoming.update(currentValue => {
          const screenShareConnections = currentValue;
          delete screenShareConnections[pubKey64];
          return screenShareConnections;
        });
      }

      // TODO CALL CALLBACK OF SCREENSHARE CONNECTION CLOSED

      this.updateScreenShareConnectionStatus(pubKey64, {
        type: 'Disconnected',
      });
    });
    peer.on('error', e => {
      console.log('#### GOT SCREEN SHARE ERROR EVENT ####: ', e);
      peer.destroy();

      if (initiator) {
        this._screenShareConnectionsOutgoing.update(currentValue => {
          const screenShareConnections = currentValue;
          delete screenShareConnections[pubKey64];
          return screenShareConnections;
        });
      } else {
        this._screenShareConnectionsIncoming.update(currentValue => {
          const screenShareConnections = currentValue;
          delete screenShareConnections[pubKey64];
          return screenShareConnections;
        });
      }

      this.updateScreenShareConnectionStatus(pubKey64, {
        type: 'Disconnected',
      });
    });

    return peer;
  }

  // ********************************************************************************************
  //
  //   H E L P E R   M E T H O D S
  //
  // ********************************************************************************************

  updateConnectionStatus(pubKey: AgentPubKeyB64, status: ConnectionStatus) {
    this._connectionStatuses.update(currentValue => {
      const connectionStatuses = currentValue;
      if (status.type === 'InitSent') {
        const currentStatus = connectionStatuses[pubKey];
        if (currentStatus && currentStatus.type === 'InitSent') {
          // increase number of attempts by 1
          connectionStatuses[pubKey] = {
            type: 'InitSent',
            attemptCount: currentStatus.attemptCount
              ? currentStatus.attemptCount + 1
              : 1,
          };
        } else {
          connectionStatuses[pubKey] = {
            type: 'InitSent',
            attemptCount: 1,
          };
        }
        return connectionStatuses;
      }

      if (status.type === 'AcceptSent') {
        const currentStatus = connectionStatuses[pubKey];
        if (currentStatus && currentStatus.type === 'AcceptSent') {
          // increase number of attempts by 1
          connectionStatuses[pubKey] = {
            type: 'AcceptSent',
            attemptCount: currentStatus.attemptCount
              ? currentStatus.attemptCount + 1
              : 1,
          };
        } else {
          connectionStatuses[pubKey] = {
            type: 'AcceptSent',
            attemptCount: 1,
          };
        }
        return connectionStatuses;
      }
      connectionStatuses[pubKey] = status;
      return connectionStatuses;
    });
  }

  updateScreenShareConnectionStatus(
    pubKey: AgentPubKeyB64,
    status: ConnectionStatus
  ) {
    this._screenShareConnectionStatuses.update(currentValue => {
      const connectionStatuses = currentValue;
      if (status.type === 'InitSent') {
        const currentStatus = connectionStatuses[pubKey];
        if (currentStatus && currentStatus.type === 'InitSent') {
          // increase number of attempts by 1
          connectionStatuses[pubKey] = {
            type: 'InitSent',
            attemptCount: currentStatus.attemptCount
              ? currentStatus.attemptCount + 1
              : 1,
          };
        } else {
          connectionStatuses[pubKey] = {
            type: 'InitSent',
            attemptCount: 1,
          };
        }
        return connectionStatuses;
      }
      if (status.type === 'AcceptSent') {
        const currentStatus = connectionStatuses[pubKey];
        if (currentStatus && currentStatus.type === 'AcceptSent') {
          // increase number of attempts by 1
          connectionStatuses[pubKey] = {
            type: 'AcceptSent',
            attemptCount: currentStatus.attemptCount
              ? currentStatus.attemptCount + 1
              : 1,
          };
        } else {
          connectionStatuses[pubKey] = {
            type: 'AcceptSent',
            attemptCount: 1,
          };
        }
        return connectionStatuses;
      }
      connectionStatuses[pubKey] = status;
      return connectionStatuses;
    });
  }

  // ********************************************************************************************
  //
  //   S I G N A L   H A N D L E R S
  //
  // ********************************************************************************************

  async handleSignal(signal: RoomSignal) {
    switch (signal.type) {
      case 'PingUi': {
        await this.handlePingUi(signal);
        break;
      }
      case 'PongUi': {
        await this.handlePongUi(signal);
        break;
      }
      case 'InitRequest': {
        await this.handleInitRequest(signal);
        break;
      }
      case 'InitAccept': {
        await this.handleInitAccept(signal);
        break;
      }
      case 'SdpData': {
        await this.handleSdpData(signal);
        break;
      }
      default:
        console.warn('Got unexpected signal type: ', signal);
    }
  }

  /**
   * If we get a PingUI we respond with a PongUI containing metadata
   *
   * @param signal
   */
  async handlePingUi(signal: Extract<RoomSignal, { type: 'PingUi' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    console.log(`Got PingUi from ${pubkeyB64}: `, signal);
    if (pubkeyB64 !== this.myPubKeyB64) {
      const metaData: PongMetaData<PongMetaDataV1> = {
        formatVersion: 1,
        data: {
          connectionStatuses: get(this._connectionStatuses),
          screenShareConnectionStatuses: this.screenShareStream
            ? get(this._screenShareConnectionStatuses)
            : undefined,
          knownAgents: get(this._knownAgents),
          appVersion: __APP_VERSION__,
        },
      };
      await this.roomClient.pongFrontend({
        to_agent: signal.from_agent,
        meta_data: JSON.stringify(metaData),
      });
    }
  }

  /**
   * If we get a PongUI we do the following:
   *
   * - Update our stored metadata for this agent
   * - Send a video InitRequest if necessary
   * - Send a screen share InitRequest if necessary
   *
   * @param signal
   */
  async handlePongUi(signal: Extract<RoomSignal, { type: 'PongUi' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    const now = Date.now();
    console.log(`Got PongUI from ${pubkeyB64}: `, signal);
    // Update their connection statuses and the list of known agents
    try {
      const metaData: PongMetaData<PongMetaDataV1> = JSON.parse(
        signal.meta_data
      );
      this._othersConnectionStatuses.update(statuses => {
        const newStatuses = statuses;
        newStatuses[pubkeyB64] = {
          lastUpdated: now,
          statuses: metaData.data.connectionStatuses,
          screenShareStatuses: metaData.data.screenShareConnectionStatuses,
          knownAgents: metaData.data.knownAgents,
        };
        return statuses;
      });

      // Update known agents based on the agents that they know
      this._knownAgents.update(store => {
        const knownAgents = store;
        const maybeKnownAgent = knownAgents[pubkeyB64];
        if (maybeKnownAgent) {
          maybeKnownAgent.appVersion = metaData.data.appVersion;
          maybeKnownAgent.lastSeen = Date.now();
        } else {
          knownAgents[pubkeyB64] = {
            pubkey: pubkeyB64,
            type: 'told',
            lastSeen: Date.now(),
            appVersion: metaData.data.appVersion,
          };
        }
        if (metaData.data.knownAgents) {
          Object.entries(metaData.data.knownAgents).forEach(
            ([agentB64, agentInfo]) => {
              if (!knownAgents[agentB64] && agentB64 !== this.myPubKeyB64) {
                knownAgents[agentB64] = {
                  pubkey: agentB64,
                  type: 'told',
                  lastSeen: undefined, // We did not receive a Pong from them directly
                  appVersion: agentInfo.appVersion,
                };
              }
            }
          );
        }
        return knownAgents;
      });
    } catch (e) {
      console.warn('Failed to parse pong meta data.');
    }

    /**
     * Normal video/audio stream
     *
     * If our agent puglic key is alphabetically "higher" than the agent public key
     * sending the pong and there is no open connection yet with this agent and there is
     * no pending InitRequest from less than 5 seconds ago (and we therefore have to
     * assume that a remote signal got lost), send an InitRequest.
     */
    // alreadyOpen here does not include the case where SDP exchange is already ongoing
    // but no actual connection has happened yet
    const alreadyOpen = Object.keys(get(this._openConnections)).includes(
      pubkeyB64
    );
    const pendingInits = this._pendingInits[pubkeyB64];
    if (!alreadyOpen && pubkeyB64 < this.myPubKeyB64) {
      if (!pendingInits) {
        console.log('#### SENDING FIRST INIT REQUEST.');
        const newConnectionId = uuidv4();
        this._pendingInits[pubkeyB64] = [
          { connectionId: newConnectionId, t0: now },
        ];
        await this.roomClient.sendInitRequest({
          connection_type: 'video',
          connection_id: newConnectionId,
          to_agent: signal.from_agent,
        });
        this.updateConnectionStatus(pubkeyB64, { type: 'InitSent' });
      } else {
        console.log(
          `#--# SENDING INIT REQUEST NUMBER ${pendingInits.length + 1}.`
        );
        const latestInit = pendingInits.sort(
          (init_a, init_b) => init_b.t0 - init_a.t0
        )[0];
        if (now - latestInit.t0 > INIT_RETRY_THRESHOLD) {
          const newConnectionId = uuidv4();
          pendingInits.push({ connectionId: newConnectionId, t0: now });
          this._pendingInits[pubkeyB64] = pendingInits;
          await this.roomClient.sendInitRequest({
            connection_type: 'video',
            connection_id: newConnectionId,
            to_agent: signal.from_agent,
          });
          this.updateConnectionStatus(pubkeyB64, { type: 'InitSent' });
        }
      }
    } else if (!alreadyOpen && !pendingInits) {
      this.updateConnectionStatus(pubkeyB64, { type: 'AwaitingInit' });
    }

    /**
     * Outgoing screen share stream
     *
     * If our screen share stream is active and there is no open outgoing
     * screen share connection yet with this agent and there is no pending
     * InitRequest from less than 5 seconds ago (and we therefore have to
     * assume that a remote signal got lost), send an InitRequest.
     */
    const alreadyOpenScreenShareOutgoing = Object.keys(
      get(this._screenShareConnectionsOutgoing)
    ).includes(pubkeyB64);
    const pendingScreenShareInits = this._pendingInits[pubkeyB64];
    if (!!this.screenShareStream && !alreadyOpenScreenShareOutgoing) {
      if (!pendingScreenShareInits) {
        console.log('#### SENDING FIRST SCREEN SHARE INIT REQUEST.');
        const newConnectionId = uuidv4();
        this._pendingScreenShareInits[pubkeyB64] = [
          { connectionId: newConnectionId, t0: now },
        ];
        await this.roomClient.sendInitRequest({
          connection_type: 'screen',
          connection_id: newConnectionId,
          to_agent: signal.from_agent,
        });
        this.updateScreenShareConnectionStatus(pubkeyB64, {
          type: 'InitSent',
        });
      } else {
        console.log(
          `#--# SENDING SCREEN SHARE INIT REQUEST NUMBER ${
            pendingScreenShareInits.length + 1
          }.`
        );
        const latestInit = pendingScreenShareInits.sort(
          (init_a, init_b) => init_b.t0 - init_a.t0
        )[0];
        if (now - latestInit.t0 > INIT_RETRY_THRESHOLD) {
          const newConnectionId = uuidv4();
          pendingScreenShareInits.push({
            connectionId: newConnectionId,
            t0: now,
          });
          this._pendingScreenShareInits[pubkeyB64] = pendingScreenShareInits;
          await this.roomClient.sendInitRequest({
            connection_type: 'screen',
            connection_id: newConnectionId,
            to_agent: signal.from_agent,
          });
        }
        this.updateScreenShareConnectionStatus(pubkeyB64, {
          type: 'InitSent',
        });
      }
    }
  }

  /**
   * Handle an InitRequest signal
   *
   * @param signal
   */
  async handleInitRequest(
    signal: Extract<RoomSignal, { type: 'InitRequest' }>
  ) {
    const pubKey64 = encodeHashToBase64(signal.from_agent);

    console.log(
      `#### GOT ${
        signal.connection_type === 'screen' ? 'SCREEN SHARE ' : ''
      }INIT REQUEST.`
    );

    /**
     * InitRequests for normal audio/video stream
     *
     * Only accept init requests from agents who's pubkey is alphabetically  "higher" than ours
     */
    if (signal.connection_type === 'video' && pubKey64 > this.myPubKeyB64) {
      console.log(
        '#### SENDING INIT ACCEPT. signal.connection_type: ',
        signal.connection_type
      );
      console.log('#### Creating normal peer');
      const newPeer = this.createPeer(
        signal.from_agent,
        signal.connection_id,
        false
      );
      const accept: PendingAccept = {
        connectionId: signal.connection_id,
        peer: newPeer,
      };
      const allPendingAccepts = this._pendingAccepts;
      const pendingAcceptsForAgent = allPendingAccepts[pubKey64];
      const newPendingAcceptsForAgent: PendingAccept[] = pendingAcceptsForAgent
        ? [...pendingAcceptsForAgent, accept]
        : [accept];
      allPendingAccepts[pubKey64] = newPendingAcceptsForAgent;
      this._pendingAccepts = allPendingAccepts;
      await this.roomClient.sendInitAccept({
        connection_type: signal.connection_type,
        connection_id: signal.connection_id,
        to_agent: signal.from_agent,
      });
      this.updateConnectionStatus(pubKey64, { type: 'AcceptSent' });
    }

    /**
     * InitRequests for incoming screen shares
     */
    if (signal.connection_type === 'screen') {
      const newPeer = this.createScreenSharePeer(
        signal.from_agent,
        signal.connection_id,
        false
      );
      const accept: PendingAccept = {
        connectionId: signal.connection_id,
        peer: newPeer,
      };
      const allPendingScreenShareAccepts = this._pendingScreenShareAccepts;
      const pendingScreenShareAcceptsForAgent =
        allPendingScreenShareAccepts[pubKey64];
      const newPendingAcceptsForAgent: PendingAccept[] =
        pendingScreenShareAcceptsForAgent
          ? [...pendingScreenShareAcceptsForAgent, accept]
          : [accept];
      allPendingScreenShareAccepts[pubKey64] = newPendingAcceptsForAgent;
      this._pendingScreenShareAccepts = allPendingScreenShareAccepts;
      await this.roomClient.sendInitAccept({
        connection_type: signal.connection_type,
        connection_id: signal.connection_id,
        to_agent: signal.from_agent,
      });
    }
  }

  /**
   * Handle an InitAccept signal
   *
   * @param signal
   */
  async handleInitAccept(signal: Extract<RoomSignal, { type: 'InitAccept' }>) {
    const pubKey64 = encodeHashToBase64(signal.from_agent);

    /**
     * For normal video/audio connections
     *
     * If there is no open connection with this agent yet and the connectionId
     * is one matching an InitRequest we sent earlier, create a Simple Peer
     * Instance and add it to open connections, then delete all PendingInits
     * for this agent.
     *
     */
    if (signal.connection_type === 'video') {
      const agentPendingInits = this._pendingInits[pubKey64];
      if (!Object.keys(get(this._openConnections)).includes(pubKey64)) {
        if (!agentPendingInits) {
          console.warn(
            `Got a video InitAccept from an agent (${pubKey64}) for which we have no pending init stored.`
          );
          return;
        }
        if (
          agentPendingInits
            .map(pendingInit => pendingInit.connectionId)
            .includes(signal.connection_id)
        ) {
          console.log('#### RECEIVED INIT ACCEPT AND CEATING INITIATING PEER.');
          const newPeer = this.createPeer(
            signal.from_agent,
            signal.connection_id,
            true
          );

          this._openConnections.update(currentValue => {
            const openConnections = currentValue;
            openConnections[pubKey64] = {
              connectionId: signal.connection_id,
              peer: newPeer,
              video: false,
              audio: false,
              connected: false,
              direction: 'duplex',
            };
            return openConnections;
          });

          delete this._pendingInits[pubKey64];

          this.updateConnectionStatus(pubKey64, { type: 'SdpExchange' });
        }
      }
    }

    /**
     * For screen share connections
     *
     * If there is no open connection with this agent yet and the connectionId
     * is one matching an InitRequest we sent earlier, create a Simple Peer
     * Instance and add it to open connections, then delete all PendingInits
     * for this agent
     */
    if (signal.connection_type === 'screen') {
      const agentPendingScreenShareInits =
        this._pendingScreenShareInits[pubKey64];
      if (
        !Object.keys(this._screenShareConnectionsOutgoing).includes(pubKey64)
      ) {
        if (!agentPendingScreenShareInits) {
          console.warn(
            `Got a screen share InitAccept from an agent (${pubKey64}) for which we have no pending init stored.`
          );
          return;
        }

        if (
          agentPendingScreenShareInits
            .map(pendingInit => pendingInit.connectionId)
            .includes(signal.connection_id)
        ) {
          console.log(
            '#### RECEIVED INIT ACCEPT FOR SCREEN SHARING AND INITIATING PEER.'
          );
          const newPeer = this.createScreenSharePeer(
            signal.from_agent,
            signal.connection_id,
            true
          );

          this._screenShareConnectionsOutgoing.update(currentValue => {
            const screenShareConnectionsOutgoing = currentValue;
            screenShareConnectionsOutgoing[pubKey64] = {
              connectionId: signal.connection_id,
              peer: newPeer,
              video: true,
              audio: false,
              connected: false,
              direction: 'outgoing', // if we initiated the request, we're the ones delivering the stream
            };
            return screenShareConnectionsOutgoing;
          });

          delete this._pendingScreenShareInits[pubKey64];

          this.updateScreenShareConnectionStatus(pubKey64, {
            type: 'SdpExchange',
          });
        }
      }
    }
  }

  /**
   * Handle an SdpData signal
   *
   * @param signal
   */
  async handleSdpData(signal: Extract<RoomSignal, { type: 'SdpData' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    console.log(`## Got SDP Data from : ${pubkeyB64}:\n`, signal.data);

    // If not connected already, update the status do SdpExchange (SDP Exchange also happens when already connected)
    const agentConnectionStatus = get(this._connectionStatuses)[pubkeyB64];
    if (!!agentConnectionStatus && agentConnectionStatus.type !== 'Connected') {
      this.updateConnectionStatus(pubkeyB64, { type: 'SdpExchange' });
    }

    /**
     * Normal video/audio connections
     */
    const maybeOpenConnection = get(this._openConnections)[pubkeyB64];
    if (
      maybeOpenConnection &&
      maybeOpenConnection.connectionId === signal.connection_id
    ) {
      maybeOpenConnection.peer.signal(JSON.parse(signal.data));
    } else {
      /**
       * If there is no open connection yet but a PendingAccept then move that
       * PendingAccept to the open connections and destroy all other
       * Peer Instances for PendingAccepts of this agent and delete the
       * PendingAccepts
       */
      const allPendingAccepts = this._pendingAccepts;
      const pendingAcceptsForAgent = allPendingAccepts[pubkeyB64];
      if (pendingAcceptsForAgent) {
        const maybePendingAccept = pendingAcceptsForAgent.find(
          pendingAccept => pendingAccept.connectionId === signal.connection_id
        );
        if (maybePendingAccept) {
          maybePendingAccept.peer.signal(JSON.parse(signal.data));
          console.log(
            '#### FOUND PENDING ACCEPT! Moving to open connections...'
          );
          this._openConnections.update(currentValue => {
            const openConnections = currentValue;
            openConnections[pubkeyB64] = {
              connectionId: signal.connection_id,
              peer: maybePendingAccept.peer,
              video: false,
              audio: false,
              connected: false,
              direction: 'duplex',
            };
            return openConnections;
          });
          const otherPendingAccepts = pendingAcceptsForAgent.filter(
            pendingAccept => pendingAccept.connectionId !== signal.connection_id
          );
          otherPendingAccepts.forEach(pendingAccept =>
            pendingAccept.peer.destroy()
          );

          delete this._pendingAccepts[pubkeyB64];
        }
      } else {
        console.warn(
          `Got SDP data from agent (${pubkeyB64}) for which we have pending accepts but none with a matching connection id.`
        );
      }
    }

    /**
     * Outgoing Screen Share connections
     */
    const maybeOutgoingScreenShareConnection = get(
      this._screenShareConnectionsOutgoing
    )[pubkeyB64];
    if (
      maybeOutgoingScreenShareConnection &&
      maybeOutgoingScreenShareConnection.connectionId === signal.connection_id
    ) {
      maybeOutgoingScreenShareConnection.peer.signal(JSON.parse(signal.data));
    }

    /**
     * Incoming Screen Share connections
     */
    const maybeIncomingScreenShareConnection = get(
      this._screenShareConnectionsIncoming
    )[pubkeyB64];
    if (
      maybeIncomingScreenShareConnection &&
      maybeIncomingScreenShareConnection.connectionId === signal.connection_id
    ) {
      maybeIncomingScreenShareConnection.peer.signal(JSON.parse(signal.data));
    } else {
      /**
       * If there's no open connection but a PendingAccept then move that
       * PendingAccept to the open connections and destroy all other
       * Peer Instances for PendingAccepts of this agent and delete the
       * PendingAccepts
       */
      const pendingScreenShareAccepts =
        this._pendingScreenShareAccepts[pubkeyB64];
      if (pendingScreenShareAccepts) {
        const maybePendingAccept = pendingScreenShareAccepts.find(
          pendingAccept => pendingAccept.connectionId === signal.connection_id
        );
        if (maybePendingAccept) {
          maybePendingAccept.peer.signal(JSON.parse(signal.data));
          this._screenShareConnectionsIncoming.update(currentValue => {
            const screenShareConnectionsIncoming = currentValue;
            screenShareConnectionsIncoming[pubkeyB64] = {
              connectionId: signal.connection_id,
              peer: maybePendingAccept.peer,
              video: false,
              audio: false,
              connected: false,
              direction: 'incoming',
            };
            return screenShareConnectionsIncoming;
          });
          const otherPendingAccepts = pendingScreenShareAccepts.filter(
            pendingAccept => pendingAccept.connectionId !== signal.connection_id
          );
          otherPendingAccepts.forEach(pendingAccept =>
            pendingAccept.peer.destroy()
          );

          delete this._pendingScreenShareAccepts[pubkeyB64];
        } else {
          console.warn(
            `Got SDP data from agent (${pubkeyB64}) for which we have pending screen share accepts but none with a matching connection id.`
          );
        }
      }
    }
  }

  /**
   * methods
   */
}