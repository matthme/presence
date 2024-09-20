import { consume } from '@lit/context';
import { hashProperty, sharedStyles } from '@holochain-open-dev/elements';
import { css, html, LitElement, PropertyValueMap } from 'lit';
import { property, customElement } from 'lit/decorators.js';
import { AgentPubKey, encodeHashToBase64 } from '@holochain/client';
import { localized, msg } from '@lit/localize';
import { StoreSubscriber } from '@holochain-open-dev/stores';

import '@holochain-open-dev/elements/dist/elements/display-error.js';
import '@holochain-open-dev/elements/dist/elements/holo-identicon.js';
import '@shoelace-style/shoelace/dist/components/avatar/avatar.js';
import '@shoelace-style/shoelace/dist/components/skeleton/skeleton.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';

import {
  profilesStoreContext,
  ProfilesStore,
  Profile,
} from '@holochain-open-dev/profiles';
import { EntryRecord } from '@holochain-open-dev/utils';
import { ConnectionStatus } from './room-view';
import { connectionStatusToColor } from './utils';

@localized()
@customElement('agent-connection-status')
export class AgentConnectionStatus extends LitElement {
  /** Public properties */

  /**
   * REQUIRED. The public key identifying the agent whose profile is going to be shown.
   */
  @property(hashProperty('agent-pub-key'))
  agentPubKey!: AgentPubKey;

  /**
   * Size of the avatar image in pixels.
   */
  @property({ type: Number })
  size = 40;

  @property()
  connectionStatus: ConnectionStatus | undefined;

  /** Dependencies */

  /**
   * Profiles store for this element, not required if you embed this element inside a <profiles-context>
   */
  @consume({ context: profilesStoreContext, subscribe: true })
  @property()
  store!: ProfilesStore;

  /**
   * @internal
   */
  private _agentProfile = new StoreSubscriber(
    this,
    () => this.store.profiles.get(this.agentPubKey),
    () => [this.agentPubKey, this.store]
  );

  async willUpdate(
    changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ) {
    if (changedProperties.has('agentPubKey')) {
      this.requestUpdate();
    }
  }

  renderIdenticon() {
    return html` <holo-identicon
      .disableCopy=${true}
      .disableTooltip=${true}
      .hash=${this.agentPubKey}
      .size=${this.size}
      title="${encodeHashToBase64(this.agentPubKey)}"
    >
    </holo-identicon>`;
  }

  /**
   * @internal
   */
  timeout: any;

  statusToText(status?: ConnectionStatus) {
    if (!status) return 'disconnected';
    switch (status.type) {
      case 'Connected':
        return 'connected';
      case 'Disconnected':
        return 'disconnected';
      case 'AwaitingInit':
        return 'waiting for init request...';
      case 'InitSent':
        return `waiting for init accept${
          status.attemptCount && status.attemptCount > 1
            ? `(attempt #${status.attemptCount})`
            : ''
        }...`;
      case 'AcceptSent':
        return `waiting for SDP exchange${
          status.attemptCount && status.attemptCount > 1
            ? `(attempt #${status.attemptCount})`
            : ''
        }...`;
      case 'SdpExchange':
        return 'exchanging SDP data...';
      default:
        return 'unknown status type';
    }
  }

  renderProfile(profile: EntryRecord<Profile> | undefined) {
    return html`
      <div
        class="row"
        style="align-items: center; margin: 0; padding: 0; ${!this
          .connectionStatus || this.connectionStatus.type === 'Disconnected'
          ? 'opacity: 0.5'
          : ''}"
      >
        ${profile && profile.entry.fields.avatar
          ? html`
              <img
                style="height: ${this.size}px; width: ${this
                  .size}px; border-radius: 50%;"
                src=${profile.entry.fields.avatar}
                alt="${profile.entry.nickname}'s avatar"
              />
            `
          : html`
              <holo-identicon
                .disableCopy=${true}
                .disableTooltip=${true}
                .hash=${this.agentPubKey}
                .size=${this.size}
                title="${encodeHashToBase64(this.agentPubKey)}"
              >
              </holo-identicon>
            `}
        <div class="column" style="align-items: flex-start;">
          <span
            style="margin-left: 10px; margin-bottom: -12px; font-size: 23px; font-weight: 600; color: #c3c9eb;"
            >${profile ? profile.entry.nickname : 'Unknown'}</span
          >
          <span
            style="margin-left: 12px; font-size: 14px; color: ${connectionStatusToColor(this.connectionStatus, 'gray')}; font-weight: 600;"
            >${this.statusToText(this.connectionStatus)}</span
          >
        </div>
      </div>
    `;
  }

  render() {
    switch (this._agentProfile.value.status) {
      case 'pending':
        return html`<sl-skeleton
          effect="pulse"
          style="height: ${this.size}px; width: ${this.size}px"
        ></sl-skeleton>`;
      case 'complete':
        return this.renderProfile(this._agentProfile.value.value);
      case 'error':
        return html`
          <display-error
            tooltip
            .headline=${msg("Error fetching the agent's avatar")}
            .error=${this._agentProfile.value.error}
          ></display-error>
        `;
      default:
        return html``;
    }
  }

  static styles = [sharedStyles, css``];
}
