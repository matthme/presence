import SimplePeer from 'simple-peer';
import {
  AgentPubKey,
  AgentPubKeyB64,
  decodeHashFromBase64,
  encodeHashToBase64,
} from '@holochain/client';
import {
  derived,
  get,
  Readable,
  writable,
  Writable,
} from '@holochain-open-dev/stores';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentInfo,
  ConnectionStatus,
  ConnectionStatuses,
  OpenConnectionInfo,
  PendingAccept,
  PendingInit,
  PongMetaData,
  PongMetaDataV1,
  RoomSignal,
  RTCMessage,
  StoreEventPayload,
  StreamAndTrackInfo,
  TrackInfo,
} from './types';
import { RoomClient } from './room-client';
import { RoomStore } from './room-store';
import { PresenceLogger } from './logging';

declare const __APP_VERSION__: string;

const ICE_CONFIG = [
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/**
 * If an InitRequest does not succeed within this duration (ms) another InitRequest will be sent
 */
const INIT_RETRY_THRESHOLD = 5000;

export const PING_INTERVAL = 2000;

/**
 * A store that handles the creation and management of WebRTC streams with
 * holochain peers
 */
export class StreamsStore {
  private roomClient: RoomClient;

  private myPubKeyB64: AgentPubKeyB64;

  private signalUnsubscribe: () => void;

  private pingInterval: number | undefined;

  private roomStore: RoomStore;

  private allAgents: AgentPubKey[] = [];

  private screenSourceSelection: () => Promise<string>;

  private eventCallback: (ev: StoreEventPayload) => any = () => undefined;

  logger: PresenceLogger;

  blockedAgents: Writable<AgentPubKeyB64[]> = writable([]);

  trickleICE = true;

  constructor(
    roomStore: RoomStore,
    screenSourceSelection: () => Promise<string>,
    logger: PresenceLogger
  ) {
    this.roomStore = roomStore;
    this.screenSourceSelection = screenSourceSelection;
    this.logger = logger;
    const roomClient = roomStore.client;
    this.roomClient = roomClient;
    this.myPubKeyB64 = encodeHashToBase64(roomClient.client.myPubKey);
    // TODO potentially move this to a connect() method which also returns
    // the Unsubscribe function
    this.signalUnsubscribe = this.roomClient.onSignal(async signal =>
      this.handleSignal(signal)
    );
    const blockedAgentsJson = window.sessionStorage.getItem('blockedAgents');
    this.blockedAgents.set(
      blockedAgentsJson ? JSON.parse(blockedAgentsJson) : []
    );
    const trickleICE = window.localStorage.getItem('trickleICE');
    if (trickleICE) {
      this.trickleICE = JSON.parse(trickleICE);
    }
  }

  static async connect(
    roomStore: RoomStore,
    screenSourceSelection: () => Promise<string>,
    logger: PresenceLogger
  ): Promise<StreamsStore> {
    const streamsStore = new StreamsStore(
      roomStore,
      screenSourceSelection,
      logger
    );

    roomStore.allAgents.subscribe(val => {
      if (val.status === 'complete') {
        streamsStore.allAgents = val.value;
      } else if (val.status === 'error') {
        console.error('Failed to get all agents: ', val.error);
      }
    });

    // ping all agents that are not already connected to you every PING_INTERVAL milliseconds
    await streamsStore.pingAgents();
    streamsStore.pingInterval = window.setInterval(async () => {
      await streamsStore.pingAgents();
    }, PING_INTERVAL);
    return streamsStore;
  }

  disconnect() {
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

  enableTrickleICE() {
    window.localStorage.setItem('trickleICE', 'true');
    this.trickleICE = true;
  }

  disableTrickleICE() {
    window.localStorage.setItem('trickleICE', 'false');
    this.trickleICE = false;
  }

  onEvent(cb: (ev: StoreEventPayload) => any) {
    this.eventCallback = cb;
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
          if (get(this.blockedAgents).includes(agentB64)) {
            connectionStatuses[agentB64] = {
              type: 'Blocked',
            };
          } else {
            connectionStatuses[agentB64] = {
              type: 'Disconnected',
            };
          }
        }
      });
      return connectionStatuses;
    });

    // Ping known agents
    // This could potentially be optimized by only pinging agents that are online according to Moss (which would only work in shared rooms though)
    const agentsToPing = Object.keys(get(this._knownAgents))
      .filter(agent => !get(this.blockedAgents).includes(agent))
      .map(pubkeyB64 => decodeHashFromBase64(pubkeyB64));
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
          const error = `Failed to get media devices (video): ${e.toString()}`;
          console.error(error);
          this.eventCallback({
            type: 'error',
            error,
          });
          return;
        }
        if (!videoStream) {
          const error = 'Video stream undefined after getUserMedia.';
          console.error(error);
          this.eventCallback({
            type: 'error',
            error,
          });
          return;
        }
        const videoTrack = videoStream.getVideoTracks()[0];
        if (!videoTrack) {
          const error = 'No video track found on video stream.';
          console.error(error);
          this.eventCallback({
            type: 'error',
            error,
          });
          return;
        }
        this.mainStream.addTrack(videoTrack);
        this.eventCallback({
          type: 'my-video-on',
        });
        try {
          Object.values(get(this._openConnections)).forEach(conn => {
            conn.peer.addTrack(videoTrack, this.mainStream!);
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
        const error = `Failed to get media devices (video): ${e.toString()}`;
        console.error(error);
        this.eventCallback({
          type: 'error',
          error,
        });
        return;
      }
      this.eventCallback({
        type: 'my-video-on',
      });
      try {
        Object.values(get(this._openConnections)).forEach(conn => {
          conn.peer.addStream(this.mainStream!);
        });
      } catch (e: any) {
        console.error(`Failed to add video track: ${e.toString()}`);
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
        }
        const msg: RTCMessage = {
          type: 'action',
          message: 'video-off',
        };
        try {
          conn.peer.send(JSON.stringify(msg));
        } catch (e) {
          console.warn('Could not send video-off message to peer: ', e);
        }
      });
      this.mainStream.getVideoTracks().forEach(track => {
        this.mainStream!.removeTrack(track);
      });
      this.eventCallback({
        type: 'my-video-off',
      });
    }
  }

  async audioOn() {
    if (this.mainStream) {
      if (this.mainStream.getAudioTracks()[0]) {
        // Apparently, it is not necessary to enable the tracks of the
        // cloned streams explicitly as well here.
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
          const error = `Failed to get media devices (audio): ${e.toString()}`;
          console.error(error);
          this.eventCallback({
            type: 'error',
            error,
          });
          return;
        }
        try {
          this.mainStream.addTrack(audioStream.getAudioTracks()[0]);
          Object.values(get(this._openConnections)).forEach(conn => {
            conn.peer.addTrack(
              audioStream!.getAudioTracks()[0],
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
        this.eventCallback({
          type: 'my-audio-on',
        });
      } catch (e: any) {
        const error = `Failed to get media devices (audio): ${e.toString()}`;
        console.error(error);
        this.eventCallback({
          type: 'error',
          error,
        });
        return;
      }
      Object.values(get(this._openConnections)).forEach(conn => {
        conn.peer.addStream(this.mainStream!);
      });
    }
    this.eventCallback({
      type: 'my-audio-on',
    });
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
      }
    });
  }

  audioOff() {
    console.log('### AUDIO OFF');
    console.log('this._mainStream.getTracks(): ', this.mainStream?.getTracks());
    if (this.mainStream) {
      console.log('### DISABLING ALL AUDIO TRACKS');
      this.mainStream.getAudioTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = false;
        console.log('### DISABLED AUDIO TRACK: ', track);
      });
      // Disable the audio tracks of all cloned streams as well
      this.mainStreamClones.forEach(clonedStream => {
        clonedStream.getAudioTracks().forEach(track => {
          // eslint-disable-next-line no-param-reassign
          track.enabled = false;
          console.log('### DISABLED AUDIO TRACK: ', track);
        });
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
      this.eventCallback({
        type: 'my-audio-off',
      });
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
        if (!e.toString().includes('Selection canceled by user')) {
          const error = `Failed to get media devices (screen share): ${e.toString()}`;
          console.error(error);
          this.eventCallback({
            type: 'error',
            error,
          });
        }
      }
      // If there's an error here it's potentially possible that 'my-screen-share-on' further
      // down never gets emitted.
      Object.values(get(this._screenShareConnectionsOutgoing)).forEach(conn => {
        if (this.screenShareStream) {
          conn.peer.addStream(this.screenShareStream);
        }
      });
    }
    this.eventCallback({
      type: 'my-screen-share-on',
    });
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
      this.eventCallback({
        type: 'my-screen-share-off',
      });
    }
  }

  disconnectFromPeerVideo(pubKeyB64: AgentPubKeyB64) {
    const relevantConnection = get(this._openConnections)[pubKeyB64];
    if (relevantConnection) relevantConnection.peer.destroy();
  }

  disconnectFromPeerScreen(pubKeyB64: AgentPubKeyB64) {
    const relevantConnection = get(this._screenShareConnectionsIncoming)[
      pubKeyB64
    ];
    if (relevantConnection) relevantConnection.peer.destroy();
  }

  blockAgent(pubKey64: AgentPubKeyB64) {
    const currentlyBlockedAgents = get(this.blockedAgents);
    if (!currentlyBlockedAgents.includes(pubKey64)) {
      this.blockedAgents.set([...currentlyBlockedAgents, pubKey64]);
    }
    const blockedAgentsJson = window.sessionStorage.getItem('blockedAgents');
    const blockedAgents: AgentPubKeyB64[] = blockedAgentsJson
      ? JSON.parse(blockedAgentsJson)
      : [];
    if (!blockedAgents.includes(pubKey64))
      window.sessionStorage.setItem(
        'blockedAgents',
        JSON.stringify([...blockedAgents, pubKey64])
      );
    this.disconnectFromPeerVideo(pubKey64);
    this.disconnectFromPeerScreen(pubKey64);
    setTimeout(() => {
      this._connectionStatuses.update(currentValue => {
        const connectionStatuses = currentValue;
        connectionStatuses[pubKey64] = {
          type: 'Blocked',
        };
        return connectionStatuses;
      });
    }, 500);
  }

  unblockAgent(pubKey64: AgentPubKeyB64) {
    const currentlyBlockedAgents = get(this.blockedAgents);
    this.blockedAgents.set(
      currentlyBlockedAgents.filter(pubkey => pubkey !== pubKey64)
    );
    const blockedAgentsJson = window.sessionStorage.getItem('blockedAgents');
    const blockedAgents: AgentPubKeyB64[] = blockedAgentsJson
      ? JSON.parse(blockedAgentsJson)
      : [];
    window.sessionStorage.setItem(
      'blockedAgents',
      JSON.stringify(blockedAgents.filter(pubkey => pubkey !== pubKey64))
    );
  }

  isAgentBlocked(pubKey64: AgentPubKeyB64): Readable<boolean> {
    return derived(this.blockedAgents, val => val.includes(pubKey64));
  }

  // ===========================================================================================
  // WEBRTC STREAMS
  // ===========================================================================================

  /**
   * Our own video/audio stream
   */
  mainStream: MediaStream | undefined | null;

  /**
   * Clones of the main stream. These are required in case a reconnection needs to be made for
   * an individual peer because our audio and/or video track is non-functional from their
   * perspective
   */
  mainStreamClones: MediaStream[] = [];

  /**
   * Our own screen share stream
   */
  screenShareStream: MediaStream | undefined | null;

  /**
   * Streams of others
   */
  _videoStreams: Record<AgentPubKeyB64, MediaStream> = {};

  /**
   * Screen share streams of others
   */
  _screenShareStreams: Record<AgentPubKeyB64, MediaStream> = {};

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
    const pubKeyB64 = encodeHashToBase64(connectingAgent);
    const options: SimplePeer.Options = {
      initiator,
      config: {
        iceServers: ICE_CONFIG,
      },
      objectMode: true,
      trickle: this.trickleICE,
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
              const relevantConnection = openConnections[pubKeyB64];
              relevantConnection.video = false;
              openConnections[pubKeyB64] = relevantConnection;
              return openConnections;
            });
          }
          if (msg.message === 'audio-off') {
            this._openConnections.update(currentValue => {
              const openConnections = currentValue;
              const relevantConnection = openConnections[pubKeyB64];
              relevantConnection.audio = false;
              openConnections[pubKeyB64] = relevantConnection;
              return openConnections;
            });
          }
          if (msg.message === 'audio-on') {
            this._openConnections.update(currentValue => {
              const openConnections = currentValue;
              const relevantConnection = openConnections[pubKeyB64];
              relevantConnection.audio = true;
              openConnections[pubKeyB64] = relevantConnection;
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
      console.log(
        '#### GOT STREAM with tracks from:',
        pubKeyB64,
        stream.getTracks()
      );
      // Store to existing streams
      const existingPeerStreams = this._videoStreams;
      existingPeerStreams[pubKeyB64] = stream;
      this._videoStreams = existingPeerStreams;

      const withAudio = stream.getAudioTracks().length > 0;
      const withVideo = stream.getVideoTracks().length > 0;
      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        const relevantConnection = openConnections[pubKeyB64];
        if (relevantConnection) {
          if (withAudio) {
            relevantConnection.audio = true;
          }
          if (withVideo) {
            relevantConnection.video = true;
          }
          openConnections[pubKeyB64] = relevantConnection;
        }
        return openConnections;
      });
      this.eventCallback({
        type: 'peer-stream',
        pubKeyB64,
        connectionId,
        stream,
      });
    });
    peer.on('track', track => {
      console.log('#### GOT TRACK from:', pubKeyB64, track);
      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        const relevantConnection = openConnections[pubKeyB64];
        if (track.kind === 'audio') {
          relevantConnection.audio = true;
        }
        if (track.kind === 'video') {
          relevantConnection.video = true;
        }
        openConnections[pubKeyB64] = relevantConnection;
        return openConnections;
      });
      if (track.kind === 'audio') {
        this.eventCallback({
          type: 'peer-audio-on',
          pubKeyB64,
          connectionId,
        });
      }
      if (track.kind === 'video') {
        this.eventCallback({
          type: 'peer-video-on',
          pubKeyB64,
          connectionId,
        });
      }
    });
    peer.on('connect', async () => {
      console.log('#### CONNECTED with', pubKeyB64);
      delete this._pendingInits[pubKeyB64];

      const openConnections = get(this._openConnections);
      const relevantConnection = openConnections[pubKeyB64];
      relevantConnection.connected = true;

      // if we are already sharing video or audio, add the relevant streams
      if (this.mainStream) {
        relevantConnection.peer.addStream(this.mainStream);
      }

      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        openConnections[pubKeyB64] = relevantConnection;
        return openConnections;
      });

      this.updateConnectionStatus(pubKeyB64, { type: 'Connected' });
      this.eventCallback({
        type: 'peer-connected',
        pubKeyB64,
        connectionId,
      });
    });
    peer.on('close', async () => {
      console.log('#### GOT CLOSE EVENT ####');

      // Remove from existing streams
      const existingPeerStreams = this._videoStreams;
      delete existingPeerStreams[pubKeyB64];
      this._videoStreams = existingPeerStreams;

      peer.destroy();

      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        delete openConnections[pubKeyB64];
        return openConnections;
      });

      this.updateConnectionStatus(pubKeyB64, { type: 'Disconnected' });
      this.eventCallback({
        type: 'peer-disconnected',
        pubKeyB64,
        connectionId,
      });
    });
    peer.on('error', e => {
      console.log('#### GOT ERROR EVENT ####: ', e);
      peer.destroy();

      // Remove from existing streams
      const existingPeerStreams = this._videoStreams;
      delete existingPeerStreams[pubKeyB64];
      this._videoStreams = existingPeerStreams;

      this._openConnections.update(currentValue => {
        const openConnections = currentValue;
        delete openConnections[pubKeyB64];
        return openConnections;
      });

      this.updateConnectionStatus(pubKeyB64, { type: 'Disconnected' });
      this.eventCallback({
        type: 'peer-disconnected',
        pubKeyB64,
        connectionId,
      });
    });

    return peer;
  }

  createScreenSharePeer(
    connectingAgent: AgentPubKey,
    connectionId: string,
    initiator: boolean
  ): SimplePeer.Instance {
    const pubKeyB64 = encodeHashToBase64(connectingAgent);
    const options: SimplePeer.Options = {
      initiator,
      config: { iceServers: ICE_CONFIG },
      objectMode: true,
      trickle: this.trickleICE,
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
        const relevantConnection = screenShareConnections[pubKeyB64];
        if (relevantConnection) {
          if (stream.getAudioTracks().length > 0) {
            relevantConnection.audio = true;
          }
          if (stream.getVideoTracks().length > 0) {
            relevantConnection.video = true;
          }
          screenShareConnections[pubKeyB64] = relevantConnection;
        }
        return screenShareConnections;
      });

      this.eventCallback({
        type: 'peer-screen-share-stream',
        pubKeyB64,
        connectionId,
        stream,
      });
    });
    peer.on('track', track => {
      console.log('#### GOT TRACK: ', track);
      this._screenShareConnectionsIncoming.update(currentValue => {
        const screenShareConnections = currentValue;
        const relevantConnection = screenShareConnections[pubKeyB64];
        if (track.kind === 'audio' && track.enabled) {
          relevantConnection.audio = true;
        }
        if (track.kind === 'video' && track.enabled) {
          relevantConnection.video = true;
        }
        screenShareConnections[pubKeyB64] = relevantConnection;
        return screenShareConnections;
      });
      this.eventCallback({
        type: 'peer-screen-share-track',
        pubKeyB64,
        connectionId,
        track,
      });
    });
    peer.on('connect', () => {
      console.log('#### SCREEN SHARE CONNECTED');

      const screenShareConnections = initiator
        ? get(this._screenShareConnectionsOutgoing)
        : get(this._screenShareConnectionsIncoming);

      const relevantConnection = screenShareConnections[pubKeyB64];

      relevantConnection.connected = true;

      // if we are already sharing the screen, add the relevant stream
      if (
        this.screenShareStream &&
        relevantConnection.direction === 'outgoing'
      ) {
        relevantConnection.peer.addStream(this.screenShareStream);
      }

      screenShareConnections[pubKeyB64] = relevantConnection;

      if (initiator) {
        this._screenShareConnectionsOutgoing.update(currentValue => {
          const screenShareConnections = currentValue;
          screenShareConnections[pubKeyB64] = relevantConnection;
          return screenShareConnections;
        });
      } else {
        this._screenShareConnectionsIncoming.update(currentValue => {
          const screenShareConnections = currentValue;
          screenShareConnections[pubKeyB64] = relevantConnection;
          return screenShareConnections;
        });
        this.eventCallback({
          type: 'peer-screen-share-connected',
          pubKeyB64,
          connectionId,
        });
      }

      this.updateScreenShareConnectionStatus(pubKeyB64, { type: 'Connected' });
    });
    peer.on('close', () => {
      console.log('#### GOT SCREEN SHARE CLOSE EVENT ####');

      peer.destroy();

      if (initiator) {
        this._screenShareConnectionsOutgoing.update(currentValue => {
          const screenShareConnections = currentValue;
          delete screenShareConnections[pubKeyB64];
          return screenShareConnections;
        });
      } else {
        this._screenShareConnectionsIncoming.update(currentValue => {
          const screenShareConnections = currentValue;
          delete screenShareConnections[pubKeyB64];
          return screenShareConnections;
        });
        this.eventCallback({
          type: 'peer-screen-share-disconnected',
          pubKeyB64,
          connectionId,
        });
      }

      this.updateScreenShareConnectionStatus(pubKeyB64, {
        type: 'Disconnected',
      });
    });
    peer.on('error', e => {
      console.log('#### GOT SCREEN SHARE ERROR EVENT ####: ', e);
      peer.destroy();

      if (initiator) {
        this._screenShareConnectionsOutgoing.update(currentValue => {
          const screenShareConnections = currentValue;
          delete screenShareConnections[pubKeyB64];
          return screenShareConnections;
        });
      } else {
        this._screenShareConnectionsIncoming.update(currentValue => {
          const screenShareConnections = currentValue;
          delete screenShareConnections[pubKeyB64];
          return screenShareConnections;
        });
        this.eventCallback({
          type: 'peer-screen-share-disconnected',
          pubKeyB64,
          connectionId,
        });
      }

      this.updateScreenShareConnectionStatus(pubKeyB64, {
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

  /**
   * Compares how the other peer sees our stream and if this mismatches our expectations,
   * reset streams accordingly
   *
   * @param pubkey
   * @param streamAndTrackInfo
   */
  reconcileVideoStreamState(
    pubkey: AgentPubKeyB64,
    streamAndTrackInfo: StreamAndTrackInfo
  ) {
    if (this.mainStream) {
      // If we have an active video stream but the other peer doesn't see it,
      // re-add it to their peer and return
      if (!streamAndTrackInfo.stream) {
        console.warn(
          'Peer does not seem to see our own stream. Re-adding it to their peer object...'
        );
        const peer = get(this._openConnections)[pubkey];
        if (peer) {
          peer.peer.addStream(this.mainStream);
        }
        return;
      }
      const peer = get(this._openConnections)[pubkey];

      const myAudioTracks = this.mainStream?.getAudioTracks();
      const myAudioTrack = myAudioTracks ? myAudioTracks[0] : undefined;

      const myVideoTracks = this.mainStream?.getVideoTracks();
      const myVideoTrack = myVideoTracks ? myVideoTracks[0] : undefined;

      // If we have an audio track but the other peer doesn't see it or sees it non-functional,
      // re-add it to their peer
      if (myAudioTrack) {
        const audioTrackPerceived = streamAndTrackInfo.tracks.find(
          track => track.kind === 'audio'
        );
        if (!audioTrackPerceived || audioTrackPerceived.muted) {
          console.warn(
            'Peer does not seem to see our audio track or it is muted:',
            audioTrackPerceived,
            '\nRe-adding it to their peer object...'
          );
          peer.peer.removeStream(this.mainStream);

          // It is not really clear why but things only work properly if done exactly in this way
          // where a cloned stream is created and the original tracks are being added back
          // to the cloned stream. It is also important (!) that this cloned stream is stored
          // and in audioOff() the audio tracks of this cloned stream are being disabled explicitly.
          // Otherwise, audio *will* keep running on the remote peer's side!
          //
          // If not the full stream is removed and re-added but only tracks, the stream on the
          // remote peer's side will be set to "active: false" and re-added tracks will never
          // show up on their side.
          // This may be the reason why removing and re-adding tracks throws a hard error
          // in simple-peer: https://github.com/feross/simple-peer/issues/606
          //
          // If re-adding tracks should ever be required anyway, there's the
          // @matthme/simple-peer@9.11.2 packaged based off
          // https://github.com/matthme/simple-peer/commit/8076d57b21a405992750fe4546fa242da5d9ed96
          //
          const clonedStream = this.mainStream.clone();
          this.mainStreamClones = [...this.mainStreamClones, clonedStream];
          peer.peer.addStream(clonedStream);
          peer.peer.addTrack(myAudioTrack, clonedStream);
          if (myVideoTrack) {
            peer.peer.addTrack(myVideoTrack, clonedStream);
          }
        }
      }

      // If we have a video track but the other peer doesn't see it or sees it non-functional,
      // re-add it to their peer
      if (myVideoTrack) {
        const videoTrackPerceived = streamAndTrackInfo.tracks.find(
          track => track.kind === 'video'
        );
        if (!videoTrackPerceived || videoTrackPerceived.muted) {
          console.warn(
            'Peer does not seem to see our video track or it is muted:',
            videoTrackPerceived,
            '\nRe-adding it to their peer object...'
          );
          peer.peer.removeStream(this.mainStream);
          // Same logic as above with the audio tracks
          const clonedStream = this.mainStream.clone();
          this.mainStreamClones = [...this.mainStreamClones, clonedStream];
          peer.peer.addStream(clonedStream);
          peer.peer.addTrack(myVideoTrack, clonedStream);
          if (myAudioTrack) {
            peer.peer.addTrack(myAudioTrack, clonedStream);
          }
        }
      }
    }
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
    if (get(this.blockedAgents).includes(pubkeyB64)) return;
    // console.log(`Got PingUi from ${pubkeyB64}: `, signal);

    let streamInfo: StreamAndTrackInfo = {
      stream: null,
      tracks: [],
    };

    const stream = this._videoStreams[pubkeyB64];

    if (stream) {
      const tracks = stream.getTracks();
      const tracksInfo: TrackInfo[] = [];
      tracks.forEach(track => {
        tracksInfo.push({
          kind: track.kind as 'audio' | 'video',
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
        });
      });
      streamInfo = {
        stream: {
          active: stream.active,
        },
        tracks: tracksInfo,
      };
    }

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
          streamInfo,
          audio: get(this._openConnections)[pubkeyB64]?.audio,
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
   * - Check whether the stream that they see of us matches what we
   *   expect and if not, try to reconcile
   *
   * @param signal
   */
  async handlePongUi(signal: Extract<RoomSignal, { type: 'PongUi' }>) {
    const pubkeyB64 = encodeHashToBase64(signal.from_agent);
    const now = Date.now();
    // console.log(`Got PongUI from ${pubkeyB64}: `, signal);
    // Update their connection statuses and the list of known agents
    let metaDataExt: PongMetaData<PongMetaDataV1> | undefined;
    try {
      const metaData: PongMetaData<PongMetaDataV1> = JSON.parse(
        signal.meta_data
      );
      this.logger.logAgentPongMetaData(pubkeyB64, metaData.data);
      metaDataExt = metaData;
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
    const alreadyOpen = get(this._openConnections)[pubkeyB64];
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
    } else if (alreadyOpen && metaDataExt?.data.streamInfo) {
      // If the connection is already open, reconcile with our expected stream state
      this.reconcileVideoStreamState(pubkeyB64, metaDataExt.data.streamInfo);
    }

    // Check whether they have the right expectation of our audio state and if not,
    // send an audio-off signal
    if (alreadyOpen && metaDataExt?.data.audio) {
      if (!this.mainStream?.getAudioTracks()[0]?.enabled) {
        const msg: RTCMessage = {
          type: 'action',
          message: 'audio-off',
        };
        try {
          alreadyOpen.peer.send(JSON.stringify(msg));
        } catch (e: any) {
          console.error(
            'Failed to send audio-off message to peer: ',
            e.toString()
          );
        }
      }
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
}
