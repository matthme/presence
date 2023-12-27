import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  encodeHashToBase64,
  AgentPubKeyB64,
  AgentPubKey,
} from '@holochain/client';
import { StoreSubscriber } from '@holochain-open-dev/stores';
import * as SimplePeer from 'simple-peer';
import { v4 as uuidv4 } from 'uuid';
import {
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiVideo,
  mdiVideoOff,
} from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { localized, msg } from '@lit/localize';
import { consume } from '@lit-labs/context';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';

import '@holochain-open-dev/elements/dist/elements/holo-identicon.js';

import { UnzoomStore } from './unzoom-store';
import { UnzoomSignal } from './unzoom/unzoom/types';
import { unzoomStoreContext } from './contexts';
import { sharedStyles } from './sharedStyles';

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

@localized()
@customElement('room-view')
export class RoomView extends LitElement {
  @consume({ context: unzoomStoreContext, subscribe: true })
  @state()
  unzoomStore!: UnzoomStore;

  @state()
  pingInterval: number | undefined;

  _allAgents = new StoreSubscriber(
    this,
    () => this.unzoomStore.allAgents,
    () => [this.unzoomStore]
  );

  @state()
  _audioStream: MediaStream | undefined | null;

  @state()
  _videoStream: MediaStream | undefined | null;

  @state()
  _onlineAgents: AgentPubKeyB64[] = [];

  @state()
  _openConnections: Record<
    AgentPubKeyB64,
    {
      connectionId: string;
      peer: SimplePeer.Instance;
      video: boolean;
      audio: boolean;
    }
  > = {};

  @state()
  _microphone = false;

  @state()
  _camera = false;

  @state()
  _hoverCamera = false;

  @state()
  _hoverMicrophone = false;

  @state()
  _pendingInits: Record<AgentPubKeyB64, ConnectionId> = {};

  @state()
  _offer: UnzoomSignal | undefined;

  @state()
  _response: UnzoomSignal | undefined;

  @state()
  _unsubscribe: (() => void) | undefined;

  createPeer(
    connectingAgent: AgentPubKey,
    connectionId: string,
    initiator: boolean
  ): SimplePeer.Instance {
    const options: SimplePeer.Options = {
      initiator,
      config: { iceServers: [{ urls: 'stun:turn.holo.host' }] },
      objectMode: true,
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
      console.log('@@@@ Got a message from the other peer: ', data);
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
      console.log('#### GOT STREAM');
      console.log('Open connections: ', this._openConnections);
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
      }
      const videoEl = this.shadowRoot?.getElementById(connectionId) as
        | HTMLVideoElement
        | undefined;
      console.log('Got videoEl: ', videoEl);
      if (videoEl) {
        videoEl.srcObject = stream;
        videoEl.play();
      }
      this.requestUpdate();
    });
    peer.on('connect', () => {
      const pendingInits = this._pendingInits;
      delete pendingInits[encodeHashToBase64(connectingAgent)];
      this._pendingInits = pendingInits;
      peer.send(
        JSON.stringify({
          type: 'text',
          message: `Hello from ${
            options.initiator ? 'initiating' : 'accepting'
          } peer.`,
        })
      );
      this.requestUpdate();
    }
    );
    peer.on('close', () => {
      console.log('#### GOT CLOSE EVENT ####');

      peer.destroy();

      const openConnections = this._openConnections;
      delete openConnections[encodeHashToBase64(connectingAgent)];
      this._openConnections = openConnections;

      console.log("@CLOSE: this._pendingInits: ", this._pendingInits);

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

  async videoOn() {
    if (this._videoStream) {
      this._videoStream.getVideoTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = true;
      });
      this._camera = true;
    } else {
      try {
        this._videoStream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        const myVideo = this.shadowRoot?.getElementById(
          'my-own-stream'
        ) as HTMLVideoElement;
        myVideo.srcObject = this._videoStream;
        this._camera = true;
        await myVideo.play();
      } catch (e: any) {
        console.error(`Failed to get media devices: ${e.toString()}`);
      }
      Object.values(this._openConnections).forEach(conn => {
        if (this._videoStream) {
          console.log('Adding media stream to connection ', conn.connectionId);
          conn.peer.addStream(this._videoStream);
        }
      });
    }
  }

  async videoOff() {
    if (this._videoStream) {
      this._videoStream.getVideoTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.stop();
      });
      Object.values(this._openConnections).forEach(conn => {
        if (this._videoStream) {
          console.log('Adding media stream to connection ', conn.connectionId);
          conn.peer.removeStream(this._videoStream);
        }
        const msg: RTCMessage = {
          type: 'action',
          message: 'video-off',
        };
        conn.peer.send(JSON.stringify(msg));
      });
      this._camera = false;
      this._videoStream = null;
    }
  }

  async audioOn() {
    if (this._audioStream) {
      this._audioStream.getAudioTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = true;
      });
      this._microphone = true;
      Object.values(this._openConnections).forEach(conn => {
        if (this._videoStream) {
          console.log('Adding media stream to connection ', conn.connectionId);
          conn.peer.removeStream(this._videoStream);
        }
        const msg: RTCMessage = {
          type: 'action',
          message: 'audio-on',
        };
        conn.peer.send(JSON.stringify(msg));
      });
    } else {
      try {
        this._audioStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        this._microphone = true;
        Object.values(this._openConnections).forEach(conn => {
          if (this._audioStream) {
            console.log('Adding media stream to connection ', conn.connectionId);
            conn.peer.addStream(this._audioStream);
          }
          const msg: RTCMessage = {
            type: 'action',
            message: 'audio-on',
          };
          conn.peer.send(JSON.stringify(msg));
        });
      } catch (e: any) {
        console.error(`Failed to get media devices: ${e.toString()}`);
      }
    }
  }

  async audioOff() {
    if (this._audioStream) {
      this._audioStream.getAudioTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = false;
      });
      this._microphone = false;
    }
    Object.values(this._openConnections).forEach(conn => {
      const msg: RTCMessage = {
        type: 'action',
        message: 'audio-off',
      };
      conn.peer.send(JSON.stringify(msg));
    });
  }

  quitRoom() {
    Object.values(this._openConnections).forEach(conn => {
      conn.peer.destroy();
    });
    this.videoOff();
    this.audioOff();
    this._videoStream = null;
    this._audioStream = null;
    this._openConnections = {};
    this.dispatchEvent(
      new CustomEvent('quit-room', { bubbles: true, composed: true })
    );
  }

  async firstUpdated() {
    console.log('Got unzoomStore: ', this.unzoomStore);
    this._unsubscribe = this.unzoomStore.client.onSignal(async signal => {
      switch (signal.type) {
        case 'PingUi': {
          await this.unzoomStore.client.pongFrontend(signal.from_agent);
          break;
        }
        case 'PongUi': {
          const pubkeyB64 = encodeHashToBase64(signal.from_agent);
          console.log('Got UI PONG from ', pubkeyB64);
          console.log("@PONG: this._pendingInits: ", this._pendingInits);
          console.log("@PONG: this._openConnections: ", this._openConnections);
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
          break;
        }
        case 'SdpData': {
          const responsibleConnection =
            this._openConnections[encodeHashToBase64(signal.from_agent)];
          console.log('responsibleConnection: ', responsibleConnection);
          // verify connection id
          if (
            responsibleConnection &&
            responsibleConnection.connectionId === signal.connection_id
          ) {
            console.log(
              '#### GOT SDP DATA for connectionId ',
              responsibleConnection.connectionId
            );
            responsibleConnection.peer.signal(JSON.parse(signal.data));
          }
          break;
        }
        case 'InitRequest': {
          console.log('#### GOT INIT REQUEST.');
          // Only accept init requests from agents who's pubkey is alphabetically "higher" than ours
          if (
            encodeHashToBase64(signal.from_agent) >
            encodeHashToBase64(this.unzoomStore.client.client.myPubKey)
          ) {
            console.log('#### SENDING INIT ACCEPT.');
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
            };
            this._openConnections = openConnections;
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
            };
            this._openConnections = openConnections;

            const pendingInits = this._pendingInits;
            delete pendingInits[pubKey64];
            this._pendingInits = pendingInits;

            this.requestUpdate();

            console.log(
              '@InitAccept: open connections: ',
              this._openConnections
            );
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
    console.log('SENDING PINGS');
    if (this._allAgents.value.status === 'complete') {
      await this.unzoomStore.client.pingFrontend(
        this._allAgents.value.value.filter(
          pubkey =>
            !Object.keys(this._openConnections).includes(
              encodeHashToBase64(pubkey)
            )
        )
      );
    }
  }

  disconnectedCallback(): void {
    if (this.pingInterval) window.clearInterval(this.pingInterval);
    if (this._unsubscribe) this._unsubscribe();
  }

  renderToggles() {
    return html`
      <div class="toggles-panel">
        <sl-tooltip
          content="${this._camera ? msg('Voice Off') : msg('Voice On')}"
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
            @mouseout=${() => {
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
            @mouseout=${() => {
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
      <div class="videos-container">
        <div
          class="video-container ${numToLayout(
            Object.keys(this._openConnections).length + 1
          )}"
        >
          <video
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
            <holo-identicon
              .size=${36}
              style="height: 36px;"
              hash=${encodeHashToBase64(
                this.unzoomStore.client.client.myPubKey
              )}
            ></holo-identicon>
            <span style="margin-left: 10px; font-size: 23px; color: #cd9f9f;"
              >nickname</span
            >
          </div>
          <sl-icon
            style="position: absolute; bottom: 10px; left: 10px; color: red; height: 30px; width: 30px; ${this._microphone ? 'display: none' : ''}"
            .src=${wrapPathInSvg(mdiMicrophoneOff)}
          ></sl-icon>
          <!-- <div class="video-placeholder">Other content</div> -->
        </div>
        ${Object.entries(this._openConnections).map(
          ([_pubkeyB64, conn]) => html`
            <div
              class="video-container ${numToLayout(
                Object.keys(this._openConnections).length + 1
              )}"
            >
              <video
                style="${conn.video ? '' : 'display: none;'}"
                id="${conn.connectionId}"
                class="video-el"
              ></video>
              <sl-icon
                style="color: #b98484; height: 30%; width: 30%;${conn.video
                  ? 'display: none;'
                  : ''}"
                .src=${wrapPathInSvg(mdiVideoOff)}
              ></sl-icon>
              <div
                style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 10px; right: 10px; background: none;"
              >
                <holo-identicon
                  .size=${36}
                  style="height: 36px;"
                  hash=${encodeHashToBase64(
                    this.unzoomStore.client.client.myPubKey
                  )}
                ></holo-identicon>
                <span
                  style="margin-left: 10px; font-size: 23px; color: #cd9f9f;"
                  >not me</span
                >
              </div>
            <sl-icon
              style="position: absolute; bottom: 10px; left: 10px; color: red; height: 30px; width: 30px; ${conn.audio ? 'display: none' : ''}"
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
        flex: 1;
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

      .video-el {
        height: 100%;
        max-width: 100%;
      }

      .identicon canvas {
        width: 180px;
        height: 180px;
      }

      .single {
        height: min(100vh, 100%);
        width: min(100vw, 100%);
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
        width: 215px;
        height: 74px;
        border-radius: 37px;
        background: #102a4d;
        color: #facece;
        /* left: calc(50% - 150px); */
      }
    `,
  ];
}

function numToLayout(num: number) {
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
