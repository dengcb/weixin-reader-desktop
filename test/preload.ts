import { Window } from 'happy-dom';

const browser = new Window({ url: 'https://example.com/' });
const globals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  location: browser.location,
  history: browser.history,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Event: browser.Event,
  CustomEvent: browser.CustomEvent,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  WheelEvent: browser.WheelEvent,
  HTMLElement: browser.HTMLElement,
  HTMLStyleElement: browser.HTMLStyleElement,
  MutationObserver: browser.MutationObserver,
  DOMParser: browser.DOMParser,
  XMLSerializer: browser.XMLSerializer,
  NodeFilter: browser.NodeFilter,
  MediaQueryListEvent: browser.MediaQueryListEvent,
  Node: browser.Node,
};

Object.assign(globalThis, globals);
