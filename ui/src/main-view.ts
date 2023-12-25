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
import { mdiMicrophone, mdiMicrophoneOff, mdiVideo, mdiVideoOff } from '@mdi/js';
import { wrapPathInSvg } from '@holochain-open-dev/elements';

import '@shoelace-style/shoelace/dist/components/icon/icon.js';

import { UnzoomStore } from './unzoom-store';
import { UnzoomSignal } from './unzoom/unzoom/types';

type ConnectionId = string;
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
  _mediaStream: MediaStream | undefined | null;

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

  async streamOn() {
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = true;
      });
    } else {
      try {
        this._mediaStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        const myVideo = this.shadowRoot?.getElementById(
          'my-own-stream'
        ) as HTMLVideoElement;
        myVideo.srcObject = this._mediaStream;
        await myVideo.play();
      } catch (e: any) {
        console.error(`Failed to get media devices: ${e.toString()}`);
      }
      Object.values(this._openConnections).forEach(conn => {
        if (this._mediaStream) {
          console.log('Adding media stream to connection ', conn.connectionId);
          conn.peer.addStream(this._mediaStream);
        }
      });
    }
  }

  async streamOff() {
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(track => {
        // eslint-disable-next-line no-param-reassign
        track.enabled = false;
      });
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
        <div class="toggle-btn ${this._microphone ? '' : 'btn-off'}"
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
            class="toggle-btn-icon ${(this._hoverMicrophone && !this._microphone) || (this._microphone) ? '' : 'btn-icon-off'}"
            .src=${(this._hoverMicrophone && !this._microphone) || (this._microphone) ? wrapPathInSvg(mdiMicrophone) : wrapPathInSvg(mdiMicrophoneOff)}
          ></sl-icon>
        </div>
        <div
          class="toggle-btn ${this._camera ? '' : 'btn-off'}"
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
            class="toggle-btn-icon ${(this._hoverCamera && !this._camera) || (this._camera) ? '' : 'btn-icon-off'}"
            .src=${(this._hoverCamera && !this._camera) || (this._camera) ? wrapPathInSvg(mdiVideo) : wrapPathInSvg(mdiVideoOff)}
          ></sl-icon>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div>Open connections: ${Object.keys(this._openConnections)}</div>
      <button @click=${() => this.streamOn()}>STREAM ON</button>
      <button @click=${() => this.streamOff()}>STREAM OFF</button>
      <div
        style="display: flex; flex-direction: row; align-items: center; flex-wrap: wrap;"
      >
        <video
          id="my-own-stream"
          style="border: 2px solid black; width: 300px; height: 230px; margin: 10px;"
        ></video>
        ${Object.entries(this._openConnections).map(
          ([_pubkeyB64, conn]) => html`
            <video
              id="${conn.connectionId}"
              style="border: 2px solid black; width: 300px; height: 230px; margin: 10px;"
            ></video>
          `
        )}
      </div>
      ${this.renderToggles()}
    `;
  }

  static styles = css`
    :host {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      font-size: calc(10px + 2vmin);
      color: #1a2b42;
      max-width: 960px;
      margin: 0 auto;
      text-align: center;
      background-color: var(--lit-element-background-color);
    }

    main {
      flex-grow: 1;
    }

    .toggle-btn-icon {
      height: 40px;
      width: 40px;
      color: #e7d9aa;
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
      bottom: 20px;
      width: 300px;
      height: 74px;
      border-radius: 37px;
      background: #102a4d;
      left: calc(50% - 150px);
    }

    .app-footer {
      font-size: calc(12px + 0.5vmin);
      align-items: center;
    }

    .app-footer a {
      margin-left: 5px;
    }
  `;
}
