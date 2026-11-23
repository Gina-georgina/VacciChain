import '@testing-library/jest-dom';

// Reset the document title between tests so route-title assertions are deterministic.
afterEach(() => {
  document.title = '';
});