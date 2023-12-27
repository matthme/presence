import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { AgentPubKey } from '@holochain/client';
import { consume } from '@lit/context';
import { StoreSubscriber } from '@holochain-open-dev/stores';
import { localized, msg } from '@lit/localize';

import '@holochain-open-dev/elements/dist/elements/display-error.js';

import {
  ProfilesStore,
  profilesStoreContext,
  Profile,
} from '@holochain-open-dev/profiles';
import { EntryRecord } from '@holochain-open-dev/utils';
import { sharedStyles } from './sharedStyles.js';

import './agent-avatar.js';

/**
 * @element list-profiles
 * @fires agent-selected - Fired when the user selects an agent from the list. Detail will have this shape: { agentPubKey: <AGENT_PUB_KEY as Uint8Array> }
 */
@localized()
@customElement('list-online-agents')
export class ListOnlineAgents extends LitElement {
  /**
   * Profiles store for this element, not required if you embed this element inside a <profiles-context>
   */
  @consume({ context: profilesStoreContext, subscribe: true })
  @property()
  store!: ProfilesStore;

  @property()
  agents!: AgentPubKey[];

  @property()
  avatarSize: number | undefined;

  /** Private properties */

  /**
   * @internal
   */
  private _onlineAgents = new StoreSubscriber(
    this,
    () => this.store.agentsProfiles(this.agents),
    () => [this.store]
  );

  initials(nickname: string): string {
    return nickname
      .split(' ')
      .map(name => name[0])
      .join('');
  }

  renderList(
    profiles: ReadonlyMap<AgentPubKey, EntryRecord<Profile> | undefined>
  ) {
    return html`
      <div class="row" style="align-items: center;">
        ${Array.from(profiles.entries()).map(
          ([agent_pub_key, maybeProfile]) => {
            if (maybeProfile) {
              return html`
                <agent-avatar
                  .size=${this.avatarSize ? this.avatarSize : 40}
                  .disableTooltip=${true}
                  title="${maybeProfile.entry.nickname}"
                  .agentPubKey=${agent_pub_key}
                  style="height: ${this.avatarSize ? this.avatarSize : '40'}px; margin-right: 5px;"
                >
                </agent-avatar>
              `;
            }
            return html`
              <div
                class="column"
                style="${this.avatarSize
                  ? `height: ${this.avatarSize}; width: ${this.avatarSize}`
                  : 'height: 40px; width: 40px;'}
                  background: gray;
                  align-items: center;
                  justify-content: center
                "
              >
                ?
              </div>
            `;
          }
        )}
      </div>
    `;
  }

  render() {
    switch (this._onlineAgents.value.status) {
      case 'pending':
        return html``;
      case 'error':
        console.error(
          `Failed to fetch profiles: ${JSON.stringify(
            this._onlineAgents.value.error
          )}`
        );
        return html``;
      case 'complete':
        return this.renderList(this._onlineAgents.value.value);
      default:
        return html``;
    }
  }

  static styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
      }
    `,
  ];
}
