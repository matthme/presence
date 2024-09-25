import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  encodeHashToBase64,
  AgentPubKeyB64,
  AgentPubKey,
  decodeHashFromBase64,
} from '@holochain/client';

import { StoreSubscriber, lazyLoadAndPoll } from '@holochain-open-dev/stores';
import SimplePeer from 'simple-peer';
import { v4 as uuidv4 } from 'uuid';
import {
  mdiAccount,
  mdiFullscreen,
  mdiFullscreenExit,
  mdiLock,
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiMonitorScreenshot,
  mdiPaperclip,
  mdiVideo,
  mdiVideoOff,
} from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { localized, msg } from '@lit/localize';
import { consume } from '@lit/context';
import { repeat } from 'lit/directives/repeat.js';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import '@holochain-open-dev/elements/dist/elements/holo-identicon.js';
import { WeaveClient, weaveUrlFromWal } from '@theweave/api';
import { EntryRecord } from '@holochain-open-dev/utils';

import { roomStoreContext } from './contexts';
import { sharedStyles } from './sharedStyles';
import './avatar-with-nickname';
import { Attachment, RoomInfo, weaveClientContext } from './types';
import { RoomStore } from './room-store';
import './attachment-element';
import './agent-connection-status';
import './agent-connection-status-icon';
import './toggle-switch';
import { sortConnectionStatuses } from './utils';

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
  appVersion?: string;
};

@localized()
@customElement('room-view')
export class RoomView extends LitElement {
  @consume({ context: roomStoreContext, subscribe: true })
  @state()
  roomStore!: RoomStore;

  @consume({ context: weaveClientContext })
  @state()
  _weaveClient!: WeaveClient;

  @property({ type: Boolean })
  private = false;

  @state()
  pingInterval: number | undefined;

  _allAgentsFromAnchor = new StoreSubscriber(
    this,
    () => this.roomStore.allAgents,
    () => [this.roomStore]
  );

  _allAttachments = new StoreSubscriber(
    this,
    () =>
      lazyLoadAndPoll(async () => {
        const allAttachments = this.roomStore.client.getAllAttachments();
        const recentlyChangedAttachments = this._recentAttachmentChanges;
        recentlyChangedAttachments.added = [];
        recentlyChangedAttachments.deleted = [];
        this._recentAttachmentChanges = recentlyChangedAttachments;
        return allAttachments;
      }, 5000),
    () => [this.roomStore]
  );

  @state()
  _knownAgents: Record<AgentPubKeyB64, AgentInfo> = {};

  @state()
  _recentAttachmentChanges: Record<string, EntryRecord<Attachment>[]> = {
    added: [],
    deleted: [],
  };

  @state()
  _roomInfo: RoomInfo | undefined;

  @state()
  _onlineAgents: AgentPubKeyB64[] = [];

  /**
   * Our own video/audio stream
   */
  @state()
  _mainStream: MediaStream | undefined | null;

  /**
   * Our own screen share stream
   */
  @state()
  _screenShareStream: MediaStream | undefined | null;

  updateConnectionStatus(pubKey: AgentPubKeyB64, status: ConnectionStatus) {
    const connectionStatuses = this._connectionStatuses;
    if (status.type === 'InitSent') {
      const currentStatus = this._connectionStatuses[pubKey];
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
      this._connectionStatuses = connectionStatuses;
      return;
    }
    if (status.type === 'AcceptSent') {
      const currentStatus = this._connectionStatuses[pubKey];
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
      this._connectionStatuses = connectionStatuses;
      return;
    }
    connectionStatuses[pubKey] = status;
    this._connectionStatuses = connectionStatuses;
  }

  @state()
  _connectionStatuses: ConnectionStatuses = {};

  @state()
  _othersConnectionStatuses: Record<
    AgentPubKeyB64,
    {
      lastUpdated: number;
      statuses: ConnectionStatuses;
      knownAgents?: Record<AgentPubKeyB64, AgentInfo>;
    }
  > = {};

  /**
   * Connections where the Init/Accept handshake succeeded
   */
  @state()
  _openConnections: Record<AgentPubKeyB64, OpenConnectionInfo> = {};

  /**
   * Connections where we are sharing our own screen and the Init/Accept handshake succeeded
   */
  @state()
  _screenShareConnectionsOutgoing: Record<AgentPubKeyB64, OpenConnectionInfo> =
    {};

  /**
   * Connections where others are sharing their screen and the Init/Accept handshake succeeded
   */
  @state()
  _screenShareConnectionsIncoming: Record<AgentPubKeyB64, OpenConnectionInfo> =
    {};

  /**
   * Pending Init requests
   */
  @state()
  _pendingInits: Record<AgentPubKeyB64, PendingInit[]> = {};

  /**
   * Pending Accepts
   */
  @state()
  _pendingAccepts: Record<AgentPubKeyB64, PendingAccept[]> = {};

  /**
   * Pending Init requests for screen sharing
   */
  @state()
  _pendingScreenShareInits: Record<AgentPubKeyB64, PendingInit[]> = {};

  /**
   * Pending Init Accepts for screen sharing
   */
  @state()
  _pendingScreenShareAccepts: Record<AgentPubKeyB64, PendingAccept[]> = {};

  @state()
  _microphone = false;

  @state()
  _camera = false;

  @state()
  _hoverCamera = false;

  @state()
  _hoverMicrophone = false;

  @state()
  _hoverScreen = false;

  @state()
  _maximizedVideo: string | undefined; // id of the maximized video if any

  @state()
  _displayError: string | undefined;

  @state()
  _joinAudio = new Audio('doorbell.mp3');

  @state()
  _leaveAudio = new Audio('percussive-drum-hit.mp3');

  @state()
  _showAttachmentsPanel = false;

  @state()
  _panelMode: 'attachments' | 'people' = 'attachments';

  @state()
  _showConnectionDetails = false;

  @state()
  _unsubscribe: (() => void) | undefined;

  sideClickListener = (e: MouseEvent) => {
    if (this._showAttachmentsPanel) {
      this._showAttachmentsPanel = false;
    }
  };

  notifyError(msg: string) {
    this._displayError = msg;
    setTimeout(() => {
      this._displayError = undefined;
    }, 4000);
  }

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
      this.roomStore.client.sendSdpData({
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
            const openConnections = this._openConnections;
            const relevantConnection =
              openConnections[encodeHashToBase64(connectingAgent)];
            relevantConnection.video = false;
            openConnections[encodeHashToBase64(connectingAgent)] =
              relevantConnection;
            this._openConnections = openConnections;
            this.requestUpdate();
          }
          if (msg.message === 'audio-off') {
            const openConnections = this._openConnections;
            const relevantConnection =
              openConnections[encodeHashToBase64(connectingAgent)];
            relevantConnection.audio = false;
            openConnections[encodeHashToBase64(connectingAgent)] =
              relevantConnection;
            this._openConnections = openConnections;
            this.requestUpdate();
          }
          if (msg.message === 'audio-on') {
            const openConnections = this._openConnections;
            const relevantConnection =
              openConnections[encodeHashToBase64(connectingAgent)];
            relevantConnection.audio = true;
            openConnections[encodeHashToBase64(connectingAgent)] =
              relevantConnection;
            this._openConnections = openConnections;
            this.requestUpdate();
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
      // console.log('Open connections: ', this._openConnections);
      const openConnections = this._openConnections;
      const relevantConnection =
        openConnections[encodeHashToBase64(connectingAgent)];
      if (relevantConnection) {
        if (stream.getAudioTracks().length > 0) {
          relevantConnection.audio = true;
        }
        if (stream.getVideoTracks().length > 0) {
          relevantConnection.video = true;
        }
        openConnections[encodeHashToBase64(connectingAgent)] =
          relevantConnection;
        this._openConnections = openConnections;
        try {
          const videoEl = this.shadowRoot?.getElementById(connectionId) as
            | HTMLVideoElement
            | undefined;
          if (videoEl) {
            videoEl.autoplay = true;
            videoEl.srcObject = stream;
          }
        } catch (e) {
          console.error('Failed to play video: ', e);
        }
      }
      this.requestUpdate();
    });
    peer.on('track', track => {
      console.log('#### GOT TRACK: ', track);
      const openConnections = this._openConnections;
      const relevantConnection =
        openConnections[encodeHashToBase64(connectingAgent)];
      if (track.kind === 'audio') {
        relevantConnection.audio = true;
      }
      if (track.kind === 'video') {
        relevantConnection.video = true;
      }
      openConnections[encodeHashToBase64(connectingAgent)] = relevantConnection;
      this._openConnections = openConnections;
      this.requestUpdate();
    });
    peer.on('connect', async () => {
      console.log('#### CONNECTED');
      const pendingInits = this._pendingInits;
      delete pendingInits[pubKey64];
      this._pendingInits = pendingInits;

      const openConnections = this._openConnections;
      const relevantConnection = openConnections[pubKey64];
      relevantConnection.connected = true;

      // if we are already sharing video or audio, add the relevant streams
      if (this._mainStream) {
        relevantConnection.peer.addStream(this._mainStream);
      }

      openConnections[pubKey64] = relevantConnection;
      this._openConnections = openConnections;

      this.updateConnectionStatus(pubKey64, { type: 'Connected' });

      this.requestUpdate();
      await this._joinAudio.play();
    });
    peer.on('close', async () => {
      console.log('#### GOT CLOSE EVENT ####');

      peer.destroy();

      const openConnections = this._openConnections;
      const relevantConnection =
        openConnections[encodeHashToBase64(connectingAgent)];
      if (
        relevantConnection &&
        this._maximizedVideo === relevantConnection.connectionId
      ) {
        this._maximizedVideo = undefined;
      }
      delete openConnections[encodeHashToBase64(connectingAgent)];
      this._openConnections = openConnections;

      this.updateConnectionStatus(pubKey64, { type: 'Disconnected' });

      this.requestUpdate();
      await this._leaveAudio.play();
    });
    peer.on('error', e => {
      console.log('#### GOT ERROR EVENT ####: ', e);
      peer.destroy();

      const openConnections = this._openConnections;
      const relevantConnection =
        openConnections[encodeHashToBase64(connectingAgent)];
      if (
        relevantConnection &&
        this._maximizedVideo === relevantConnection.connectionId
      ) {
        this._maximizedVideo = undefined;
      }
      delete openConnections[encodeHashToBase64(connectingAgent)];
      this._openConnections = openConnections;

      this.updateConnectionStatus(pubKey64, { type: 'Disconnected' });

      this.requestUpdate();
    });
    return peer;
  }

  createScreenSharePeer(
    connectingAgent: AgentPubKey,
    connectionId: string,
    initiator: boolean
  ): SimplePeer.Instance {
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
      const screenShareConnections = this._screenShareConnectionsIncoming;
      const relevantConnection =
        screenShareConnections[encodeHashToBase64(connectingAgent)];
      if (relevantConnection) {
        if (stream.getAudioTracks().length > 0) {
          relevantConnection.audio = true;
        }
        if (stream.getVideoTracks().length > 0) {
          relevantConnection.video = true;
        }
        screenShareConnections[encodeHashToBase64(connectingAgent)] =
          relevantConnection;
        this._screenShareConnectionsIncoming = screenShareConnections;
      }
      const videoEl = this.shadowRoot?.getElementById(connectionId) as
        | HTMLVideoElement
        | undefined;
      if (videoEl) {
        videoEl.autoplay = true;
        videoEl.srcObject = stream;
      }
      this.requestUpdate();
    });
    peer.on('connect', () => {
      console.log('#### SCREEN SHARE CONNECTED');
      const pubKey64 = encodeHashToBase64(connectingAgent);

      const screenShareConnections = initiator
        ? this._screenShareConnectionsOutgoing
        : this._screenShareConnectionsIncoming;
      const relevantConnection = screenShareConnections[pubKey64];

      relevantConnection.connected = true;

      // if we are already sharing the screen, add the relevant stream
      if (
        this._screenShareStream &&
        relevantConnection.direction === 'outgoing'
      ) {
        relevantConnection.peer.addStream(this._screenShareStream);
      }

      screenShareConnections[pubKey64] = relevantConnection;

      if (initiator) {
        this._screenShareConnectionsOutgoing = screenShareConnections;
      } else {
        this._screenShareConnectionsIncoming = screenShareConnections;
      }
      this.requestUpdate();
    });
    peer.on('close', () => {
      console.log('#### GOT SCREEN SHARE CLOSE EVENT ####');

      peer.destroy();

      const pubkeyB64 = encodeHashToBase64(connectingAgent);

      if (initiator) {
        const screenShareConnections = this._screenShareConnectionsOutgoing;
        delete screenShareConnections[pubkeyB64];
        this._screenShareConnectionsOutgoing = screenShareConnections;
      } else {
        const screenShareConnections = this._screenShareConnectionsIncoming;
        delete screenShareConnections[pubkeyB64];
        this._screenShareConnectionsIncoming = screenShareConnections;
      }

      if (this._maximizedVideo === connectionId) {
        this._maximizedVideo = undefined;
      }

      this.requestUpdate();
    });
    peer.on('error', e => {
      console.log('#### GOT SCREEN SHARE ERROR EVENT ####: ', e);
      peer.destroy();

      const pubkeyB64 = encodeHashToBase64(connectingAgent);

      if (initiator) {
        const screenShareConnections = this._screenShareConnectionsOutgoing;
        delete screenShareConnections[pubkeyB64];
        this._screenShareConnectionsOutgoing = screenShareConnections;
      } else {
        const screenShareConnections = this._screenShareConnectionsIncoming;
        delete screenShareConnections[pubkeyB64];
        this._screenShareConnectionsIncoming = screenShareConnections;
      }

      this.requestUpdate();
    });
    return peer;
  }

  async videoOn() {
    if (this._mainStream) {
      if (this._mainStream.getVideoTracks()[0]) {
        console.log('### CASE A');
        this._mainStream.getVideoTracks()[0].enabled = true;
        this._camera = true;
      } else {
        console.log('### CASE B');
        let videoStream: MediaStream | undefined;
        try {
          videoStream = await navigator.mediaDevices.getUserMedia({
            video: true,
          });
        } catch (e: any) {
          console.error(`Failed to get media devices (video): ${e.toString()}`);
          this.notifyError(
            `Failed to get media devices (video): ${e.toString()}`
          );
          return;
        }
        this._mainStream.addTrack(videoStream!.getVideoTracks()[0]);
        const myVideo = this.shadowRoot?.getElementById(
          'my-own-stream'
        ) as HTMLVideoElement;
        myVideo.autoplay = true;
        myVideo.srcObject = this._mainStream;
        this._camera = true;
        try {
          Object.values(this._openConnections).forEach(conn => {
            conn.peer.addTrack(
              videoStream!.getVideoTracks()[0],
              this._mainStream!
            );
          });
        } catch (e: any) {
          console.error(`Failed to add video track: ${e.toString()}`);
        }
      }
    } else {
      try {
        this._mainStream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
      } catch (e: any) {
        console.error(`Failed to get media devices (video): ${e.toString()}`);
        this.notifyError(
          `Failed to get media devices (video): ${e.toString()}`
        );
        return;
      }
      const myVideo = this.shadowRoot?.getElementById(
        'my-own-stream'
      ) as HTMLVideoElement;
      myVideo.autoplay = true;
      myVideo.srcObject = this._mainStream;
      this._camera = true;
      try {
        Object.values(this._openConnections).forEach(conn => {
          conn.peer.addStream(this._mainStream!);
        });
      } catch (e: any) {
        console.error(`Failed to add video track: ${e.toString()}`);
      }
    }
  }

  async videoOff() {
    if (this._mainStream) {
      this._mainStream.getVideoTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.stop();
      });
      Object.values(this._openConnections).forEach(conn => {
        try {
          this._mainStream!.getVideoTracks().forEach(track => {
            conn.peer.removeTrack(track, this._mainStream!);
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
      this._mainStream.getVideoTracks().forEach(track => {
        this._mainStream!.removeTrack(track);
      });
      this._camera = false;
    }
  }

  async audioOn() {
    if (this._mainStream) {
      if (this._mainStream.getAudioTracks()[0]) {
        this._mainStream.getAudioTracks()[0].enabled = true;
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
          this.notifyError(
            `Failed to get media devices (audio): ${e.toString()}`
          );
          return;
        }
        try {
          this._mainStream.addTrack(audioStream!.getAudioTracks()[0]);
          Object.values(this._openConnections).forEach(conn => {
            conn.peer.addTrack(
              audioStream!.getAudioTracks()[0],
              this._mainStream!
            );
          });
        } catch (e: any) {
          console.error(`Failed to add video track: ${e.toString()}`);
        }
      }
    } else {
      try {
        this._mainStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: true,
            echoCancellation: true,
          },
        });
        this._microphone = true;
      } catch (e: any) {
        console.error(`Failed to get media devices (audio): ${e.toString()}`);
        this.notifyError(
          `Failed to get media devices (audio): ${e.toString()}`
        );
        return;
      }
      Object.values(this._openConnections).forEach(conn => {
        conn.peer.addStream(this._mainStream!);
      });
    }
    this._microphone = true;
    Object.values(this._openConnections).forEach(conn => {
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

  async audioOff() {
    console.log('### AUDIO OFF');
    console.log(
      'this._mainStream.getTracks(): ',
      this._mainStream?.getTracks()
    );
    if (this._mainStream) {
      console.log('### DISABLING ALL AUDIO TRACKS');
      this._mainStream.getAudioTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = false;
        console.log('### DISABLED AUDIO TRACK: ', track);
      });
      Object.values(this._openConnections).forEach(conn => {
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
      this._microphone = false;
    }
  }

  async screenShareOn() {
    if (this._screenShareStream) {
      this._screenShareStream.getVideoTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = true;
      });
    } else {
      try {
        const screenSource = await this._weaveClient.userSelectScreen();
        this._screenShareStream = await navigator.mediaDevices.getUserMedia({
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
      try {
        const myScreenVideo = this.shadowRoot?.getElementById(
          'my-own-screen'
        ) as HTMLVideoElement;
        myScreenVideo.autoplay = true;
        myScreenVideo.srcObject = this._screenShareStream!;
      } catch (e: any) {
        console.error(`Failed to play screen share video: ${e.toString()}`);
      }
      Object.values(this._screenShareConnectionsOutgoing).forEach(conn => {
        if (this._screenShareStream) {
          conn.peer.addStream(this._screenShareStream);
        }
      });
    }
  }

  /**
   * Turning screen sharing off is equivalent to closing the corresponding peer connection
   */
  async screenShareOff() {
    if (this._screenShareStream) {
      this._screenShareStream.getVideoTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.stop();
      });
      Object.values(this._screenShareConnectionsOutgoing).forEach(conn => {
        conn.peer.destroy();
      });
      if (this._maximizedVideo === 'my-own-screen') {
        this._maximizedVideo = undefined;
      }
      this._screenShareStream = null;
    }
  }

  quitRoom() {
    Object.values(this._openConnections).forEach(conn => {
      conn.peer.destroy();
    });
    this.videoOff();
    this.audioOff();
    this.screenShareOff();
    this._mainStream = null;
    this._screenShareStream = null;
    this._openConnections = {};
    this._screenShareConnectionsOutgoing = {};
    this._screenShareConnectionsIncoming = {};
    this._pendingAccepts = {};
    this._pendingInits = {};
    this.dispatchEvent(
      new CustomEvent('quit-room', { bubbles: true, composed: true })
    );
  }

  async firstUpdated() {
    this.addEventListener('click', this.sideClickListener);
    this._unsubscribe = this.roomStore.client.onSignal(async signal => {
      switch (signal.type) {
        case 'PingUi': {
          if (
            signal.from_agent.toString() !==
            this.roomStore.client.client.myPubKey.toString()
          ) {
            const metaData: PongMetaData<PongMetaDataV1> = {
              formatVersion: 1,
              data: {
                connectionStatuses: this._connectionStatuses,
                knownAgents: this._knownAgents,
                appVersion: __APP_VERSION__,
              },
            };
            await this.roomStore.client.pongFrontend({
              to_agent: signal.from_agent,
              meta_data: JSON.stringify(metaData),
            });
          }
          break;
        }

        case 'PongUi': {
          const pubkeyB64 = encodeHashToBase64(signal.from_agent);
          const now = Date.now();
          console.log(`Got PongUI from ${pubkeyB64}: `, signal);

          // Update their connection statuses and the list of known agents
          try {
            const metaData: PongMetaData<PongMetaDataV1> = JSON.parse(
              signal.meta_data
            );
            const othersConnectionStatuses = this._othersConnectionStatuses;
            othersConnectionStatuses[pubkeyB64] = {
              lastUpdated: now,
              statuses: metaData.data.connectionStatuses,
              knownAgents: metaData.data.knownAgents,
            };
            this._othersConnectionStatuses = othersConnectionStatuses;

            // Update known agents based on the agents that they know
            const knownAgents = this._knownAgents;
            const maybeKnownAgent = knownAgents[pubkeyB64];
            if (maybeKnownAgent) {
              maybeKnownAgent.appVersion = metaData.data.appVersion;
            } else {
              knownAgents[pubkeyB64] = {
                pubkey: pubkeyB64,
                type: 'told',
                appVersion: metaData.data.appVersion,
              };
            }
            if (metaData.data.knownAgents) {
              const myPubKeyB64 = encodeHashToBase64(
                this.roomStore.client.client.myPubKey
              );
              Object.entries(metaData.data.knownAgents).forEach(
                ([agentB64, agentInfo]) => {
                  if (!knownAgents[agentB64] && agentB64 !== myPubKeyB64) {
                    knownAgents[agentB64] = {
                      pubkey: agentB64,
                      type: 'told',
                      appVersion: agentInfo.appVersion,
                    };
                  }
                }
              );
            }
            this._knownAgents = knownAgents;
            this.requestUpdate();
          } catch (e) {
            console.warn('Failed to parse pong meta data.');
          }

          /**
           * Normal video/audio stream
           *
           * If our agent puglic key is alphabetically "higher" than the agent public key
           * sending the pong and there is no open connection yet with this and there is
           * no pending InitRequest from less than 5 seconds ago (and we therefore have to
           * assume that a remote signal got lost), send an InitRequest.
           */
          const alreadyOpen = Object.keys(this._openConnections).includes(
            pubkeyB64
          );
          const pendingInits = this._pendingInits[pubkeyB64];
          if (
            !alreadyOpen &&
            pubkeyB64 <
              encodeHashToBase64(this.roomStore.client.client.myPubKey)
          ) {
            if (!pendingInits) {
              console.log('#### SENDING FIRST INIT REQUEST.');
              const newConnectionId = uuidv4();
              this._pendingInits[pubkeyB64] = [
                { connectionId: newConnectionId, t0: now },
              ];
              await this.roomStore.client.sendInitRequest({
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
                await this.roomStore.client.sendInitRequest({
                  connection_id: newConnectionId,
                  to_agent: signal.from_agent,
                });
                this.updateConnectionStatus(pubkeyB64, { type: 'InitSent' });
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
            this._screenShareConnectionsOutgoing
          ).includes(pubkeyB64);
          const pendingScreenShareInits = this._pendingInits[pubkeyB64];
          if (this._screenShareStream && !alreadyOpenScreenShareOutgoing) {
            if (!pendingScreenShareInits) {
              console.log('#### SENDING FIRST SCREEN SHARE INIT REQUEST.');
              const newConnectionId = uuidv4();
              this._pendingScreenShareInits[pubkeyB64] = [
                { connectionId: newConnectionId, t0: now },
              ];
              await this.roomStore.client.sendInitRequest({
                connection_type: 'screen',
                connection_id: newConnectionId,
                to_agent: signal.from_agent,
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
                this._pendingScreenShareInits[pubkeyB64] =
                  pendingScreenShareInits;
                await this.roomStore.client.sendInitRequest({
                  connection_type: 'screen',
                  connection_id: newConnectionId,
                  to_agent: signal.from_agent,
                });
              }
            }
          }
          break;
        }

        case 'InitRequest': {
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
          if (
            signal.connection_type !== 'screen' &&
            pubKey64 > encodeHashToBase64(this.roomStore.client.client.myPubKey)
          ) {
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
            const newPendingAcceptsForAgent: PendingAccept[] =
              pendingAcceptsForAgent
                ? [...pendingAcceptsForAgent, accept]
                : [accept];
            allPendingAccepts[pubKey64] = newPendingAcceptsForAgent;
            this._pendingAccepts = allPendingAccepts;

            await this.roomStore.client.sendInitAccept({
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
            const allPendingAccepts = this._pendingScreenShareAccepts;
            const pendingAcceptsForAgent =
              allPendingAccepts[encodeHashToBase64(signal.from_agent)];
            const newPendingAcceptsForAgent: PendingAccept[] =
              pendingAcceptsForAgent
                ? [...pendingAcceptsForAgent, accept]
                : [accept];
            allPendingAccepts[encodeHashToBase64(signal.from_agent)] =
              newPendingAcceptsForAgent;
            this._pendingScreenShareAccepts = allPendingAccepts;

            await this.roomStore.client.sendInitAccept({
              connection_id: signal.connection_id,
              to_agent: signal.from_agent,
            });
          }
          break;
        }

        case 'InitAccept': {
          const pubKey64 = encodeHashToBase64(signal.from_agent);

          /**
           * For normal video/audio connections
           *
           * If there is no open connection with this agent yet and the connectionId
           * is one matching an InitRequest we sent earlier, create a Simple Peer
           * Instance and add it to open connections, then delete all PendingInits
           * for this agent
           */
          const agentPendingInits = this._pendingInits[pubKey64];
          if (
            !Object.keys(this._openConnections).includes(pubKey64) &&
            agentPendingInits
          ) {
            if (
              agentPendingInits
                .map(pendingInit => pendingInit.connectionId)
                .includes(signal.connection_id)
            ) {
              console.log(
                '#### RECEIVED INIT ACCEPT AND CEATING INITIATING PEER.'
              );
              const newPeer = this.createPeer(
                signal.from_agent,
                signal.connection_id,
                true
              );

              const openConnections = this._openConnections;
              openConnections[pubKey64] = {
                connectionId: signal.connection_id,
                peer: newPeer,
                video: false,
                audio: false,
                connected: false,
                direction: 'duplex',
              };
              this._openConnections = openConnections;

              const pendingInits = this._pendingInits;
              delete pendingInits[pubKey64];
              this._pendingInits = pendingInits;

              this.updateConnectionStatus(pubKey64, { type: 'SdpExchange' });

              this.requestUpdate(); // reload rendered video containers
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
          const agentPendingScreenShareInits =
            this._pendingScreenShareInits[pubKey64];
          if (
            !Object.keys(this._screenShareConnectionsOutgoing).includes(
              pubKey64
            ) &&
            agentPendingScreenShareInits
          ) {
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

              const screenShareConnectionsOutgoing =
                this._screenShareConnectionsOutgoing;
              screenShareConnectionsOutgoing[pubKey64] = {
                connectionId: signal.connection_id,
                peer: newPeer,
                video: true,
                audio: false,
                connected: false,
                direction: 'outgoing', // if we initiated the request, we're the one's delivering the stream
              };
              this._screenShareConnectionsOutgoing =
                screenShareConnectionsOutgoing;

              const pendingScreenShareInits = this._pendingScreenShareInits;
              delete pendingScreenShareInits[pubKey64];
              this._pendingScreenShareInits = pendingScreenShareInits;
              this.requestUpdate(); // reload rendered video containers
            }
          }
          break;
        }

        case 'SdpData': {
          console.log('## Got SDP Data: ', signal.data);
          const pubkeyB64 = encodeHashToBase64(signal.from_agent);

          // If not connected already, update the status do SdpExchange (SDP Exchange also happens when already connected)
          if (
            this._connectionStatuses[pubkeyB64] &&
            this._connectionStatuses[pubkeyB64].type !== 'Connected'
          ) {
            this.updateConnectionStatus(pubkeyB64, { type: 'SdpExchange' });
          }

          /**
           * Normal video/audio connections
           */
          const maybeOpenConnection = this._openConnections[pubkeyB64];
          if (
            maybeOpenConnection &&
            maybeOpenConnection.connectionId === signal.connection_id
          ) {
            maybeOpenConnection.peer.signal(JSON.parse(signal.data));
          } else {
            /**
             * If there's no open connection but a PendingAccept then move that
             * PendingAccept to the open connections and destroy all other
             * Peer Instances for PendingAccepts of this agent and delete the
             * PendingAccepts
             */
            const allPendingAccepts = this._pendingAccepts;
            const pendingAccepts = allPendingAccepts[pubkeyB64];
            if (pendingAccepts) {
              const maybePendingAccept = pendingAccepts.find(
                pendingAccept =>
                  pendingAccept.connectionId === signal.connection_id
              );
              if (maybePendingAccept) {
                maybePendingAccept.peer.signal(JSON.parse(signal.data));
                console.log(
                  '#### FOUND PENDING ACCEPT! Moving to open connections...'
                );
                const openConnections = this._openConnections;
                openConnections[pubkeyB64] = {
                  connectionId: signal.connection_id,
                  peer: maybePendingAccept.peer,
                  video: false,
                  audio: false,
                  connected: false,
                  direction: 'duplex',
                };
                this._openConnections = openConnections;
                const otherPendingAccepts = pendingAccepts.filter(
                  pendingAccept =>
                    pendingAccept.connectionId !== signal.connection_id
                );
                otherPendingAccepts.forEach(pendingAccept =>
                  pendingAccept.peer.destroy()
                );

                delete allPendingAccepts[pubkeyB64];
                this._pendingAccepts = allPendingAccepts;
                this.requestUpdate();
                break;
              }
            }
          }

          /**
           * Outgoing Screen Share connections
           */
          const maybeOutgoingScreenShareConnection =
            this._screenShareConnectionsOutgoing[pubkeyB64];
          if (
            maybeOutgoingScreenShareConnection &&
            maybeOutgoingScreenShareConnection.connectionId ===
              signal.connection_id
          ) {
            maybeOutgoingScreenShareConnection.peer.signal(
              JSON.parse(signal.data)
            );
          }

          /**
           * Incoming Screen Share connections
           */
          const maybeIncomingScreenShareConnection =
            this._screenShareConnectionsIncoming[pubkeyB64];
          if (
            maybeIncomingScreenShareConnection &&
            maybeIncomingScreenShareConnection.connectionId ===
              signal.connection_id
          ) {
            maybeIncomingScreenShareConnection.peer.signal(
              JSON.parse(signal.data)
            );
          } else {
            /**
             * If there's no open connection but a PendingAccept then move that
             * PendingAccept to the open connections and destroy all other
             * Peer Instances for PendingAccepts of this agent and delete the
             * PendingAccepts
             */
            const allPendingScreenShareAccepts =
              this._pendingScreenShareAccepts;
            const pendingScreenShareAccepts =
              allPendingScreenShareAccepts[pubkeyB64];
            if (pendingScreenShareAccepts) {
              const maybePendingAccept = pendingScreenShareAccepts.find(
                pendingAccept =>
                  pendingAccept.connectionId === signal.connection_id
              );
              if (maybePendingAccept) {
                maybePendingAccept.peer.signal(JSON.parse(signal.data));
                const screenShareConnectionsIncoming =
                  this._screenShareConnectionsIncoming;
                screenShareConnectionsIncoming[pubkeyB64] = {
                  connectionId: signal.connection_id,
                  peer: maybePendingAccept.peer,
                  video: false,
                  audio: false,
                  connected: false,
                  direction: 'incoming',
                };
                this._screenShareConnectionsIncoming =
                  screenShareConnectionsIncoming;
                const otherPendingAccepts = pendingScreenShareAccepts.filter(
                  pendingAccept =>
                    pendingAccept.connectionId !== signal.connection_id
                );
                otherPendingAccepts.forEach(pendingAccept =>
                  pendingAccept.peer.destroy()
                );

                delete allPendingScreenShareAccepts[pubkeyB64];
                this._pendingScreenShareAccepts = allPendingScreenShareAccepts;
                this.requestUpdate();
              }
            }
          }
          break;
        }

        default:
          break;
      }
    });
    // ping all agents that are not already connected to you every PING_INTERVAL milliseconds
    await this.pingAgents();
    this.pingInterval = window.setInterval(async () => {
      await this.pingAgents();
    }, PING_INTERVAL);
    this._leaveAudio.volume = 0.05;
    this._joinAudio.volume = 0.07;
    this._roomInfo = await this.roomStore.client.getRoomInfo();
  }

  async pingAgents() {
    if (this._allAgentsFromAnchor.value.status === 'complete') {
      // Update known agents
      const myPubKeyB64 = encodeHashToBase64(
        this.roomStore.client.client.myPubKey
      );
      const knownAgents = this._knownAgents;
      this._allAgentsFromAnchor.value.value
        .map(agent => encodeHashToBase64(agent))
        .forEach(agentB64 => {
          if (agentB64 !== myPubKeyB64) {
            knownAgents[agentB64] = { pubkey: agentB64, type: 'known' };
          }
        });
      this._knownAgents = knownAgents;
    }
    // Update connection statuses with known people for which we do not yet have a connection status
    const connectionStatuses = this._connectionStatuses;
    Object.keys(this._knownAgents).forEach(agentB64 => {
      if (!connectionStatuses[agentB64]) {
        connectionStatuses[agentB64] = {
          type: 'Disconnected',
        };
      }
    });
    this._connectionStatuses = connectionStatuses;

    // Ping known agents
    // This could potentially be optimized by only pinging agents that are online according to Moss (which would only work in shared rooms though)
    const agentsToPing = Object.keys(this._knownAgents).map(pubkeyB64 =>
      decodeHashFromBase64(pubkeyB64)
    );
    await this.roomStore.client.pingFrontend(agentsToPing);
  }

  async addAttachment() {
    const wal = await this._weaveClient.userSelectWal();
    console.log('Got WAL: ', wal);
    if (wal) {
      const newAttachment = await this.roomStore.client.createAttachment({
        wal: weaveUrlFromWal(wal, false),
      });
      const recentlyChanged = this._recentAttachmentChanges;
      const recentlyAddedAttachments = [
        ...recentlyChanged.added,
        newAttachment,
      ];
      recentlyChanged.added = recentlyAddedAttachments;
      this._recentAttachmentChanges = recentlyChanged;
      this.requestUpdate();
    }
  }

  async removeAttachment(entryRecord: EntryRecord<Attachment>) {
    await this.roomStore.client.deleteAttachment(entryRecord.actionHash);
    const recentlyChanged = this._recentAttachmentChanges;
    const recentlyDeletedAttachments = [
      ...recentlyChanged.deleted,
      entryRecord,
    ];
    recentlyChanged.deleted = recentlyDeletedAttachments;
    this._recentAttachmentChanges = recentlyChanged;
    this.requestUpdate();
  }

  toggleMaximized(id: string) {
    if (this._maximizedVideo !== id) {
      this._maximizedVideo = id;
    } else {
      this._maximizedVideo = undefined;
    }
  }

  disconnectedCallback(): void {
    if (this.pingInterval) window.clearInterval(this.pingInterval);
    if (this._unsubscribe) this._unsubscribe();
    this.removeEventListener('click', this.sideClickListener);
  }

  idToLayout(id: string) {
    if (id === this._maximizedVideo) return 'maximized';
    if (this._maximizedVideo) return 'hidden';
    const incomingScreenShareNum = Object.keys(
      this._screenShareConnectionsIncoming
    ).length;
    const ownScreenShareNum = this._screenShareStream ? 1 : 0;
    const num =
      Object.keys(this._openConnections).length +
      incomingScreenShareNum +
      ownScreenShareNum +
      1;

    if (num === 1) {
      return 'single';
    }
    if (num <= 2) {
      return 'double';
    }
    if (num <= 4) {
      return 'quartett';
    }
    if (num <= 6) {
      return 'sextett';
    }
    if (num <= 8) {
      return 'octett';
    }
    return 'unlimited';
  }

  roomName() {
    if (this.roomStore.client.roleName === 'presence') return msg('Main Room');
    if (this._roomInfo) return this._roomInfo.name;
    return '[unknown]';
  }

  renderConnectionDetailsToggle() {
    return html`
      <div class="row toggle-switch-container" style="align-items: center;">
        <toggle-switch
          class="toggle-switch ${this._showConnectionDetails ? 'active' : ''}"
          .toggleState=${this._showConnectionDetails}
          @click=${(e: Event) => {
            e.stopPropagation();
          }}
          @toggle-on=${() => {
            this._showConnectionDetails = true;
          }}
          @toggle-off=${() => {
            this._showConnectionDetails = false;
          }}
        ></toggle-switch>
        <span
          class="secondary-font"
          style="cursor: default; margin-left: 7px; ${this
            ._showConnectionDetails
            ? 'opacity: 0.8;'
            : 'opacity: 0.5;'}"
          >${this._showConnectionDetails
            ? 'Hide connection details'
            : 'Show connection details'}</span
        >
      </div>
    `;
  }

  renderAttachmentButton() {
    const numAttachments =
      this._allAttachments.value.status === 'complete'
        ? this._allAttachments.value.value.length
        : undefined;
    const numPeople = Object.values(this._connectionStatuses).filter(
      status => !!status && status.type !== 'Disconnected'
    ).length;
    return html`
      <div
        tabindex="0"
        class="attachments-btn row center-content"
        @click=${(e: MouseEvent) => {
          this._showAttachmentsPanel = true;
          e.stopPropagation();
        }}
        @keypress=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            this._showAttachmentsPanel = true;
          }
        }}
      >
        <div style="margin-bottom: -2px; margin-left: 2px;">
          ${numAttachments || numAttachments === 0 ? numAttachments : ''}
        </div>
        <sl-icon
          .src=${wrapPathInSvg(mdiPaperclip)}
          style="transform: rotate(5deg); margin-left: -2px;"
        ></sl-icon>
        <div style="margin-bottom: -2px; margin-left: 2px;">${numPeople}</div>
        <sl-icon
          .src=${wrapPathInSvg(mdiAccount)}
          style="transform: rotate(3deg); margin-left: -2px;"
        ></sl-icon>
      </div>
    `;
  }

  renderAttachments() {
    switch (this._allAttachments.value.status) {
      case 'pending':
        return html`loading...`;
      case 'error':
        console.error(
          'Failed to load attachments: ',
          this._allAttachments.value.error
        );
        return html`Failed to load attachments:
        ${this._allAttachments.value.error}`;
      case 'complete': {
        const allAttachments = [
          ...this._recentAttachmentChanges.added,
          ...this._allAttachments.value.value,
        ];
        const recentlyDeletedAttachmentHashes =
          this._recentAttachmentChanges.deleted.map(entryRecord =>
            entryRecord.actionHash.toString()
          );
        const allDeduplicatedAttachments = allAttachments
          .filter(
            (value, index, self) =>
              index ===
              self.findIndex(
                t => t.actionHash.toString() === value.actionHash.toString()
              )
          )
          .filter(
            entryRecord =>
              !recentlyDeletedAttachmentHashes.includes(
                entryRecord.actionHash.toString()
              )
          );

        return html`
          <div class="column attachments-list">
            ${repeat(
              allDeduplicatedAttachments.sort(
                (entryRecord_a, entryRecord_b) =>
                  entryRecord_b.action.timestamp -
                  entryRecord_a.action.timestamp
              ),
              entryRecord => encodeHashToBase64(entryRecord.actionHash),
              entryRecord => html`
                <attachment-element
                  style="margin-bottom: 8px;"
                  .entryRecord=${entryRecord}
                  @remove-attachment=${(e: CustomEvent) =>
                    this.removeAttachment(e.detail)}
                ></attachment-element>
              `
            )}
          </div>
        `;
      }
      default:
        return html`unkown territory...`;
    }
  }

  renderConnectionStatuses() {
    const knownAgentsKeysB64 = Object.keys(this._knownAgents);

    const presentAgents = knownAgentsKeysB64
      .filter(pubkeyB64 => {
        const status = this._connectionStatuses[pubkeyB64];
        return !!status && status.type !== 'Disconnected';
      })
      .sort((key_a, key_b) => key_a.localeCompare(key_b));
    const absentAgents = knownAgentsKeysB64
      .filter(pubkeyB64 => {
        const status = this._connectionStatuses[pubkeyB64];
        return !status || status.type === 'Disconnected';
      })
      .sort((key_a, key_b) => key_a.localeCompare(key_b));
    return html`
      <div
        class="column"
        style="padding-left: 10px; align-items: flex-start; margin-top: 10px; height: 100%;"
      >
        <div class="column" style="align-items: flex-end;">
          <div class="connectivity-title">Present</div>
          <hr class="divider" />
        </div>
        ${presentAgents.length > 0
          ? repeat(
              presentAgents,
              pubkey => pubkey,
              pubkey => html`
                <agent-connection-status
                  .agentPubKey=${decodeHashFromBase64(pubkey)}
                  .connectionStatus=${this._connectionStatuses[pubkey]}
                  .appVersion=${this._knownAgents[pubkey].appVersion}
                ></agent-connection-status>
              `
            )
          : html`<span
              style="color: #c3c9eb; font-size: 20px; font-style: italic; margin-top: 10px; opacity: 0.8;"
              >no one else present.</span
            >`}
        ${absentAgents.length > 0
          ? html`
              <div class="column" style="align-items: flex-end;">
                <div class="connectivity-title">Absent</div>
                <hr class="divider" />
              </div>
              ${repeat(
                absentAgents,
                pubkey => pubkey,
                pubkey => html`
                  <agent-connection-status
                    .agentPubKey=${decodeHashFromBase64(pubkey)}
                    .connectionStatus=${this._connectionStatuses[pubkey]}
                  ></agent-connection-status>
                `
              )}
            `
          : html``}
      </div>
    `;
  }

  renderAttachmentPanel() {
    return html`
      <div
        class="column attachment-panel secondary-font"
        style="align-items: flex-start; justify-content: flex-start;"
        @click=${(e: MouseEvent) => e.stopPropagation()}
        @keypress=${() => undefined}
      >
        <div class="row close-panel">
          <div
            tabindex="0"
            class="close-btn"
            style="margin-right: 10px;"
            @click=${() => {
              this._showAttachmentsPanel = false;
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                this._showAttachmentsPanel = false;
              }
            }}
          >
            ${msg('close X')}
          </div>
        </div>
        <div class="row sidepanel-tabs">
          <div
            class="sidepanel-tab ${this._panelMode === 'attachments'
              ? 'tab-selected'
              : ''}"
            tabindex="0"
            @click=${() => {
              this._panelMode = 'attachments';
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ')
                this._panelMode = 'attachments';
            }}
          >
            <div class="row center-content">
              <sl-icon
                .src=${wrapPathInSvg(mdiPaperclip)}
                style="transform: rotate(5deg); margin-right: 2px;"
              ></sl-icon>
              attachments
            </div>
          </div>
          <div
            class="sidepanel-tab ${this._panelMode === 'people'
              ? 'tab-selected'
              : ''}"
            tabindex="0"
            @click=${() => {
              this._panelMode = 'people';
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ')
                this._panelMode = 'people';
            }}
          >
            <div class="row center-content">
              <sl-icon
                .src=${wrapPathInSvg(mdiAccount)}
                style="transform: rotate(2deg); margin-right: 2px;"
              ></sl-icon>
              people
            </div>
          </div>
        </div>
        ${this._panelMode === 'people'
          ? this.renderConnectionStatuses()
          : html`
              <div
                class="column"
                style="margin-top: 18px; padding: 0 20px; align-items: flex-start; position: relative; height: 100%;"
              >
                <div
                  tabindex="0"
                  class="add-attachment-btn"
                  @click=${() => this.addAttachment()}
                  @keypress=${async (e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      await this.addAttachment();
                    }
                  }}
                >
                  + Add Attachment
                </div>
                ${this.renderAttachments()}
              </div>
            `}
      </div>
    `;
  }

  renderToggles() {
    return html`
      <div class="toggles-panel">
        <sl-tooltip
          content="${this._microphone ? msg('Voice Off') : msg('Voice On')}"
          hoist
        >
          <div
            class="toggle-btn ${this._microphone ? '' : 'btn-off'}"
            tabindex="0"
            @click=${async () => {
              if (this._microphone) {
                await this.audioOff();
              } else {
                await this.audioOn();
              }
            }}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (this._microphone) {
                  await this.audioOff();
                } else {
                  await this.audioOn();
                }
              }
            }}
            @mouseenter=${() => {
              this._hoverMicrophone = true;
            }}
            @mouseleave=${() => {
              this._hoverMicrophone = false;
            }}
            @blur=${() => {
              this._hoverMicrophone = false;
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${(this._hoverMicrophone &&
                !this._microphone) ||
              this._microphone
                ? ''
                : 'btn-icon-off'}"
              .src=${(this._hoverMicrophone && !this._microphone) ||
              this._microphone
                ? wrapPathInSvg(mdiMicrophone)
                : wrapPathInSvg(mdiMicrophoneOff)}
            ></sl-icon>
          </div>
        </sl-tooltip>

        <sl-tooltip
          content="${this._camera ? msg('Camera Off') : msg('Camera On')}"
          hoist
        >
          <div
            class="toggle-btn ${this._camera ? '' : 'btn-off'}"
            tabindex="0"
            @click=${async () => {
              if (this._camera) {
                await this.videoOff();
              } else {
                await this.videoOn();
              }
            }}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (this._camera) {
                  await this.videoOff();
                } else {
                  await this.videoOn();
                }
              }
            }}
            @mouseenter=${() => {
              this._hoverCamera = true;
            }}
            @mouseleave=${() => {
              this._hoverCamera = false;
            }}
            @blur=${() => {
              this._hoverCamera = false;
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${(this._hoverCamera && !this._camera) ||
              this._camera
                ? ''
                : 'btn-icon-off'}"
              .src=${(this._hoverCamera && !this._camera) || this._camera
                ? wrapPathInSvg(mdiVideo)
                : wrapPathInSvg(mdiVideoOff)}
            ></sl-icon>
          </div>
        </sl-tooltip>

        <sl-tooltip
          content="${this._screenShareStream
            ? msg('Stop Screen Sharing')
            : msg('Share Screen')}"
          hoist
        >
          <div
            class="toggle-btn ${this._screenShareStream ? '' : 'btn-off'}"
            tabindex="0"
            @click=${async () => {
              if (this._screenShareStream) {
                await this.screenShareOff();
              } else {
                await this.screenShareOn();
              }
            }}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (this._screenShareStream) {
                  await this.screenShareOff();
                } else {
                  await this.screenShareOn();
                }
              }
            }}
            @mouseenter=${() => {
              this._hoverScreen = true;
            }}
            @mouseleave=${() => {
              this._hoverScreen = false;
            }}
            @blur=${() => {
              this._hoverScreen = false;
            }}
          >
            <sl-icon
              class="toggle-btn-icon ${(this._hoverScreen &&
                !this._screenShareStream) ||
              this._screenShareStream
                ? ''
                : 'btn-icon-off'}"
              .src=${wrapPathInSvg(mdiMonitorScreenshot)}
            ></sl-icon>
          </div>
        </sl-tooltip>

        <sl-tooltip content="${msg('Leave Call')}" hoist>
          <div
            class="btn-stop"
            tabindex="0"
            @click=${async () => this.quitRoom()}
            @keypress=${async (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                this.quitRoom();
              }
            }}
          >
            <div class="stop-icon"></div>
          </div>
        </sl-tooltip>
      </div>
    `;
  }

  renderOtherAgentConnectionStatuses(pubkeyb64: AgentPubKeyB64) {
    const statuses = this._othersConnectionStatuses[pubkeyb64];
    if (!statuses)
      return html`<span
        class="tertiary-font"
        style="color: #c3c9eb; font-size: 16px;"
        >Unkown connection statuses</span
      >`;

    const nConnections = Object.values(statuses.statuses).filter(
      status => status.type === 'Connected'
    ).length;

    const now = Date.now();
    // if the info is older than >2.8 PING_INTERVAL, show the info opaque to indicated that it's outdated
    const staleInfo = now - statuses.lastUpdated > 2.8 * PING_INTERVAL;
    const sortedStatuses = Object.entries(statuses.statuses).sort(
      sortConnectionStatuses
    );
    return html`
      <div class="row" style="align-items: center; flex-wrap: wrap;">
        ${repeat(
          sortedStatuses,
          ([pubkeyb64, _status]) => pubkeyb64,
          ([pubkeyb64, status]) => {
            // Check whether the agent for which the statuses are rendered has only been told by others that
            // the rendered agent exists
            const onlyToldAbout = !!(
              statuses.knownAgents &&
              statuses.knownAgents[pubkeyb64] &&
              statuses.knownAgents[pubkeyb64].type === 'told'
            );

            return html`<agent-connection-status-icon
              style="margin-right: 2px; margin-bottom: 2px; ${staleInfo
                ? 'opacity: 0.5;'
                : ''}"
              .agentPubKey=${decodeHashFromBase64(pubkeyb64)}
              .connectionStatus=${status}
              .onlyToldAbout=${onlyToldAbout}
            ></agent-connection-status-icon>`;
          }
        )}
        <span
          class="tertiary-font"
          style="color: #c3c9eb; font-size: 24px; margin-left: 5px;"
          >(${nConnections})</span
        >
      </div>
    `;
  }

  render() {
    return html`
      <div class="row center-content room-name">
        ${this.private
          ? html`<sl-icon
              .src=${wrapPathInSvg(mdiLock)}
              style="font-size: 28px; margin-right: 3px;"
            ></sl-icon>`
          : html``}
        ${this.roomName()}
      </div>
      <div class="videos-container">
        <!-- My own screen first if screen sharing is enabled -->
        <div
          style="${this._screenShareStream ? '' : 'display: none;'}"
          class="video-container screen-share ${this.idToLayout(
            'my-own-screen'
          )}"
          @dblclick=${() => this.toggleMaximized('my-own-screen')}
        >
          <video muted id="my-own-screen" class="video-el"></video>
          <div
            style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
          >
            <avatar-with-nickname
              .size=${36}
              .agentPubKey=${this.roomStore.client.client.myPubKey}
              style="height: 36px;"
            ></avatar-with-nickname>
          </div>
          <sl-icon
            title="${this._maximizedVideo === 'my-own-screen'
              ? 'minimize'
              : 'maximize'}"
            .src=${this._maximizedVideo === 'my-own-screen'
              ? wrapPathInSvg(mdiFullscreenExit)
              : wrapPathInSvg(mdiFullscreen)}
            tabindex="0"
            class="maximize-icon"
            @click=${() => {
              this.toggleMaximized('my-own-screen');
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                this.toggleMaximized('my-own-screen');
              }
            }}
          ></sl-icon>
        </div>
        <!--Then other agents' screens -->

        ${repeat(
          Object.entries(this._screenShareConnectionsIncoming).filter(
            ([_, conn]) => conn.direction === 'incoming'
          ),
          ([_pubkeyB64, conn]) => conn.connectionId,
          ([pubkeyB64, conn]) => html`
            <div
              class="video-container screen-share ${this.idToLayout(
                conn.connectionId
              )}"
              @dblclick=${() => this.toggleMaximized(conn.connectionId)}
            >
              <video
                style="${conn.connected ? '' : 'display: none;'}"
                id="${conn.connectionId}"
                class="video-el"
              ></video>
              <div
                style="color: #b98484; ${conn.connected ? 'display: none' : ''}"
              >
                establishing connection...
              </div>
              <div
                style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
              >
                <avatar-with-nickname
                  .size=${36}
                  .agentPubKey=${decodeHashFromBase64(pubkeyB64)}
                  style="height: 36px;"
                ></avatar-with-nickname>
              </div>
              <sl-icon
                title="${this._maximizedVideo === conn.connectionId
                  ? 'minimize'
                  : 'maximize'}"
                .src=${this._maximizedVideo === conn.connectionId
                  ? wrapPathInSvg(mdiFullscreenExit)
                  : wrapPathInSvg(mdiFullscreen)}
                tabindex="0"
                class="maximize-icon"
                @click=${() => {
                  this.toggleMaximized(conn.connectionId);
                }}
                @keypress=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') {
                    this.toggleMaximized(conn.connectionId);
                  }
                }}
              ></sl-icon>
            </div>
          `
        )}

        <!-- My own video stream -->
        <div
          class="video-container ${this.idToLayout('my-own-stream')}"
          @dblclick=${() => this.toggleMaximized('my-own-stream')}
        >
          <video
            muted
            style="${this._camera
              ? ''
              : 'display: none;'}; transform: scaleX(-1);"
            id="my-own-stream"
            class="video-el"
          ></video>
          <sl-icon
            style="color: #b98484; height: 30%; width: 30%;${this._camera
              ? 'display: none;'
              : ''}"
            .src=${wrapPathInSvg(mdiVideoOff)}
          ></sl-icon>
          <div
            style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
          >
            <avatar-with-nickname
              .size=${36}
              .agentPubKey=${this.roomStore.client.client.myPubKey}
              style="height: 36px;"
            ></avatar-with-nickname>
          </div>
          <sl-icon
            style="position: absolute; bottom: 10px; left: 10px; color: red; height: 30px; width: 30px; ${this
              ._microphone
              ? 'display: none'
              : ''}"
            .src=${wrapPathInSvg(mdiMicrophoneOff)}
          ></sl-icon>
        </div>

        <!-- Video stream of others -->
        ${repeat(
          Object.entries(this._openConnections),
          ([_pubkeyB64, conn]) => conn.connectionId,
          ([pubkeyB64, conn]) => html`
            <div
              class="video-container ${this.idToLayout(conn.connectionId)}"
              @dblclick=${() => this.toggleMaximized(conn.connectionId)}
            >
              <video
                style="${conn.video ? '' : 'display: none;'}"
                id="${conn.connectionId}"
                class="video-el"
              ></video>
              <sl-icon
                style="color: #b98484; height: 30%; width: 30%;${!conn.connected ||
                conn.video
                  ? 'display: none;'
                  : ''}"
                .src=${wrapPathInSvg(mdiVideoOff)}
              ></sl-icon>
              <div
                style="color: #b98484; ${conn.connected ? 'display: none' : ''}"
              >
                establishing connection...
              </div>
              <!-- Connection states indicators -->
              ${this._showConnectionDetails
                ? html`<div
                    style="display: flex; flex-direction: row; align-items: center; position: absolute; top: 10px; left: 10px; background: none;"
                  >
                    ${this.renderOtherAgentConnectionStatuses(pubkeyB64)}
                  </div>`
                : html``}

              <!-- Avatar and nickname -->
              <div
                style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
              >
                <avatar-with-nickname
                  .size=${36}
                  .agentPubKey=${decodeHashFromBase64(pubkeyB64)}
                  style="height: 36px;"
                ></avatar-with-nickname>
              </div>
              <sl-icon
                style="position: absolute; bottom: 10px; left: 10px; color: red; height: 30px; width: 30px; ${conn.audio
                  ? 'display: none'
                  : ''}"
                .src=${wrapPathInSvg(mdiMicrophoneOff)}
              ></sl-icon>
            </div>
          `
        )}
      </div>
      ${this.renderToggles()}
      ${this._showAttachmentsPanel ? this.renderAttachmentPanel() : undefined}
      ${this._showAttachmentsPanel ? undefined : this.renderAttachmentButton()}
      ${this.renderConnectionDetailsToggle()}

      <div
        class="error-message secondary-font"
        style="${this._displayError ? '' : 'display: none;'}"
      >
        ${this._displayError}
      </div>
      <div
        class="stop-share"
        tabindex="0"
        style="${this._screenShareStream ? '' : 'display: none'}"
        @click=${async () => this.screenShareOff()}
        @keypress=${async (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            await this.screenShareOff();
          }
        }}
      >
        ${msg('Stop Screen Share')}
      </div>
    `;
  }

  static styles = [
    sharedStyles,
    css`
      main {
        flex-grow: 1;
        margin: 0;
        background: #2b304a;
      }

      .attachment-panel {
        position: absolute;
        top: 0;
        bottom: 94px;
        right: 0;
        width: 400px;
        background: linear-gradient(
          #6f7599c4,
          #6f7599c4 80%,
          #6f759979 90%,
          #6f759900
        );
        /* background: #6f7599; */
      }

      .sidepanel-tabs {
        width: 100%;
        align-items: center;
        margin-top: 10px;
        /* #ffffff80 */
      }

      .sidepanel-tab {
        width: 50%;
        height: 40px;
        /* background: #ffffff10; */
        background: linear-gradient(#6f7599c4, #6f759900);
        cursor: pointer;
        font-size: 24px;
        color: #0d1543;
        font-weight: 600;
        padding-top: 4px;
      }

      .sidepanel-tab:hover {
        /* background: #ffffff80; */
        background: linear-gradient(#c6d2ff87, #6f759900);
      }

      .tab-selected {
        /* background: #ffffff80; */
        background: linear-gradient(#c6d2ff87, #6f759900);
      }

      .attachments-list {
        justify-content: flex-start;
        align-items: flex-start;
        overflow-y: auto;
        position: absolute;
        top: 45px;
        bottom: 5px;
        width: 376px;
        padding: 2px;
      }

      .attachments-list::-webkit-scrollbar {
        display: none;
      }

      .close-panel {
        /* background: linear-gradient(-90deg, #2f3052, #6f7599c4); */
        color: #0d1543;
        font-weight: bold;
        width: 400px;
        height: 40px;
        justify-content: flex-end;
        align-items: center;
        /* font-family: 'Ubuntu', sans-serif; */
        font-size: 22px;
      }

      .close-btn {
        cursor: pointer;
      }

      .close-btn:hover {
        color: #c3c9eb;
        /* background: linear-gradient(-90deg, #a0a1cb, #6f7599c4); */
      }

      .add-attachment-btn {
        all: unset;
        text-align: center;
        color: #c3c9eb;
        /* font-family: 'Baloo 2 Variable', sans-serif; */
        /* font-family: 'Ubuntu'; */
        font-size: 22px;
        cursor: pointer;
        margin-bottom: 15px;
        font-weight: 600;
      }

      .add-attachment-btn:hover {
        color: white;
      }

      .add-attachment-btn:focus {
        color: white;
      }

      .divider {
        height: 1px;
        border: 0;
        width: 380px;
        background: #0d1543;
        margin: 0 0 5px 0;
      }

      .connectivity-title {
        font-style: italic;
        font-weight: bold;
        font-size: 16px;
        margin-bottom: -3px;
        color: #0d1543;
      }

      .room-name {
        position: absolute;
        bottom: 5px;
        left: 15px;
        color: #6f7599;
      }

      .toggle-switch-container {
        position: absolute;
        top: 10px;
        left: 10px;
        color: #c3c9eb;
        font-size: 20px;
      }

      .toggle-switch {
        opacity: 0.6;
      }

      /* .toggle-switch:hover {
        opacity: 1;
      } */

      .active {
        opacity: 1;
      }

      .attachments-btn {
        position: absolute;
        top: 10px;
        right: 10px;
        /* background: #c3c9eb; */
        background: linear-gradient(#c3c9ebd6, #a7b0dfd6);
        opacity: 0.8;
        font-weight: 500;
        border-radius: 20px;
        font-family: 'Baloo 2 Variable', sans-serif;
        font-size: 24px;
        padding: 3px 10px;
        cursor: pointer;
        box-shadow: 0px 0px 5px 2px #0b0f28;
      }

      .attachments-btn:hover {
        /* background: #dbdff9; */
        background: linear-gradient(#c3c9eb, #a7b0df);
      }

      .attachments-btn:focus {
        /* background: #dbdff9; */
        background: linear-gradient(#d4d9f3, #bac2e9);
      }

      .stop-share {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        padding: 6px 10px;
        position: absolute;
        top: 10px;
        left: 0;
        right: 0;
        margin-left: auto;
        margin-right: auto;
        width: 300px;
        color: white;
        background: #b60606;
        border-radius: 10px;
        font-family: sans-serif;
        font-size: 20px;
        font-weight: bold;
        box-shadow: 0 0 2px white;
        z-index: 1;
        cursor: pointer;
      }

      .stop-share:hover {
        background: #fd5959;
      }

      .stop-share:focus-visible {
        background: #fd5959;
      }

      .error-message {
        position: fixed;
        bottom: 10px;
        right: 10px;
        padding: 5px 10px;
        border-radius: 10px;
        color: #f8c7c7;
        background: linear-gradient(#8b1616, #8b1616 30%, #6e0a0a);
        /* background: #7b0e0e; */
        box-shadow: 0 0 3px 1px #721c1c;
      }

      .videos-container {
        display: flex;
        flex: 1;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        width: 100vw;
        min-height: 100vh;
        margin: 0;
        align-content: center;
      }

      .video-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        position: relative;
        aspect-ratio: 16 / 9;
        border-radius: 20px;
        border: 2px solid #7291c9;
        margin: 5px;
        overflow: hidden;
        background: black;
      }

      .maximized {
        height: 98.5vh;
        width: 98.5vw;
        margin: 0;
      }

      .maximize-icon {
        position: absolute;
        bottom: 5px;
        left: 5px;
        /* color: #facece; */
        color: #ffe100;
        height: 40px;
        width: 40px;
        cursor: pointer;
      }

      .maximize-icon:hover {
        color: #ffe100;
        transform: scale(1.2);
      }

      .maximize-icon:focus-visible {
        color: #ffe100;
        transform: scale(1.2);
      }

      .hidden {
        display: none;
      }

      .screen-share {
        border: 4px solid #ffe100;
      }

      .video-el {
        height: 100%;
        max-width: 100%;
      }

      .identicon canvas {
        width: 180px;
        height: 180px;
      }

      .single {
        height: min(98vh, 100%);
        width: min(98vw, 100%);
        max-height: 98vh;
        border: none;
      }

      .double {
        width: min(48.5%, 48.5vw);
        min-width: max(280px, 48.5vw);
      }

      .quartett {
        width: min(48.5%, 48.5vw, 84vh);
        min-width: min(84vh, max(280px, 48.5vw));
      }

      .sextett {
        width: min(32.5%, 32.5vw);
        min-width: max(280px, 32.5vw);
      }

      .octett {
        width: min(32.5%, 32.5vw, 55vh);
        min-width: min(55vh, max(280px, 32.5vw));
      }

      .btn-stop {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #9c0f0f;
        margin: 0 5px;
        border-radius: 50%;
        height: 60px;
        width: 60px;
        cursor: pointer;
      }

      .btn-stop:hover {
        background: #dc4a4a;
      }

      .stop-icon {
        height: 23px;
        width: 23px;
        border-radius: 3px;
        background: #eba6a6;
      }

      .toggle-btn-icon {
        height: 40px;
        width: 40px;
        /* color: #e7d9aa; */
        color: #facece;
      }

      .btn-icon-off {
        color: #6482c9;
      }

      .toggle-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #17529f;
        margin: 0 5px;
        border-radius: 50%;
        height: 60px;
        width: 60px;
        cursor: pointer;
      }

      .btn-off {
        background: #22365c;
      }

      .toggle-btn:hover {
        background: #17529f;
      }

      .toggle-btn:hover:not(.btn-off) {
        background: #22365c;
      }

      .toggles-panel {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        position: fixed;
        font-size: 19px;
        bottom: 10px;
        right: 10px;
        width: 298px;
        height: 74px;
        border-radius: 37px;
        background: #0e142c;
        color: #facece;
        box-shadow: 0 0 3px 2px #050b21;
        /* left: calc(50% - 150px); */
      }
    `,
  ];
}
