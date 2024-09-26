import { css, html, LitElement, PropertyValues } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
// @ts-ignore
import renderIcon from '@holo-host/identicon';
import { classMap } from 'lit/directives/class-map.js';
import { encodeHashToBase64, HoloHash } from '@holochain/client';
import { localized, msg } from '@lit/localize';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import { hashProperty } from '@holochain-open-dev/elements';

@localized()
@customElement('holo-identicon')
export class HoloIdenticon extends LitElement {
  @property(hashProperty('hash'))
  hash!: HoloHash;

  /**
   * Size of the identicon in pixels.
   */
  @property({ type: Number })
  size = 32;

  /**
   * Shape of the identicon.
   */
  @property({ type: String })
  shape: 'square' | 'circle' = 'circle';

  @query('#canvas')
  private _canvas!: HTMLCanvasElement;

  @state()
  justCopiedHash = false;

  get strHash() {
    return encodeHashToBase64(this.hash);
  }

  updated(changedValues: PropertyValues) {
    super.updated(changedValues);

    if (
      (changedValues.has('hash') &&
        changedValues.get('hash')?.toString() !== this.hash?.toString()) ||
      changedValues.has('size') ||
      changedValues.has('value')
    ) {
      renderIcon(
        {
          hash: this.hash,
          size: this.size,
        },
        this._canvas
      );
    }
  }

  render() {
    return html`<canvas
      id="canvas"
      width="1"
      height="1"
      class=${classMap({
        square: this.shape === 'square',
        circle: this.shape === 'circle',
      })}
    ></canvas>`;
  }

  static get styles() {
    return css`
      :host {
        display: flex;
      }

      .square {
        border-radius: 0%;
      }
      .circle {
        border-radius: 50%;
      }
    `;
  }
}
