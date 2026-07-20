const css = String.raw;
export const readerStyles = css`
  :root {
    /* Alucard (Light Theme) */
    --bg-color: #e8e4d3;
    --reader-bg-color: #fffbeb;
    --text-color: #1f1f1f;
    --header-bg-color: #f4eedc;
    --header-text-color: #2c2b31;
    --border-color: #cfcfde;
    --button-bg-color: #cfcfde;
    --button-hover-bg-color: #bdbdcf;
    --button-disabled-bg-color: #e2e2eb;
    --button-text-color: #1f1f1f;
    --input-bg-color: #fffbeb;
    --input-text-color: #1f1f1f;
    --input-border-color: #cfcfde;
    --input-focus-border-color: #644ac9;
    --input-focus-shadow-color: rgba(100, 74, 201, 0.2);
    --info-text-color: #6c664b;
    --instructions-text-color: #6c664b;
    --shadow-color: rgba(0, 0, 0, 0.08);
    --theme-toggle-hover-bg: rgba(0, 0, 0, 0.05);
    --reader-font-size: 1rem;
  }
  html[data-theme="dark"] {
    /* Dracula (Dark Theme) */
    --bg-color: #000000;
    --reader-bg-color: #1e1f29;
    --text-color: #f8f8f2;
    --header-bg-color: #15161d;
    --header-text-color: #bbbbbb;
    --border-color: #44475a;
    --button-bg-color: #44475a;
    --button-hover-bg-color: #555555;
    --button-disabled-bg-color: #2a2b38;
    --button-text-color: #f8f8f2;
    --input-bg-color: #1e1f29;
    --input-text-color: #f8f8f2;
    --input-border-color: #44475a;
    --input-focus-border-color: #bd93f9;
    --input-focus-shadow-color: rgba(189, 147, 249, 0.3);
    --info-text-color: #bbbbbb;
    --instructions-text-color: #bbbbbb;
    --shadow-color: rgba(0, 0, 0, 0.4);
    --theme-toggle-hover-bg: rgba(255, 255, 255, 0.1);
  }
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  body {
    font-family:
      -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu,
      Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
    color: var(--text-color);
    background-color: var(--bg-color);
    height: 100vh;
    overflow: hidden;
    transition:
      background-color 0.3s ease,
      color 0.3s ease;
    padding: 0;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  telocity-reader {
    display: block;
    height: 100%;
    width: 100%;
    max-width: 900px;
  }
  @media (max-width: 768px) {
    body {
      padding: 0;
      display: block;
      height: 100dvh;
    }
  }
`;
