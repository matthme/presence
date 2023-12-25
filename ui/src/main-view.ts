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

import { UnzoomStore } from './unzoom-store';
import {
  UnzoomSignal,
} from './unzoom/unzoom/types';

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
  _onlineAgents: AgentPubKeyB64[] = [];

  @state()
  _openConnections: Record<AgentPubKeyB64, {
    connectionId: string,
    peer: SimplePeer.Instance,
  }> = {};

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
    peer.on('data', data => console.log("Got a message from the other peer: ", data));
    peer.on('connect', () =>
      peer.send(
        `Hello from ${options.initiator ? 'initiating' : 'accepting'} peer.`
      )
    );
    return peer;
  }

  async firstUpdated() {
    this.unzoomStore.client.onSignal(async signal => {
      switch (signal.type) {
        case 'Pong': {
          const pubkeyB64 = encodeHashToBase64(signal.from_agent);
          console.log('Got PONG from ', pubkeyB64);
          if (!Object.keys(this._openConnections).includes(pubkeyB64) && !Object.keys(this._pendingInits).includes(pubkeyB64)) {
            // Only initialize connections with agents who's public key is alphabetically lower than ours
            if (pubkeyB64 < encodeHashToBase64(this.unzoomStore.client.client.myPubKey)) {
              console.log("SENDING INIT REQUEST.");
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
          const responsibleConnection = this._openConnections[encodeHashToBase64(signal.from_agent)];
          // verify connection id
          if (responsibleConnection.connectionId === signal.connection_id) {
            console.log("GOT SDP DATA for connectionId ", responsibleConnection.connectionId);
            responsibleConnection.peer.signal(JSON.parse(signal.data));
          }
          break;
        }
        case "InitRequest": {
          // Only accept init requests from agents who's pubkey is alphabetically "higher" than ours
          if (encodeHashToBase64(signal.from_agent) > encodeHashToBase64(this.unzoomStore.client.client.myPubKey)) {
            console.log("SENDING INIT ACCEPT.");
            const newPeer = this.createPeer(signal.from_agent, signal.connection_id, { initiator: false });
            this._openConnections[encodeHashToBase64(signal.from_agent)] = {
              connectionId: signal.connection_id,
              peer: newPeer,
            };
            await this.unzoomStore.client.sendInitAccept({
              connection_id: signal.connection_id,
              to_agent: signal.from_agent,
            })
          }
          break;
        }
        case "InitAccept": {
          const pubKey64 = encodeHashToBase64(signal.from_agent);
          if (!Object.keys(this._openConnections).includes(pubKey64) && this._pendingInits[pubKey64] === signal.connection_id) {
            console.log("RECEIVED INIT ACCEPT AND INITIATING PEER.");
            const newPeer = this.createPeer(signal.from_agent, signal.connection_id, { initiator: true });
            this._openConnections[encodeHashToBase64(signal.from_agent)] = {
              connectionId: signal.connection_id,
              peer: newPeer,
            };
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

  render() {
    switch (this._allAgents.value.status) {
      case 'error':
        return html`ERROR: ${this._allAgents.value.error}`;
      case 'pending':
        return html`Searching other agents...`;
      case 'complete':
        return html`
          <div>
            Found agents:
            ${this._allAgents.value.value.map(hash => encodeHashToBase64(hash))}
          </div>
          <div>
            My pubkey:
            ${encodeHashToBase64(this.unzoomStore.client.client.myPubKey)}
          </div>`;
      default:
        return html`Invalid store status.`;
    }
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

    .app-footer {
      font-size: calc(12px + 0.5vmin);
      align-items: center;
    }

    .app-footer a {
      margin-left: 5px;
    }
  `;
}
