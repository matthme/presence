import { sharedStyles } from '@holochain-open-dev/elements';
import { css, html, LitElement } from 'lit';
import { property, customElement, state } from 'lit/decorators.js';
import { localized } from '@lit/localize';

import '@holochain-open-dev/elements/dist/elements/display-error.js';
import '@holochain-open-dev/elements/dist/elements/holo-identicon.js';
import '@shoelace-style/shoelace/dist/components/avatar/avatar.js';
import '@shoelace-style/shoelace/dist/components/skeleton/skeleton.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';

@localized()
@customElement('toggle-switch')
export class ToggleSwitch extends LitElement {
  /** Public properties */

  @property()
  toggleState = false;

  @property()
  height = 40;

  render() {
    return this.toggleState
      ? html`
          <img
            src="switch_off.svg"
            alt="switch off button icon"
            style="height: ${this.height}px; cursor: pointer;"
            tabindex="0"
            @click=${() => {
              this.dispatchEvent(
                new CustomEvent('toggle-off', {
                  composed: true,
                  bubbles: true,
                })
              );
            }}
            @keypress=${() => {
              this.dispatchEvent(
                new CustomEvent('toggle-off', {
                  composed: true,
                  bubbles: true,
                })
              );
            }}
          />
        `
      : html`
          <img
            src="switch_on.svg"
            alt="switch on button icon"
            style="height: ${this.height}px; cursor: pointer;"
            tabindex="0"
            @click=${() => {
              this.dispatchEvent(
                new CustomEvent('toggle-on', {
                  composed: true,
                  bubbles: true,
                })
              );
            }}
            @keypress=${() => {
              this.dispatchEvent(
                new CustomEvent('toggle-on', {
                  composed: true,
                  bubbles: true,
                })
              );
            }}
          />
        `;
  }

  static styles = [sharedStyles, css``];
}
