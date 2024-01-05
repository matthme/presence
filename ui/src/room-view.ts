import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  encodeHashToBase64,
  AgentPubKeyB64,
  AgentPubKey,
  decodeHashFromBase64,
} from '@holochain/client';
import { StoreSubscriber } from '@holochain-open-dev/stores';
import SimplePeer from 'simple-peer';
import { v4 as uuidv4 } from 'uuid';
import {
  mdiFullscreen,
  mdiFullscreenExit,
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiMonitorScreenshot,
  mdiVideo,
  mdiVideoOff,
} from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { localized, msg } from '@lit/localize';
import { consume } from '@lit/context';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import '@holochain-open-dev/elements/dist/elements/holo-identicon.js';
import { WeClient } from '@lightningrodlabs/we-applet';

import { UnzoomStore } from './unzoom-store';
import { unzoomStoreContext } from './contexts';
import { sharedStyles } from './sharedStyles';
import './avatar-with-nickname';
import { weClientContext } from './types';

const ICE_CONFIG = [
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

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
  connectionId: string;
  peer: SimplePeer.Instance;
  video: boolean;
  audio: boolean;
  connected: boolean;
  direction: 'outgoing' | 'incoming' | 'duplex'; // In which direction streams are expected
};
@localized()
@customElement('room-view')
export class RoomView extends LitElement {
  @consume({ context: unzoomStoreContext, subscribe: true })
  @state()
  unzoomStore!: UnzoomStore;

  @consume({ context: weClientContext })
  @state()
  _weClient!: WeClient;

  @state()
  pingInterval: number | undefined;

  _allAgents = new StoreSubscriber(
    this,
    () => this.unzoomStore.allAgents,
    () => [this.unzoomStore]
  );

  @state()
  _mainStream: MediaStream | undefined | null;

  @state()
  _screenShareStream: MediaStream | undefined | null;

  @state()
  _onlineAgents: AgentPubKeyB64[] = [];

  @state()
  _openConnections: Record<AgentPubKeyB64, OpenConnectionInfo> = {};

  @state()
  _screenShareConnections: Record<AgentPubKeyB64, OpenConnectionInfo> = {};

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
  _pendingInits: Record<AgentPubKeyB64, ConnectionId> = {};

  @state()
  _pendingScreenShareInits: Record<AgentPubKeyB64, ConnectionId> = {};

  @state()
  _maximizedVideo: string | undefined; // id of the maximized video if any

  @state()
  _displayError: string | undefined;

  @state()
  _unsubscribe: (() => void) | undefined;

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
      this.unzoomStore.client.sendSdpData({
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
      console.log(
        '#### GOT TRACK: ', track
      );
      const openConnections = this._openConnections;
      const relevantConnection =
        openConnections[encodeHashToBase64(connectingAgent)];
      if (track.kind === "audio") {
          relevantConnection.audio = true;
      }
      if (track.kind === "video") {
        relevantConnection.video = true;
      }
      openConnections[encodeHashToBase64(connectingAgent)] =
        relevantConnection;
      this._openConnections = openConnections;
      this.requestUpdate();
    });
    peer.on('connect', () => {
      console.log('#### CONNECTED');
      const pubKey64 = encodeHashToBase64(connectingAgent);
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

      this.requestUpdate();
    });
    peer.on('close', () => {
      console.log('#### GOT CLOSE EVENT ####');

      peer.destroy();

      const openConnections = this._openConnections;
      delete openConnections[encodeHashToBase64(connectingAgent)];
      this._openConnections = openConnections;

      this.requestUpdate();
    });
    peer.on('error', e => {
      console.log('#### GOT ERROR EVENT ####: ', e);
      peer.destroy();

      const openConnections = this._openConnections;
      delete openConnections[encodeHashToBase64(connectingAgent)];
      this._openConnections = openConnections;

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
      this.unzoomStore.client.sendSdpData({
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
      const screenShareConnections = this._screenShareConnections;
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
        this._screenShareConnections = screenShareConnections;
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
      const pendingScreenShareInits = this._pendingScreenShareInits;
      delete pendingScreenShareInits[pubKey64];
      this._pendingScreenShareInits = pendingScreenShareInits;

      const screenShareConnections = this._screenShareConnections;
      const relevantConnection = screenShareConnections[pubKey64];
      relevantConnection.connected = true;

      // if we are already sharing the screen, add the relevant stream
      if (this._screenShareStream) {
        relevantConnection.peer.addStream(this._screenShareStream);
      }

      screenShareConnections[pubKey64] = relevantConnection;
      this._screenShareConnections = screenShareConnections;
      this.requestUpdate();
    });
    peer.on('close', () => {
      console.log('#### GOT SCREEN SHARE CLOSE EVENT ####');

      peer.destroy();

      const screenShareConnections = this._screenShareConnections;
      delete screenShareConnections[encodeHashToBase64(connectingAgent)];
      this._screenShareConnections = screenShareConnections;

      if (this._maximizedVideo === connectionId) {
        this._maximizedVideo = undefined;
      }

      this.requestUpdate();
    });
    peer.on('error', e => {
      console.log('#### GOT SCREEN SHARE ERROR EVENT ####: ', e);
      peer.destroy();

      const screenShareConnections = this._screenShareConnections;
      delete screenShareConnections[encodeHashToBase64(connectingAgent)];
      this._screenShareConnections = screenShareConnections;

      this.requestUpdate();
    });
    return peer;
  }

  async videoOn() {
    if (this._mainStream) {
      if (this._mainStream.getVideoTracks()[0]) {
        console.log("### CASE A");
        this._mainStream.getVideoTracks()[0].enabled = true;
        this._camera = true;
      } else {
        console.log("### CASE B");
        let videoStream: MediaStream | undefined;
        try {
          videoStream = await navigator.mediaDevices.getUserMedia({
            video: true,
          });
        } catch (e: any) {
          console.error(`Failed to get media devices (video): ${e.toString()}`);
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
            audio: true,
          });
        } catch (e: any) {
          console.error(`Failed to get media devices (audio): ${e.toString()}`);
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
          audio: true,
        });
        this._microphone = true;
      } catch (e: any) {
        console.error(`Failed to get media devices (audio): ${e.toString()}`);
      }
      const audioTrack = this._mainStream?.getAudioTracks()[0];
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
    console.log("this._mainStream.getTracks(): ", this._mainStream?.getTracks());
    if (this._mainStream) {
      console.log("### DISABLING ALL AUDIO TRACKS");
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
      if (Object.keys(this._screenShareConnections).length > 0) {
        this.notifyError(
          'You are already connected to the screen share of someone else.'
        );
        throw new Error(
          'You are already connected to the screen share of someone else.'
        );
      }
      try {
        const screenSource = await this._weClient.userSelectScreen();
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
      Object.values(this._screenShareConnections).forEach(conn => {
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
      Object.values(this._screenShareConnections).forEach(conn => {
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
    this._screenShareConnections = {};
    this.dispatchEvent(
      new CustomEvent('quit-room', { bubbles: true, composed: true })
    );
  }

  async firstUpdated() {
    this._unsubscribe = this.unzoomStore.client.onSignal(async signal => {
      switch (signal.type) {
        case 'PingUi': {
          if (
            signal.from_agent.toString() !==
            this.unzoomStore.client.client.myPubKey.toString()
          ) {
            await this.unzoomStore.client.pongFrontend(signal.from_agent);
          }
          break;
        }
        case 'PongUi': {
          const pubkeyB64 = encodeHashToBase64(signal.from_agent);
          console.log('Got PongUI from ', pubkeyB64);
          // Create normal connection if necessary
          if (
            !Object.keys(this._openConnections).includes(pubkeyB64) &&
            !Object.keys(this._pendingInits).includes(pubkeyB64)
          ) {
            // Only initialize connections with agents who's public key is alphabetically lower than ours
            if (
              pubkeyB64 <
              encodeHashToBase64(this.unzoomStore.client.client.myPubKey)
            ) {
              console.log('#### SENDING INIT REQUEST.');
              const newConnectionId = uuidv4();
              this._pendingInits[pubkeyB64] = newConnectionId;
              await this.unzoomStore.client.sendInitRequest({
                connection_id: newConnectionId,
                to_agent: signal.from_agent,
              });
            }
          }
          // Create screen share connection if necessary
          if (
            this._screenShareStream &&
            !Object.keys(this._screenShareConnections).includes(pubkeyB64) &&
            !Object.keys(this._pendingScreenShareInits).includes(pubkeyB64)
          ) {
            console.log('#### SENDING SCREEN SHARE INIT REQUEST.');
            const newConnectionId = uuidv4();
            this._pendingScreenShareInits[pubkeyB64] = newConnectionId;
            await this.unzoomStore.client.sendInitRequest({
              connection_type: 'screen',
              connection_id: newConnectionId,
              to_agent: signal.from_agent,
            });
          }
          break;
        }
        case 'SdpData': {
          console.log('## Got SDP Data: ', signal.data);
          // For normal connections:
          const responsibleConnection =
            this._openConnections[encodeHashToBase64(signal.from_agent)];
          // console.log('responsibleConnection: ', responsibleConnection);
          // verify connection id
          if (
            responsibleConnection &&
            responsibleConnection.connectionId === signal.connection_id
          ) {
            // console.log(
            //   '#### GOT SDP DATA for connectionId ',
            //   responsibleConnection.connectionId
            // );
            responsibleConnection.peer.signal(JSON.parse(signal.data));
          }
          // For screen sharing connections:
          const responsibleScreenShareConnection =
            this._screenShareConnections[encodeHashToBase64(signal.from_agent)];
          // console.log('responsibleConnection: ', responsibleConnection);
          // console.log(
          //   '### GOT SDP DATA. responsible screen share connection: ',
          //   responsibleScreenShareConnection
          // );
          // verify connection id
          if (
            responsibleScreenShareConnection &&
            responsibleScreenShareConnection.connectionId ===
              signal.connection_id
          ) {
            // console.log(
            //   '#### GOT SDP DATA for SCREEN SHARE connectionId ',
            //   responsibleScreenShareConnection.connectionId
            // );
            responsibleScreenShareConnection.peer.signal(
              JSON.parse(signal.data)
            );
          }
          break;
        }
        case 'InitRequest': {
          console.log(
            `#### GOT ${
              signal.connection_type === 'screen' ? 'SCREEN SHARE ' : ''
            }INIT REQUEST.`
          );
          // Only accept init requests from agents who's pubkey is alphabetically "higher" than ours
          if (
            signal.connection_type !== 'screen' &&
            encodeHashToBase64(signal.from_agent) >
              encodeHashToBase64(this.unzoomStore.client.client.myPubKey)
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
            const openConnections = this._openConnections;
            openConnections[encodeHashToBase64(signal.from_agent)] = {
              connectionId: signal.connection_id,
              peer: newPeer,
              video: false,
              audio: false,
              connected: false,
              direction: 'duplex',
            };
            this._openConnections = openConnections;
            this.requestUpdate();
            await this.unzoomStore.client.sendInitAccept({
              connection_id: signal.connection_id,
              to_agent: signal.from_agent,
            });
          }
          if (signal.connection_type === 'screen') {
            const newPeer = this.createScreenSharePeer(
              signal.from_agent,
              signal.connection_id,
              false
            );
            const screenShareConnections = this._screenShareConnections;
            screenShareConnections[encodeHashToBase64(signal.from_agent)] = {
              connectionId: signal.connection_id,
              peer: newPeer,
              video: true,
              audio: false,
              connected: false,
              direction: 'incoming', // if we did not initiate the request, we're not the one's delivering the stream
            };
            this._screenShareConnections = screenShareConnections;
            console.log('Added new screen share peer: ', newPeer);
            this.requestUpdate();
            await this.unzoomStore.client.sendInitAccept({
              connection_id: signal.connection_id,
              to_agent: signal.from_agent,
            });
          }
          break;
        }
        case 'InitAccept': {
          const pubKey64 = encodeHashToBase64(signal.from_agent);
          // for normal connections
          if (
            !Object.keys(this._openConnections).includes(pubKey64) &&
            this._pendingInits[pubKey64] === signal.connection_id
          ) {
            console.log('#### RECEIVED INIT ACCEPT AND INITIATING PEER.');
            const newPeer = this.createPeer(
              signal.from_agent,
              signal.connection_id,
              true
            );

            const openConnections = this._openConnections;
            openConnections[encodeHashToBase64(signal.from_agent)] = {
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

            this.requestUpdate();
          }
          // for screen share connections
          if (
            !Object.keys(this._screenShareConnections).includes(pubKey64) &&
            this._pendingScreenShareInits[pubKey64] === signal.connection_id
          ) {
            console.log(
              '#### RECEIVED INIT ACCEPT FOR SCREEN SHARING AND INITIATING PEER.'
            );
            const newPeer = this.createScreenSharePeer(
              signal.from_agent,
              signal.connection_id,
              true
            );

            const screenShareConnections = this._screenShareConnections;
            screenShareConnections[encodeHashToBase64(signal.from_agent)] = {
              connectionId: signal.connection_id,
              peer: newPeer,
              video: true,
              audio: false,
              connected: false,
              direction: 'outgoing', // if we initiated the request, we're the one's delivering the stream
            };
            this._screenShareConnections = screenShareConnections;

            const pendingScreenShareInits = this._pendingScreenShareInits;
            delete pendingScreenShareInits[pubKey64];
            this._pendingScreenShareInits = pendingScreenShareInits;

            this.requestUpdate();

            // console.log(
            //   '@InitAccept: open screen share connections: ',
            //   this._screenShareConnections
            // );
          }
          break;
        }

        default:
          break;
      }
    });
    // ping all agents that are not already connected to you every 3 seconds
    await this.pingAgents();
    this.pingInterval = window.setInterval(async () => {
      await this.pingAgents();
    }, 2000);
  }

  async pingAgents() {
    if (this._allAgents.value.status === 'complete') {
      await this.unzoomStore.client.pingFrontend(this._allAgents.value.value);
    }
  }

  disconnectedCallback(): void {
    if (this.pingInterval) window.clearInterval(this.pingInterval);
    if (this._unsubscribe) this._unsubscribe();
  }

  idToLayout(id: string) {
    if (id === this._maximizedVideo) return 'maximized';
    if (this._maximizedVideo) return 'hidden';
    const screenShareNum =
      Object.keys(this._screenShareConnections).length > 0
        ? Object.keys(this._screenShareConnections).length
        : this._screenShareStream
        ? 1
        : 0;
    const num = Object.keys(this._openConnections).length + screenShareNum + 1;

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

  render() {
    return html`
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
      <div
        class="error-message"
        style="${this._displayError ? '' : 'display: none;'}"
      >
        ${this._displayError}
      </div>
      <div class="videos-container">
        <!-- My own screen first if screen sharing is enabled -->
        <div
          style="${this._screenShareStream ? '' : 'display: none;'}"
          class="video-container screen-share ${this.idToLayout(
            'my-own-screen'
          )}"
        >
          <video muted id="my-own-screen" class="video-el"></video>
          <div
            style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
          >
            <avatar-with-nickname
              .size=${36}
              .agentPubKey=${this.unzoomStore.client.client.myPubKey}
              style="height: 36px;"
            ></avatar-with-nickname>
          </div>
          <sl-icon
            .src=${this._maximizedVideo === 'my-own-screen'
              ? wrapPathInSvg(mdiFullscreenExit)
              : wrapPathInSvg(mdiFullscreen)}
            tabindex="0"
            class="maximize-icon"
            @click=${() => {
              if (this._maximizedVideo !== 'my-own-screen') {
                this._maximizedVideo = 'my-own-screen';
              } else {
                this._maximizedVideo = undefined;
              }
            }}
            @keypress=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                if (this._maximizedVideo !== 'my-own-screen') {
                  this._maximizedVideo = 'my-own-screen';
                } else {
                  this._maximizedVideo = undefined;
                }
              }
            }}
          ></sl-icon>
        </div>
        <!--Then other agents' screens -->

        ${Object.entries(this._screenShareConnections)
          .filter(([_, conn]) => conn.direction === 'incoming')
          .map(
            ([pubkeyB64, conn]) => html`
              <div
                class="video-container screen-share ${this.idToLayout(
                  conn.connectionId
                )}"
              >
                <video
                  style="${conn.connected ? '' : 'display: none;'}"
                  id="${conn.connectionId}"
                  class="video-el"
                ></video>
                <div
                  style="color: #b98484; ${conn.connected
                    ? 'display: none'
                    : ''}"
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
                  .src=${this._maximizedVideo === conn.connectionId
                    ? wrapPathInSvg(mdiFullscreenExit)
                    : wrapPathInSvg(mdiFullscreen)}
                  tabindex="0"
                  class="maximize-icon"
                  @click=${() => {
                    if (this._maximizedVideo !== conn.connectionId) {
                      this._maximizedVideo = conn.connectionId;
                    } else {
                      this._maximizedVideo = undefined;
                    }
                  }}
                  @keypress=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                      if (this._maximizedVideo !== conn.connectionId) {
                        this._maximizedVideo = conn.connectionId;
                      } else {
                        this._maximizedVideo = undefined;
                      }
                    }
                  }}
                ></sl-icon>
              </div>
            `
          )}

        <!-- My own video stream -->
        <div class="video-container ${this.idToLayout('my-own-stream')}">
          <video
            muted
            style="${this._camera ? '' : 'display: none;'}"
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
              .agentPubKey=${this.unzoomStore.client.client.myPubKey}
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
        ${Object.entries(this._openConnections).map(
          ([pubkeyB64, conn]) => html`
            <div class="video-container ${this.idToLayout(conn.connectionId)}">
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
    `;
  }

  static styles = [
    sharedStyles,
    css`
      main {
        flex-grow: 1;
        margin: 0;
        background: #383b4d;
      }

      .stop-share {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        padding: 4px 10px;
        position: absolute;
        top: 10px;
        right: 10px;
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

      .stop-share:focus {
        background: #fd5959;
      }

      .error-message {
        position: fixed;
        bottom: 10px;
        left: 10px;
        padding: 5px 10px;
        border-radius: 10px;
        color: white;
        background: #b60606;
        box-shadow: 0 0 2px white;
        font-family: sans-serif;
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
        color: #facece;
        height: 40px;
        width: 40px;
        cursor: pointer;
      }

      .maximize-icon:hover {
        color: white;
      }

      .maximize-icon:focus {
        color: white;
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
        color: #668fc2;
      }

      .toggle-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #347fe1;
        margin: 0 5px;
        border-radius: 50%;
        height: 60px;
        width: 60px;
        cursor: pointer;
      }

      .btn-off {
        background: #40638f;
      }

      .toggle-btn:hover {
        background: #347fe1;
      }

      .toggle-btn:hover:not(.btn-off) {
        background: #40638f;
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
        width: 300px;
        height: 74px;
        border-radius: 37px;
        background: #102a4d;
        color: #facece;
        /* left: calc(50% - 150px); */
      }
    `,
  ];
}
