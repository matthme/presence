import { consume } from "@lit/context";
import {
  hashProperty,
  sharedStyles,
} from "@holochain-open-dev/elements";
import { css, html, LitElement } from "lit";
import { property, customElement } from "lit/decorators.js";
import { AgentPubKey, encodeHashToBase64 } from "@holochain/client";
import { localized, msg } from "@lit/localize";
import { StoreSubscriber } from "@holochain-open-dev/stores";

import "@holochain-open-dev/elements/dist/elements/display-error.js";
import "@holochain-open-dev/elements/dist/elements/holo-identicon.js";
import "@shoelace-style/shoelace/dist/components/avatar/avatar.js";
import "@shoelace-style/shoelace/dist/components/skeleton/skeleton.js";
import "@shoelace-style/shoelace/dist/components/tooltip/tooltip.js";

import { profilesStoreContext, ProfilesStore, Profile } from "@holochain-open-dev/profiles";
import { EntryRecord } from "@holochain-open-dev/utils";

@localized()
@customElement("avatar-with-nickname")
export class AvatarWithNickname extends LitElement {
  /** Public properties */

  /**
   * REQUIRED. The public key identifying the agent whose profile is going to be shown.
   */
  @property(hashProperty("agent-pub-key"))
  agentPubKey!: AgentPubKey;

  /**
   * Size of the avatar image in pixels.
   */
  @property({ type: Number })
  size = 40;

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

  renderIdenticon() {
    return html`
      <holo-identicon
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

  renderProfile(profile: EntryRecord<Profile> | undefined) {
    if (!profile || !profile.entry.fields.avatar) return this.renderIdenticon();
    console.log("Got nickname: ", profile.entry);

    return html`
      <div class="row" style="align-items: center; margin: 0; padding: 0;">
        <img
          style="height: ${this.size}px; width: ${this.size}px; border-radius: 50%;"
          src=${profile.entry.fields.avatar}
          alt="${profile.entry.nickname}'s avatar"
        />
        <span style="margin-left: 10px; font-size: 23px; color: #cd9f9f;">${profile.entry.nickname}</span>
      </div>
    `;
  }

  render() {
    if (this.store.config.avatarMode === "identicon")
      return this.renderIdenticon();
    switch (this._agentProfile.value.status) {
      case "pending":
        return html`<sl-skeleton
          effect="pulse"
          style="height: ${this.size}px; width: ${this.size}px"
        ></sl-skeleton>`;
      case "complete":
        return this.renderProfile(this._agentProfile.value.value);
      case "error":
        return html`
          <display-error
            tooltip
            .headline=${msg("Error fetching the agent's avatar")}
            .error=${this._agentProfile.value.error}
          ></display-error>
        `;
      default:
        return html``
    }
  }

  static styles = [
    sharedStyles,
    css``,
  ];
}
