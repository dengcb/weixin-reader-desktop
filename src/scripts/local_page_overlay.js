(()=>{var topLevelClientY=(event,frame)=>{try{const rect=frame.getBoundingClientRect();return frame.ownerDocument===document?event.clientY:event.clientY+rect.top}catch{return event.clientY}};var attachEventToSameOriginIframes=(eventType,handler)=>{const instrumented=new WeakSet;const attached=new Map;const observers=[];const wrap=(doc)=>{if(eventType!=="mousemove")return handler;return(event)=>{const frame=doc.defaultView?.frameElement;if(frame){const enriched=event;enriched.__atreaderTopClientY=topLevelClientY(event,frame)}handler(event)}};const attachDoc=(doc)=>{if(!doc||attached.has(doc))return;const wrapped=wrap(doc);attached.set(doc,wrapped);doc.addEventListener(eventType,wrapped,true);const docObserver=new MutationObserver((records)=>{for(const record of records){for(const node of record.addedNodes){if(isIframe(node)){instrument(node)}else if(node instanceof Element){node.querySelectorAll?.("iframe").forEach((child)=>instrument(child))}}}});if(doc.documentElement){docObserver.observe(doc.documentElement,{childList:true,subtree:true})}observers.push(docObserver)};const instrument=(iframe)=>{if(instrumented.has(iframe))return;instrumented.add(iframe);const tryAttach=()=>{try{attachDoc(iframe.contentDocument)}catch{}};tryAttach();iframe.addEventListener("load",tryAttach,{once:true})};const isIframe=(node)=>node.nodeName==="IFRAME";const observer=new MutationObserver((records)=>{for(const record of records){for(const node of record.addedNodes){if(isIframe(node)){instrument(node)}else if(node instanceof Element){node.querySelectorAll("iframe").forEach((child)=>instrument(child))}}}});const scan=()=>{document.querySelectorAll("iframe").forEach((node)=>instrument(node));observer.observe(document.documentElement,{childList:true,subtree:true})};let detached=false;const onDomReady=()=>{document.removeEventListener("DOMContentLoaded",onDomReady);if(!detached)scan()};if(document.documentElement){scan()}else{document.addEventListener("DOMContentLoaded",onDomReady)}return()=>{detached=true;observer.disconnect();document.removeEventListener("DOMContentLoaded",onDomReady);for(const docObserver of observers){docObserver.disconnect()}observers.length=0;for(const[doc,wrapped]of attached){doc.removeEventListener(eventType,wrapped,true)}attached.clear()}};var attachKeyboardToSameOriginIframes=(handler)=>attachEventToSameOriginIframes("keydown",handler);var attachKeyUpToSameOriginIframes=(handler)=>attachEventToSameOriginIframes("keyup",handler);function injectCSS(id,cssContent){let style=document.getElementById(id);if(!style){style=document.createElement("style");style.id=id;if(document.head){document.head.appendChild(style)}else if(document.documentElement){document.documentElement.appendChild(style)}else{const observer=new MutationObserver((mutations)=>{for(const mutation of mutations){if(mutation.addedNodes.length>0){if(document.head){document.head.appendChild(style);observer.disconnect();return}else if(document.documentElement){document.documentElement.appendChild(style);observer.disconnect();return}}}});observer.observe(document,{childList:true})}}style.innerHTML=cssContent}function removeCSS(id){const style=document.getElementById(id);if(style){style.remove()}}var BOOKSTORE_SWITCHER_ID="wxrd-bookstore-switcher";var BOOKSTORE_SWITCHER_STYLE_ID=`${BOOKSTORE_SWITCHER_ID}-style`;var HIDE_ANIMATION_MS=120;var SWITCHER_CSS=`
#${BOOKSTORE_SWITCHER_ID} {
  --panel-bg: rgba(245, 245, 247, 0.72);
  --panel-border: rgba(0, 0, 0, 0.08);
  --panel-shadow: 0 24px 64px rgba(0, 0, 0, 0.18), 0 4px 16px rgba(0, 0, 0, 0.10);
  --name-color: #5f6368;
  --name-active-color: #1f2329;
  --badge-bg: rgba(0, 0, 0, 0.08);
  --badge-color: #1f2329;
  --active-bg: rgba(255, 255, 255, 0.70);
  --active-border: rgba(0, 0, 0, 0.06);
  --active-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
  --current-ring: #349f66;
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 距屏幕边缘的最小边距：padding 同时约束面板换行后的可视范围 */
  padding: 40px;
  z-index: 2147483647;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.1s ease;
}
@media (prefers-color-scheme: dark) {
  #${BOOKSTORE_SWITCHER_ID} {
    --panel-bg: rgba(28, 30, 32, 0.72);
    --panel-border: rgba(255, 255, 255, 0.10);
    --panel-shadow: 0 24px 64px rgba(0, 0, 0, 0.45), 0 4px 16px rgba(0, 0, 0, 0.30);
    --name-color: #a6aa9e;
    --name-active-color: #ffffff;
    --badge-bg: rgba(255, 255, 255, 0.14);
    --badge-color: #e8eaed;
    --active-bg: rgba(255, 255, 255, 0.18);
    --active-border: transparent;
    --active-shadow: none;
    --current-ring: #60c38e;
  }
}
#${BOOKSTORE_SWITCHER_ID}.wxrd-switcher-shown {
  opacity: 1;
}
/* 站点反色滤镜激活时二次反转抵消：浮层与图标保持自有设计观感
  （html 反色 + 浮层反色 = 原色；内部 img/svg 交回站点反转规则之外的原始色） */
html.wxrd-theme-inverted #${BOOKSTORE_SWITCHER_ID} {
  filter: invert(1) hue-rotate(180deg);
}
html.wxrd-theme-inverted #${BOOKSTORE_SWITCHER_ID} :is(img, video, canvas, svg) {
  filter: none !important;
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-panel {
  pointer-events: auto;
  display: flex;
  max-width: min(960px, 100%);
  padding: 20px;
  border: 1px solid var(--panel-border);
  border-radius: 20px;
  background: var(--panel-bg);
  -webkit-backdrop-filter: blur(28px) saturate(1.4);
  backdrop-filter: blur(28px) saturate(1.4);
  box-shadow: var(--panel-shadow);
  transform: scale(0.96);
  transition: transform 0.12s cubic-bezier(0.2, 0.8, 0.2, 1);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
}
/* 单行排布，永不换行；超出面板宽度时横向滚动，选中项自动滚入视野，
   两端的裁切内容用渐隐提示（macOS Cmd+Tab 语义）。 */
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-track {
  display: flex;
  flex: 1 1 auto;
  justify-content: flex-start;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
  /* 高亮项放大 1.05 + 阴影需要少量裁切余量 */
  padding: 6px;
  margin: -6px;
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-track::-webkit-scrollbar {
  display: none;
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-track.wxrd-switcher-fade-left {
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 28px);
  mask-image: linear-gradient(to right, transparent 0, #000 28px);
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-track.wxrd-switcher-fade-right {
  -webkit-mask-image: linear-gradient(to left, transparent 0, #000 28px);
  mask-image: linear-gradient(to left, transparent 0, #000 28px);
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-track.wxrd-switcher-fade-left.wxrd-switcher-fade-right {
  -webkit-mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 28px,
    #000 calc(100% - 28px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 28px,
    #000 calc(100% - 28px),
    transparent 100%
  );
}
#${BOOKSTORE_SWITCHER_ID}.wxrd-switcher-shown .wxrd-switcher-panel {
  transform: scale(1);
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-item {
  width: 96px;
  padding: 10px 4px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  font: inherit;
  color: var(--name-color);
  cursor: pointer;
  outline: none;
  -webkit-user-select: none;
  user-select: none;
  transition: background 0.12s ease, transform 0.12s ease,
    border-color 0.12s ease, box-shadow 0.12s ease, color 0.12s ease;
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-item.wxrd-switcher-active {
  background: var(--active-bg);
  border-color: var(--active-border);
  box-shadow: var(--active-shadow);
  transform: scale(1.05);
  color: var(--name-active-color);
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-icon-wrap {
  position: relative;
  width: 64px;
  height: 64px;
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-icon {
  display: block;
  width: 64px;
  height: 64px;
  /* 部分站点 PNG 自带更大的圆角＋透明角（起点等），白色垫底会在角上露白；
     裁切弧必须大于图标自带弧（18px ≈ 64px 的 28%）才能把它们裁掉 */
  border-radius: 18px;
  object-fit: cover;
  /* 透明底图标在深色面板上的可读底色 */
  background: #ffffff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-icon-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: linear-gradient(135deg, #349f66, #223f2f);
  color: #ffffff;
  font-size: 30px;
  font-weight: 600;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-item.wxrd-switcher-current .wxrd-switcher-icon,
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-item.wxrd-switcher-current .wxrd-switcher-icon-fallback {
  outline: 2px solid var(--current-ring);
  outline-offset: 1px;
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-badge {
  position: absolute;
  top: -5px;
  left: -5px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  box-sizing: border-box;
  border-radius: 8px;
  background: var(--badge-bg);
  color: var(--badge-color);
  font-size: 10px;
  line-height: 16px;
  font-weight: 600;
  text-align: center;
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}
#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-name {
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.2;
}
@media (prefers-reduced-motion: reduce) {
  #${BOOKSTORE_SWITCHER_ID},
  #${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-panel,
  #${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-item {
    transition: none;
  }
}
`;class BookstoreSwitcherController{host;doc;stopPagePropagation;state="idle";entries=[];highlightIndex=0;currentListIndex=-1;queuedAdvances=0;loadGeneration=0;hideTimer=null;view;keydownHandler;keyupHandler;pointerHandler;blurHandler;detachIframeKeyDown;detachIframeKeyUp;destroyed=false;constructor(host,doc=document,stopPagePropagation=false){this.host=host;this.doc=doc;this.stopPagePropagation=stopPagePropagation;this.view=doc.defaultView??window;this.keydownHandler=(event)=>this.onKeyDown(event);this.keyupHandler=(event)=>this.onKeyUp(event);this.pointerHandler=(event)=>this.onPointerDown(event);this.blurHandler=()=>this.cancel();this.view.addEventListener("keydown",this.keydownHandler,true);this.view.addEventListener("keyup",this.keyupHandler,true);this.doc.addEventListener("pointerdown",this.pointerHandler,true);this.view.addEventListener("blur",this.blurHandler,true);this.detachIframeKeyDown=attachKeyboardToSameOriginIframes(this.keydownHandler);this.detachIframeKeyUp=attachKeyUpToSameOriginIframes(this.keyupHandler)}destroy(){if(this.destroyed)return;this.destroyed=true;this.loadGeneration++;this.state="idle";this.view.removeEventListener("keydown",this.keydownHandler,true);this.view.removeEventListener("keyup",this.keyupHandler,true);this.doc.removeEventListener("pointerdown",this.pointerHandler,true);this.view.removeEventListener("blur",this.blurHandler,true);this.detachIframeKeyDown();this.detachIframeKeyUp();if(this.hideTimer){this.view.clearTimeout(this.hideTimer);this.hideTimer=null}this.doc.getElementById(BOOKSTORE_SWITCHER_ID)?.remove();removeCSS(BOOKSTORE_SWITCHER_STYLE_ID)}onKeyDown(event){if(this.destroyed)return;if(this.state==="visible"&&event.key==="Escape"){event.preventDefault();this.cancel();return}const isTriggerKey=event.key?.toLowerCase()==="l"||event.code==="KeyL";if(!isTriggerKey)return;if(!(event.metaKey||event.ctrlKey))return;if(event.repeat)return;event.preventDefault();if(this.stopPagePropagation)event.stopImmediatePropagation();if(this.state==="visible"){this.advance();return}if(this.state==="pending"){this.queuedAdvances++;return}this.state="pending";this.queuedAdvances=0;this.open()}open(){const generation=++this.loadGeneration;this.host.loadEntries().then((model)=>{if(this.destroyed||generation!==this.loadGeneration)return;if(this.state!=="pending")return;if(model.entries.length===0){this.state="idle";return}this.entries=model.entries;this.currentListIndex=model.currentIndex;this.highlightIndex=model.currentIndex>=0&&model.currentIndex<model.entries.length?(model.currentIndex+1)%model.entries.length:0;while(this.queuedAdvances>0){this.queuedAdvances--;this.highlightIndex=(this.highlightIndex+1)%this.entries.length}this.renderPanel();this.state="visible";this.show()})}startRemoteCycle(){if(this.destroyed||this.state!=="idle")return;this.queuedAdvances=0;this.state="pending";this.open()}advanceRemote(){if(this.destroyed||this.state!=="visible")return;this.advance()}commitRemote(){if(this.destroyed)return;if(this.state==="visible"){this.commitIndex(this.highlightIndex);return}this.cancel()}cancelRemote(){this.cancel()}get isVisible(){return this.state==="visible"}get isPending(){return this.state==="pending"}onKeyUp(event){if(this.destroyed||this.state==="idle")return;if(event.metaKey||event.ctrlKey)return;event.preventDefault();if(this.stopPagePropagation)event.stopImmediatePropagation();if(this.state==="pending"){this.cancel();return}this.commitIndex(this.highlightIndex)}onPointerDown(event){if(this.destroyed||this.state!=="visible")return;const target=event.target;if(target?.closest(`#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-panel`)){return}this.cancel()}advance(){if(this.entries.length===0)return;this.highlightIndex=(this.highlightIndex+1)%this.entries.length;this.updateHighlight()}commitIndex(entryIndex){const entry=this.entries[entryIndex];this.state="idle";this.hide();if(entry)this.host.commit(entry)}cancel(){if(this.state==="pending"){this.loadGeneration++}this.state="idle";this.hide()}renderPanel(){injectCSS(BOOKSTORE_SWITCHER_STYLE_ID,SWITCHER_CSS);let root=this.doc.getElementById(BOOKSTORE_SWITCHER_ID);if(!root){root=this.doc.createElement("div");root.id=BOOKSTORE_SWITCHER_ID;root.setAttribute("role","dialog");root.setAttribute("aria-label","切换书城")}root.textContent="";const panel=this.doc.createElement("div");panel.className="wxrd-switcher-panel";const track=this.doc.createElement("div");track.className="wxrd-switcher-track";this.entries.forEach((entry,entryIndex)=>{track.appendChild(this.renderItem(entry,entryIndex,entryIndex===this.currentListIndex))});track.addEventListener("scroll",()=>this.syncTrackOverflow(track));panel.appendChild(track);root.appendChild(panel);if(!root.parentNode)this.doc.body.appendChild(root);this.updateHighlight()}renderItem(entry,entryIndex,isCurrent){const item=this.doc.createElement("button");item.type="button";item.className="wxrd-switcher-item";item.dataset.siteId=entry.id;if(isCurrent)item.classList.add("wxrd-switcher-current");const iconWrap=this.doc.createElement("span");iconWrap.className="wxrd-switcher-icon-wrap";if(entry.icon){const img=this.doc.createElement("img");img.className="wxrd-switcher-icon";img.src=entry.icon;img.alt="";img.draggable=false;iconWrap.appendChild(img)}else{const fallback=this.doc.createElement("span");fallback.className="wxrd-switcher-icon-fallback";fallback.textContent=Array.from(entry.name)[0]??"·";iconWrap.appendChild(fallback)}if(entry.index>=0&&entry.index<=7){const badge=this.doc.createElement("span");badge.className="wxrd-switcher-badge";badge.textContent=String(entry.index);iconWrap.appendChild(badge)}const name=this.doc.createElement("span");name.className="wxrd-switcher-name";name.textContent=entry.name;name.title=entry.name;item.appendChild(iconWrap);item.appendChild(name);item.addEventListener("click",()=>{if(!this.destroyed&&this.state==="visible")this.commitIndex(entryIndex)});return item}updateHighlight(){const root=this.doc.getElementById(BOOKSTORE_SWITCHER_ID);if(!root)return;root.querySelectorAll(".wxrd-switcher-item").forEach((item,itemIndex)=>{item.classList.toggle("wxrd-switcher-active",itemIndex===this.highlightIndex)});this.scrollHighlightIntoView()}scrollHighlightIntoView(){const root=this.doc.getElementById(BOOKSTORE_SWITCHER_ID);const track=root?.querySelector(".wxrd-switcher-track");const active=root?.querySelector(".wxrd-switcher-active");if(!track||!active)return;const trackRect=track.getBoundingClientRect();const itemRect=active.getBoundingClientRect();const margin=12;if(itemRect.left<trackRect.left+margin){track.scrollLeft-=trackRect.left+margin-itemRect.left}else if(itemRect.right>trackRect.right-margin){track.scrollLeft+=itemRect.right-(trackRect.right-margin)}this.syncTrackOverflow(track)}syncTrackOverflow(track){const overflowing=track.scrollWidth>track.clientWidth+1;track.classList.toggle("wxrd-switcher-fade-left",overflowing&&track.scrollLeft>1);track.classList.toggle("wxrd-switcher-fade-right",overflowing&&track.scrollLeft+track.clientWidth<track.scrollWidth-1)}show(){if(this.hideTimer){this.view.clearTimeout(this.hideTimer);this.hideTimer=null}const root=this.doc.getElementById(BOOKSTORE_SWITCHER_ID);if(!root)return;root.getBoundingClientRect().width;root.classList.add("wxrd-switcher-shown")}hide(){const root=this.doc.getElementById(BOOKSTORE_SWITCHER_ID);if(!root)return;root.classList.remove("wxrd-switcher-shown");if(this.hideTimer)this.view.clearTimeout(this.hideTimer);this.hideTimer=this.view.setTimeout(()=>{this.hideTimer=null;root.remove()},HIDE_ANIMATION_MS)}}var log={debug:(...args)=>{const isDev=typeof window!=="undefined"&&window.__TAURI__&&!window.__TAURI__.__currentWindow?.label?.includes("app.");if(isDev){console.log(...args)}},info:(...args)=>{console.log(...args)},warn:(...args)=>{console.warn(...args)},error:(...args)=>{console.error(...args)}};var invoke=(cmd,args)=>{if(window.__TAURI__){return window.__TAURI__.core.invoke(cmd,args)}else{log.warn(`[Tauri] Invoke '${cmd}' failed: API not found`);return Promise.resolve({})}};var listen=(event,handler)=>{if(window.__TAURI__){return window.__TAURI__.event.listen(event,handler)}log.warn(`[Tauri] Listen '${event}' failed: API not found`);return Promise.resolve(()=>{})};var REMOTE_HID_BUTTON_EVENT="remote-hid-button";var subscribeRemoteHidButtons=(handler)=>{let disposed=false;let unlisten=null;listen(REMOTE_HID_BUTTON_EVENT,(event)=>{handler(event.payload)}).then((dispose)=>{if(disposed){dispose();return}unlisten=dispose}).catch((error)=>log.warn("[RemoteHid] 订阅失败",error));return()=>{disposed=true;if(unlisten){unlisten();unlisten=null}}};var OVERLAY_ID="atreader-site-switch-loading";var STYLE_ID=`${OVERLAY_ID}-style`;var BREATHE_MS=2200;var TRAVEL_MS=1500;var LOAD_FALLBACK_MS=4000;var PROBE_GRACE_MS=1500;var SCROLLBAR_STYLE_ID=`${OVERLAY_ID}-scrollbar-style`;var measureScrollbarWidth=(doc)=>{const host=doc.body??doc.documentElement;if(!host)return 0;const probe=doc.createElement("div");probe.style.cssText="position:absolute;top:-999px;width:100px;height:100px;overflow:scroll;";host.appendChild(probe);const width=100-probe.clientWidth;probe.remove();return width>0?width:0};var scrollbarLockCss=(scrollbarWidth)=>`
html {
  overflow: hidden !important;
  /* 滚动条槽位补偿：恢复时与 padding 一起撤，净布局变化为零 */
  padding-right: ${scrollbarWidth}px !important;
}
`;var LOGO_DATA_URI="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij4KCTxwYXRoIGQ9Ik0xNS4zLDEyLjhjMi43LS4xLDEsLjMsMS44LDEuOS4zLjYsMS4xLjYsMS41LjIuMi0uMy40LS44LjgtLjUuNy41LDIuNy4yLDIuNSwxLjItMS45LDQtOC4yLDMuMi04LjEtMS42LS41LTEuNS4zLTEuMywxLjUtMS4zaDBaIi8+Cgk8cGF0aCBkPSJNMTIuMi4zYzEuOC4zLDYuNy0uOSw0LjYsMi4zLS4yLjQtLjMsMS0uOS45LTEuOS0uNC0zLjgtLjUtNS43LDAtLjMsMC0uNS0uMS0uNS0uNC0uNC0zLjItMS43LTIuNSwyLjQtMi43WiIvPgoJPHBhdGggZD0iTTkuNSwzYy4yLDEuMi0yLjIuMi0zLjUsMi44LS4yLjQtLjEsMS40LS45LDEuMS0uNi0uNS0yLjYtLjQtMi40LTEuNCwxLjEtMi40LDYuNi03LjcsNi44LTIuNVoiLz4KCTxwYXRoIGQ9Ik0xNS4zLDUuN2MuNS4xLDEuOS0uNCwxLjcuNS0uNC44LS4xLDIuMi0uMiwzLjIsMCwzLjEuOCwzLjQtMi43LDMuMS0xLjEtLjMuMy00LjktLjUtNi4yLS4zLS45LDEuMy0uNSwxLjgtLjZoMFoiLz4KCTxwYXRoIGQ9Ik00LjgsMTQuNWMuMyw0LjgsMy4yLDMuNC43LDUuNi0uNC4zLS44LDEuMy0xLjMuNy0xLjMtMS40LTIuMi0zLjItMi4zLTUuMi0uMS0xLjQtMS0xLjcsMS0xLjguNywwLDIuMi0uNiwxLjkuN1oiLz4KCTxwYXRoIGQ9Ik0yLjIsMTMuNmMtMS4yLjItLjQtMS0uNS0xLjcuNS0yLjgtMS4xLTcuMSwzLjMtNC42LjIsMCwuMy4zLjIuNS0uNywxLjUtLjQsMy4yLS41LDQuOC4zLDEuNC0xLjcuOC0yLjUsMSwwLDAsMCwwLDAsMFoiLz4KCTxwYXRoIGQ9Ik0xMi40LDIzLjZjLTEuOC0uMS05LjUtMS4xLTYuNC0zLjYuMy0uMy44LTEuMSwxLjMtLjYsMS44LDIuNCw2LDEuMSw1LjksMiwwLDEsLjcsMi42LS45LDIuMloiLz4KCTxwYXRoIGQ9Ik0xOS4xLDcuMWMuMS0zLjQtMy40LTIuNC0xLjktNC42LDEtNC4yLDQuOSwyLjYsNS4xLDQuNC4yLjktMS4xLjYtMS42LjgtLjcsMC0xLjguNi0xLjYtLjVaIi8+Cgk8cGF0aCBkPSJNMjIuNiw4Yy0uNSwxLjYuNSw2LjEtLjksNi43LTQuMy0uNS0xLjgtMi4yLTIuMy01LjIsMC0uNS0uNi0xLjMuMi0xLjQuOSwwLDIuNC0uOCwzLDBaIi8+Cgk8cGF0aCBkPSJNMTMuNiwyMS40YzAtLjYuNi0uNCwxLS41LDEuNywwLDMuMi0uOSw0LjUtMiwuNy0uNS4zLDEsMS44LDEuMi45LDEuNy01LjMsMy42LTYuOCwzLjUtLjctLjItLjMtMS42LS42LTIuMloiLz4KCTxwYXRoIGQ9Ik02LjcsMTIuM2MuMi0uOSwwLTQsLjktNCwuNy41LDIuNi43LDIuNCwxLjgtLjMsMS4yLS4yLDIuNSwwLDMuNy4xLjYtLjguNy0xLjIuOS0yLjMsMS42LTEuOS0uNy0yLjEtMi40WiIvPgoJPHBhdGggZD0iTTExLjMsMTguMmMtMSwuMy01LjEtMS43LTMuNS0yLjYsMS40LS4yLDIuMi0xLjUsMi42LS44LjYuOSwxLjkuNSwyLjYtLjEuOC0uNS41LDEuMy45LDEuNywxLDEuNS0xLjYsMS43LTIuNiwxLjgsMCwwLDAsMCwwLDBaIi8+Cgk8cGF0aCBkPSJNMTMuNCw4LjJjMCwuMywwLDEuMy0uNC44LTEtMS4yLTIuMSwwLTMsMC0uNy0uNC0xLjQtLjctMi4xLTEtMS0xLjUsNi40LTQuNyw1LjYuMloiLz4KPC9zdmc+";var readinessProbe=null;var SWITCH_LOADING_CSS=`
/* 站点反色滤镜激活时（html.wxrd-theme-inverted），过场层二次反转抵消，
   保持自有深色观感不被一起反色；内部元素交回原色（过场无图片资源） */
html.wxrd-theme-inverted #${OVERLAY_ID} {
  filter: invert(1) hue-rotate(180deg);
}
html.wxrd-theme-inverted #${OVERLAY_ID} :is(img, video, canvas, svg),
html.wxrd-theme-inverted #${OVERLAY_ID} [style*="background-image"] {
  filter: none !important;
}
#${OVERLAY_ID} {
  position: fixed;
  /* 不用 inset:0——它的宽度跟随布局视口，页面加载中经典滚动条出现/消失
     会挤压居中内容（可见的左移一跳）。100vw/vh 含滚动条槽，宽度恒定。 */
  left: 0;
  top: 0;
  width: 100vw;
  height: 100vh;
  z-index: 2147483647;
  display: grid;
  place-items: center;
  overflow: hidden;
  color: #edf5f1;
  background:
    radial-gradient(circle at 50% 42%, rgba(52, 159, 102, .14), transparent 38%),
    linear-gradient(145deg, #202826, #171c1b 64%);
  font-family: "Songti SC", "Noto Serif CJK SC", STSong, serif;
  user-select: none;
  -webkit-user-select: none;
  opacity: 1;
  transition: opacity .24s ease;
}
#${OVERLAY_ID}.atreader-switch-loading-done {
  opacity: 0;
  pointer-events: none;
}
#${OVERLAY_ID} main {
  width: min(360px, calc(100vw - 64px));
  display: grid;
  justify-items: center;
  text-align: center;
}
#${OVERLAY_ID} .logo {
  width: 72px;
  height: 72px;
  background: #349f66;
  -webkit-mask: url('${LOGO_DATA_URI}') center / contain no-repeat;
  mask: url('${LOGO_DATA_URI}') center / contain no-repeat;
  filter: drop-shadow(0 12px 26px rgba(52, 159, 102, .18));
  animation: atreaderSwitchBreathe ${BREATHE_MS}ms ease-in-out infinite;
  /* 挂载时注入墙上时钟对齐的负 animation-delay（见 mount），预铺过场与
     新文档过场因此共享同一相位轴，交接只剩导航冻结帧的微小相位差 */
}
#${OVERLAY_ID} h1 {
  margin: 25px 0 0;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: .2em;
  text-indent: .2em;
  /* 显式行高：normal 跟随字体度量，文档间存在差异的理论空间 */
  line-height: 1.2;
}
#${OVERLAY_ID} .status {
  margin: 13px 0 0;
  color: #91a39c;
  font: 12px/1.6 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .08em;
}
#${OVERLAY_ID} .progress {
  width: 132px;
  height: 1px;
  margin-top: 24px;
  overflow: hidden;
  background: rgba(237, 245, 241, .1);
}
#${OVERLAY_ID} .progress-block {
  width: 48%;
  height: 100%;
  background: #349f66;
  animation: atreaderSwitchTravel ${TRAVEL_MS}ms ease-in-out infinite;
}
@keyframes atreaderSwitchBreathe {
  50% { transform: scale(.95); opacity: .72; }
}
@keyframes atreaderSwitchTravel {
  from { transform: translateX(-105%); }
  to { transform: translateX(215%); }
}
@media (prefers-reduced-motion: reduce) {
  #${OVERLAY_ID} .logo,
  #${OVERLAY_ID} .progress-block { animation: none; }
  #${OVERLAY_ID} .progress-block { width: 100%; opacity: .55; }
  #${OVERLAY_ID} { transition: none; }
}
`;var showSiteSwitchLoading=(doc=document,timing={})=>{if(doc.getElementById(OVERLAY_ID))return;injectCSS(STYLE_ID,SWITCH_LOADING_CSS);injectCSS(SCROLLBAR_STYLE_ID,scrollbarLockCss(measureScrollbarWidth(doc)));const view=doc.defaultView??window;const settleMs=timing.settleMs??320;const probeGraceMs=timing.probeGraceMs??PROBE_GRACE_MS;const maxMs=timing.maxMs??(timing.sticky?2500:15000);const overlayStart=Date.now();let dismissed=false;let overlay=null;const dismiss=()=>{if(dismissed)return;dismissed=true;if(!overlay)return;overlay.classList.add("atreader-switch-loading-done");setTimeout(()=>{removeCSS(SCROLLBAR_STYLE_ID);overlay?.remove()},280)};const mount=()=>{if(doc.getElementById(OVERLAY_ID))return;const overlayEl=doc.createElement("div");overlayEl.id=OVERLAY_ID;overlayEl.setAttribute("role","status");overlayEl.setAttribute("aria-label","正在加载");overlayEl.innerHTML='<main><div class="logo" role="img" aria-label="艾特阅读标志"></div>'+"<h1>艾特阅读</h1>"+'<p class="status">正在准备阅读空间</p>'+'<div class="progress" aria-hidden="true"><div class="progress-block"></div></div></main>';const logo=overlayEl.querySelector(".logo");const block=overlayEl.querySelector(".progress-block");if(logo)logo.style.animationDelay=`-${Date.now()%BREATHE_MS}ms`;if(block)block.style.animationDelay=`-${Date.now()%TRAVEL_MS}ms`;(doc.body??doc.documentElement)?.appendChild(overlayEl);overlay=overlayEl;if(timing.sticky){setTimeout(dismiss,maxMs);return}const settle=()=>{if(!readinessProbe&&Date.now()-overlayStart<probeGraceMs){setTimeout(settle,300);return}if(readinessProbe&&!readinessProbe()&&Date.now()-overlayStart<maxMs){setTimeout(settle,300);return}dismiss()};if(doc.readyState==="complete"){setTimeout(settle,settleMs)}else{view.addEventListener("load",()=>setTimeout(settle,settleMs),{once:true});setTimeout(()=>{if(!dismissed)setTimeout(settle,settleMs)},LOAD_FALLBACK_MS)}setTimeout(dismiss,maxMs)};if(doc.body||doc.documentElement){mount();return}const observer=new MutationObserver(()=>{if(doc.body||doc.documentElement){observer.disconnect();mount()}});observer.observe(doc,{childList:true});doc.addEventListener("DOMContentLoaded",()=>{observer.disconnect();mount()},{once:true})};var TV_HOLD_MS=500;var TV_ADVANCE_MS=500;var currentId=null;var toEntry=(item)=>({id:item.id,name:item.name,icon:item.icon??null,index:item.index});var fetchList=async()=>{const list=await invoke("get_bookstore_list");return Array.isArray(list)?list:[]};var commitEntry=(entry)=>{if(currentId!==null&&entry.id===currentId)return;showSiteSwitchLoading(document,{sticky:true});invoke("switch_bookstore_by_index",{index:entry.index}).catch(()=>{return})};var controller=new BookstoreSwitcherController({loadEntries:async()=>{const items=await fetchList();const currentIndex=items.findIndex((item)=>item.current);currentId=currentIndex>=0?items[currentIndex]?.id??null:null;return{entries:items.map(toEntry),currentIndex}},commit:commitEntry},document,navigator.userAgent.includes("Windows"));var switchToNext=async()=>{try{const items=await fetchList();if(items.length===0)return;const currentIndex=items.findIndex((item)=>item.current);currentId=currentIndex>=0?items[currentIndex]?.id??null:null;const nextIndex=currentIndex<0?0:(currentIndex+1)%items.length;const target=items[nextIndex];if(target)commitEntry(toEntry(target))}catch{}};var tvHoldTimer=null;var tvAdvanceTimer=null;var tvCycleActive=false;var clearTvTimers=()=>{if(tvHoldTimer!==null){clearTimeout(tvHoldTimer);tvHoldTimer=null}if(tvAdvanceTimer!==null){clearInterval(tvAdvanceTimer);tvAdvanceTimer=null}};subscribeRemoteHidButtons((event)=>{if(event.button!=="tv")return;if(event.phase==="press"){clearTvTimers();tvCycleActive=false;tvHoldTimer=setTimeout(()=>{tvHoldTimer=null;tvCycleActive=true;controller.startRemoteCycle();tvAdvanceTimer=setInterval(()=>controller.advanceRemote(),TV_ADVANCE_MS)},TV_HOLD_MS);return}const wasCycle=tvCycleActive;clearTvTimers();tvCycleActive=false;if(!wasCycle){switchToNext();return}if(controller.isVisible){controller.commitRemote();return}if(controller.isPending){controller.cancelRemote();switchToNext()}});})();
