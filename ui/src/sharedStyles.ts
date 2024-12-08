import { css } from 'lit';

export const sharedStyles = css`
  .secondary-font {
    font-family: 'Baloo 2 Variable', sans-serif;
  }

  .primary-font {
    font-family: 'Pacifico', sans-serif;
  }

  .tertiary-font {
    font-family: 'Ubuntu', sans-serif;
  }

  .flex-1 {
    flex: 1;
  }

  .flex {
    display: flex;
  }

  .column {
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    flex-direction: row;
  }

  .center-content {
    justify-content: center;
    align-items: center;
  }

  .flex-scrollable-parent {
    position: relative;
    display: flex;
    flex: 1;
  }

  .flex-scrollable-container {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
  }

  .flex-scrollable-x {
    max-width: 100%;
    overflow-x: auto;
  }
  .flex-scrollable-y {
    max-height: 100%;
    overflow-y: auto;
  }

  .tooltip-filled {
    --sl-tooltip-background-color: black;
  }
`;
