
import { invoke } from './core/tauri';

// Global check flag
let hasRun = false;

export function runProbe() {
  if (hasRun) return;
  hasRun = true;

  console.log('[PROBE] Starting probe...');

  // Set up periodic scanning
  setInterval(() => {
    try {
      scan();
    } catch (e) {
      console.error('[PROBE] Error during scan:', e);
    }
  }, 5000);
}

function scan() {
  const results: any = {};

  // 1. Search React Root
  // React often mounts on #app or #root
  const rootIds = ['app', 'root', 'router-view'];
  let reactRoot: any = null;

  // Try to find the React internal instance key (starts with __reactContainer or __reactFiber)
  const allKeys = Object.keys(document.getElementById('app') || {});
  // Also check direct properties on DOM elements if needed, but usually they are on the container

  // Method A: Traverse DOM to find elements with React keys
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  while(walker.nextNode()) {
    const node = walker.currentNode as any;
    const keys = Object.keys(node);
    const reactKey = keys.find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (reactKey) {
       // Found a React component. Check if it has interesting props.
       const fiber = node[reactKey];
       checkFiber(fiber, results);
       // Don't scan everything, just sample some deep nodes
       if (Object.keys(results).length > 5) break;
    }
  }

  // 2. Search for text content with "%"
  const percentNodes: string[] = [];
  const textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while(textWalker.nextNode()) {
    const node = textWalker.currentNode;
    if (node.textContent && node.textContent.includes('%') && node.textContent.length < 20) {
      // Filter out CSS or scripts
      if (node.parentElement?.tagName !== 'STYLE' && node.parentElement?.tagName !== 'SCRIPT') {
         percentNodes.push(`${node.textContent.trim()} (in <${node.parentElement?.tagName} class="${node.parentElement?.className}">)`);
      }
    }
  }
  if (percentNodes.length > 0) {
    results['percentText'] = percentNodes;
  }

  // 3. Check Global Variables
  const globalVars = Object.keys(window).filter(k =>
    !k.startsWith('webkit') &&
    !k.startsWith('getAll') &&
    !k.startsWith('on')
  );

  // Filter for interesting names
  const interestingGlobals = globalVars.filter(k => /weread|reader|app|store|state|info/i.test(k));
  if (interestingGlobals.length > 0) {
    results['globals'] = {};
    interestingGlobals.forEach(k => {
      try {
        const val = (window as any)[k];
        if (typeof val === 'object' && val !== null) {
           results['globals'][k] = JSON.stringify(val).slice(0, 200); // Sample
        }
      } catch(e) {}
    });
  }

  // Log if anything interesting found
  if (Object.keys(results).length > 0) {
     const msg = `[PROBE] Scan Results: ${JSON.stringify(results)}`;
     console.log(msg);
     // Also try to invoke log_to_file but catch error if CSP blocks it (based on user logs)
     try {
       // invoke('log_to_file', { message: msg });
     } catch(e) {}
  }
}

function checkFiber(fiber: any, results: any) {
  if (!fiber) return;

  // Check memoizedProps and memoizedState
  const props = fiber.memoizedProps || {};
  const state = fiber.memoizedState || {};

  // Look for keywords
  const keywords = ['progress', 'percent', 'chapterIdx', 'totalChapter', 'readRatio'];

  const checkObj = (obj: any, source: string) => {
    if (!obj) return;
    for (const key of Object.keys(obj)) {
      if (keywords.some(kw => key.toLowerCase().includes(kw))) {
         results[`React:${source}:${key}`] = obj[key];
      }
    }
  };

  checkObj(props, 'props');
  checkObj(state, 'state');

  // Recurse up? No, too slow. Just check this node.
}
