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
  mdiStop,
  mdiVideo,
  mdiVideoOff,
} from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';
import { localized, msg } from '@lit/localize';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';

import '@holochain-open-dev/elements/dist/elements/holo-identicon.js';

import { UnzoomStore } from './unzoom-store';
import { UnzoomSignal } from './unzoom/unzoom/types';

type ConnectionId = string;
@localized()
@customElement('main-view')
export class MainView extends LitElement {
  @property({ type: Object })
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
  _initiatingPeer: SimplePeer.Instance | undefined;

  @state()
  _acceptingPeer: SimplePeer.Instance | undefined;

  createPeer(
    connectingAgent: AgentPubKey,
    connectionId: string,
    options: SimplePeer.Options
  ): SimplePeer.Instance {
    const peer = new SimplePeer(options);
    peer.on('signal', async data => {
      this.unzoomStore.client.sendSdpData({
        to_agent: connectingAgent,
        connection_id: connectionId,
        data: JSON.stringify(data),
      });
    });
    peer.on('data', data =>
      console.log('Got a message from the other peer: ', data)
    );
    peer.on('stream', stream => {
      console.log('#### GOT STREAM');
      console.log('Open connections: ', this._openConnections);
      const videoEl = this.shadowRoot?.getElementById(connectionId) as
        | HTMLVideoElement
        | undefined;
      console.log('Got videoEl: ', videoEl);
      if (videoEl) {
        videoEl.srcObject = stream;
        videoEl.play();
      }
    });
    peer.on('connect', () =>
      peer.send(
        `Hello from ${options.initiator ? 'initiating' : 'accepting'} peer.`
      )
    );
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
    } else {
      try {
        this._audioStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        this._microphone = true;
      } catch (e: any) {
        console.error(`Failed to get media devices: ${e.toString()}`);
      }
      Object.values(this._openConnections).forEach(conn => {
        if (this._audioStream) {
          console.log('Adding media stream to connection ', conn.connectionId);
          conn.peer.addStream(this._audioStream);
        }
      });
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
  }

  async firstUpdated() {
    this.unzoomStore.client.onSignal(async signal => {
      switch (signal.type) {
        case 'Pong': {
          const pubkeyB64 = encodeHashToBase64(signal.from_agent);
          console.log('Got PONG from ', pubkeyB64);
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
          // verify connection id
          if (responsibleConnection.connectionId === signal.connection_id) {
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
              { initiator: false }
            );
            const openConnections = this._openConnections;
            openConnections[encodeHashToBase64(signal.from_agent)] = {
              connectionId: signal.connection_id,
              peer: newPeer,
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
              { initiator: true }
            );
            const openConnections = this._openConnections;
            openConnections[encodeHashToBase64(signal.from_agent)] = {
              connectionId: signal.connection_id,
              peer: newPeer,
            };
            this._openConnections = openConnections;
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
    }, 3000);
  }

  async pingAgents() {
    console.log('SENDING PINGS');
    if (this._allAgents.value.status === 'complete') {
      await this.unzoomStore.client.ping(
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
          <div class="btn-stop">
            <div class="stop-icon"></div>
          </div>
        </sl-tooltip>
      </div>
    `;
  }

  render() {
    return html`
      <div
        class="videos-container"
      >
        <div class="video-container double">
          <video style="${this._camera ? '' : 'display: none;'}" id="my-own-stream" class="video-el">hello</video>
          <sl-icon
              style="color: #b98484; height: 30%; width: 30%;${this._camera
                ? 'display: none;'
                : ''}"
              .src=${wrapPathInSvg(mdiVideoOff)}
          ></sl-icon>
          <div style="display: flex; flex-direction: row; align-items: center; position: absolute; bottom: 5px; right: 15px; background: none;">
            <holo-identicon
              .size=${36}
              hash=${encodeHashToBase64(this.unzoomStore.client.client.myPubKey)}
            ></holo-identicon>
            <span style="margin-left: 10px; font-size: 23px; color: #b98484;">nickname</span>
          </div>
          <!-- <div class="video-placeholder">Other content</div> -->
        </div>
        <div class="video-container double">
          <video id="my-own-stream2" class="video-el">This is content</video>

          <!-- <div class="video-placeholder">Other content</div> -->
        </div>
        ${Object.entries(this._openConnections).map(
          ([_pubkeyB64, conn]) => html`
            <div class="video-container double">
              <video id="${conn.connectionId}" class="video-container"></video>
            </div>
          `
        )}
      </div>
      ${this.renderToggles()}
    `;
  }

  static styles = css`
    main {
      flex-grow: 1;
      margin: 0;
    }

    .videos-container {
      display: flex;
      flex: 1;
      flex-direction: row;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      width: 100vw;
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
      max-height: 100%;
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
      /* left: calc(50% - 150px); */
    }
  `;
}

function numToLayout(num: number) {
  if (num === 1) {
    return 'single';
  }
  if (num <= 2) {
    return "double";
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
