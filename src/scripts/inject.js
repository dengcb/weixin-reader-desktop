var E=(d,h)=>{if(window.__TAURI__)return window.__TAURI__.core.invoke(d,h);return console.warn(`[Tauri] Invoke '${d}' failed: API not found`),Promise.resolve({})},T=(d,h)=>{if(window.__TAURI__)return window.__TAURI__.event.listen(d,h);return console.warn(`[Tauri] Listen '${d}' failed: API not found`),Promise.resolve(()=>{})};var w=()=>{return new Promise((d)=>{if(window.__TAURI__){d();return}let h=setInterval(()=>{if(window.__TAURI__)clearInterval(h),d()},10);setTimeout(()=>{clearInterval(h),d()},2000)})};class H{static instance;settings={};listeners=new Set;initialized=!1;constructor(){}static getInstance(){if(!H.instance)H.instance=new H;return H.instance}async init(){if(this.initialized)return;try{this.settings=await E("get_settings")||{}}catch(d){console.error("SettingsStore: Failed to load settings",d),this.settings={}}T("settings-updated",async()=>{let d=await E("get_settings")||{};this.updateLocal(d)}),this.initialized=!0,this.notify()}get(){return{...this.settings}}async update(d){this.settings={...this.settings,...d};try{await E("save_settings",{settings:d})}catch(h){console.error("SettingsStore: Failed to save settings",h)}this.notify()}subscribe(d){if(this.listeners.add(d),this.initialized)d(this.get());return()=>this.listeners.delete(d)}updateLocal(d){this.settings=d,this.notify()}notify(){let d=this.get();this.listeners.forEach((h)=>h(d))}}var b=H.getInstance();class W{isReader=!1;constructor(){this.init()}async init(){await w(),await b.init(),T("menu-action",(d)=>{this.handleMenuAction(d.payload)}),window.addEventListener("wxrd:route-changed",(d)=>{this.isReader=d.detail.isReader,this.syncMenuState()}),b.subscribe((d)=>{if(this.syncMenuState(d),d.zoom)E("set_zoom",{value:d.zoom})})}syncMenuState(d=b.get()){let h=!!d.readerWide,p=!!d.hideToolbar,x=!!d.autoFlip?.active,C=(_,z,O)=>{E("set_menu_item_enabled",{id:_,enabled:O}).then(()=>{E("update_menu_state",{id:_,state:z})})};C("reader_wide",h,this.isReader),C("hide_toolbar",p,this.isReader),C("auto_flip",x,this.isReader)}handleMenuAction(d){let h=b.get();switch(d){case"reader_wide":{let p=!h.readerWide,x={readerWide:p};if(!p&&h.hideToolbar)x.hideToolbar=!1;b.update(x)}break;case"hide_toolbar":b.update({hideToolbar:!h.hideToolbar});break;case"auto_flip":{let p=h.autoFlip||{active:!1,interval:30,keepAwake:!0},x=!p.active;b.update({autoFlip:{...p,active:x}})}break;case"zoom_in":{let p=h.zoom||1;p=Math.round((p+0.1)*10)/10,b.update({zoom:p})}break;case"zoom_out":{let p=h.zoom||1;if(p=Math.round((p-0.1)*10)/10,p<0.1)p=0.1;b.update({zoom:p})}break;case"zoom_reset":b.update({zoom:1});break}}}function B(d,h){let p=document.getElementById(d);if(!p)if(p=document.createElement("style"),p.id=d,document.head)document.head.appendChild(p);else if(document.documentElement)document.documentElement.appendChild(p);else{let x=new MutationObserver((C)=>{for(let _ of C)if(_.addedNodes.length>0){if(document.head){document.head.appendChild(p),x.disconnect();return}else if(document.documentElement){document.documentElement.appendChild(p),x.disconnect();return}}});x.observe(document,{childList:!0})}p.innerHTML=h}function Q(d){let h=document.getElementById(d);if(h)h.remove()}function A(d){let p={Right:"ArrowRight",Left:"ArrowLeft"}[d]||d,x=p==="ArrowRight"?39:37,C=new KeyboardEvent("keydown",{key:p,code:p,keyCode:x,which:x,bubbles:!0,cancelable:!0});document.dispatchEvent(C);let _=new KeyboardEvent("keyup",{key:p,code:p,keyCode:x,which:x,bubbles:!0,cancelable:!0});document.dispatchEvent(_)}class f{constructor(){this.init()}initLinks(){window.open=function(d,h,p){if(d)window.location.href=d.toString();return null},document.addEventListener("click",(d)=>{let p=d.target.closest("a");if(p&&p.target==="_blank")p.target="_self"},!0)}shouldEnableDarkMode(){return window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches}applyTheme(d){let h=window.self!==window.top,p=`
      img, video, canvas, svg {
        filter: invert(1) hue-rotate(180deg) !important;
      }
      [style*="background-image"] {
        filter: invert(1) hue-rotate(180deg) !important;
      }
      ::-webkit-scrollbar {
        background-color: #2c2c2c;
      }
      ::-webkit-scrollbar-track {
        background-color: #2c2c2c;
      }
      ::-webkit-scrollbar-thumb {
        background-color: #555;
        border-radius: 4px;
      }
    `,x=`
      html {
        filter: invert(1) hue-rotate(180deg) !important;
        background-color: #e0e0e0 !important;
      }
    `,C=h?`
      img, video, canvas, svg {
        filter: invert(1) hue-rotate(180deg) !important;
      }
      [style*="background-image"] {
        filter: invert(1) hue-rotate(180deg) !important;
      }
      ::-webkit-scrollbar {
        background-color: #2c2c2c;
      }
      ::-webkit-scrollbar-track {
        background-color: #2c2c2c;
      }
      ::-webkit-scrollbar-thumb {
        background-color: #555;
        border-radius: 4px;
      }
    `:`
      html {
        filter: invert(1) hue-rotate(180deg) !important;
        background-color: #e0e0e0 !important;
      }
    
      img, video, canvas, svg {
        filter: invert(1) hue-rotate(180deg) !important;
      }
      [style*="background-image"] {
        filter: invert(1) hue-rotate(180deg) !important;
      }
      ::-webkit-scrollbar {
        background-color: #2c2c2c;
      }
      ::-webkit-scrollbar-track {
        background-color: #2c2c2c;
      }
      ::-webkit-scrollbar-thumb {
        background-color: #555;
        border-radius: 4px;
      }
    `,_="wxrd-dark-mode-filter";if(d)B("wxrd-dark-mode-filter",C);else Q("wxrd-dark-mode-filter")}initDarkMode(){this.applyTheme(this.shouldEnableDarkMode()),window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",(d)=>{this.applyTheme(d.matches)})}init(){this.initLinks(),this.initDarkMode()}}class D{isWide=!1;isHideToolbar=!1;constructor(){this.init()}init(){this.handleTheme(),b.subscribe((d)=>{this.updateStyles(d)})}handleTheme(){let p=(C)=>{if(C.matches)B("wxrd-base-bg",`
          html, body {
              background-color: #222222 !important;
          }
      `);else B("wxrd-base-bg",`
          html, body {
              background-color: #ffffff !important;
          }
      `)},x=window.matchMedia("(prefers-color-scheme: dark)");p(x),x.addEventListener("change",p)}updateStyles(d){let h=!!d.readerWide,p=!!d.hideToolbar;if(h!==this.isWide||p!==this.isHideToolbar)this.isWide=h,this.isHideToolbar=p,this.applyStyles()}applyStyles(){if(this.isWide)B("wxrd-wide-mode",`
    /* 基础逻辑：宽屏模式 */
    .readerTopBar,
    body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
      width: 96% !important;
      max-width: calc(100vw - 224px) !important;
    }
    .app_content {
      max-width: calc(100vw - 224px) !important;
    }
    body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
      margin-left: calc(50vw - 80px) !important;
    }
  `);else B("wxrd-wide-mode",`
    /* 基础逻辑：窄屏模式 */
    .readerTopBar,
    body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
      width: 80% !important;
      max-width: calc(100vw - 424px) !important;
    }
    .app_content {
      max-width: calc(100vw - 424px) !important;
    }
    body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
      margin-left: calc(50vw - 180px) !important;
    }
  `);if(this.isHideToolbar)B("wxrd-hide-toolbar",`
    /* 1. 基础逻辑：无论单栏双栏，都隐藏工具栏 */
    .readerControls {
      display: none !important;
    }

    /* 2. 双栏模式特有逻辑，请勿修改！！！ */
    .readerTopBar,
    body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
      max-width: calc(100vw - 124px) !important;
    }

    /* 3. 单栏模式特有逻辑，请勿删除！！！ */
    .app_content {
      max-width: calc(100vw - 124px) !important;
    }
  `);else B("wxrd-hide-toolbar",`
    /* 1. 基础逻辑：显示工具栏 */
    .readerControls {
      display: block !important;
    }

    /* 2. 双栏模式特有逻辑，请勿修改！！！ */
    .readerTopBar,
    body:has(.readerControls[is-horizontal="true"]) .readerChapterContent {
      max-width: calc(100vw - 224px) !important;
    }

    /* 3. 单栏模式特有逻辑，请勿删除！！！ */
    .app_content {
      max-width: calc(100vw - 224px) !important;
    }
    body:has(.readerControls:not([is-horizontal="true"])) .readerControls {
      margin-left: calc(50vw - 80px) !important;
    }
  `);window.dispatchEvent(new Event("resize"))}}class L{isActive=!1;intervalSeconds=30;keepAwake=!1;doubleTimer=null;singleRafId=null;lastFrameTime=0;accumulatedMove=0;countdown=30;originalTitle=null;appName="微信阅读";constructor(){this.init()}async init(){try{this.appName=await E("get_app_name")||"微信阅读"}catch(d){console.error("TurnerManager: Failed to get app name",d)}b.subscribe((d)=>{this.updateState(d)}),window.addEventListener("wxrd:route-changed",(d)=>{if(!d.detail.isReader)this.stopAll();else if(b.get().autoFlip?.active)this.start()})}updateState(d){let h=d.autoFlip||{active:!1,interval:30,keepAwake:!0},p=!!h.active,x=h.interval>0?h.interval:30,C=!!h.keepAwake;if(!p){if(this.isActive)this.stopAll()}else if(this.isActive){if(this.intervalSeconds!==x||this.keepAwake!==C)this.stopAll(),this.intervalSeconds=x,this.keepAwake=C,this.start()}else this.intervalSeconds=x,this.keepAwake=C,this.start();this.isActive=p}start(){if(this.isDoubleColumn())this.startDoubleColumnLogic();else this.startSingleColumnLogic()}isDoubleColumn(){return!!document.querySelector('.readerControls[is-horizontal="true"]')}stopAll(){if(this.doubleTimer)clearInterval(this.doubleTimer),this.doubleTimer=null;if(this.singleRafId)cancelAnimationFrame(this.singleRafId),this.singleRafId=null;if(this.originalTitle)document.title=this.originalTitle,this.originalTitle=null}startDoubleColumnLogic(){if(this.doubleTimer)return;if(this.singleRafId)cancelAnimationFrame(this.singleRafId),this.singleRafId=null;if(this.countdown=this.intervalSeconds,!this.originalTitle)this.originalTitle=document.title;this.doubleTimer=setInterval(()=>{if(!this.isDoubleColumn()){this.stopAll(),this.startSingleColumnLogic();return}if(document.hidden&&!this.keepAwake)return;if(this.countdown--,document.title=`${this.appName} - 自动翻页 - ${this.countdown} 秒`,this.countdown<=0)A("Right"),this.countdown=this.intervalSeconds},1000)}startSingleColumnLogic(){if(this.singleRafId)return;if(this.doubleTimer)clearInterval(this.doubleTimer),this.doubleTimer=null;if(this.originalTitle)document.title=this.originalTitle,this.originalTitle=null;this.lastFrameTime=performance.now();let d=(h)=>{if(this.isDoubleColumn()){this.stopAll(),this.startDoubleColumnLogic();return}if(!this.isActive)return;let p=h-this.lastFrameTime;if(this.lastFrameTime=h,p>100)p=16;if(document.hidden&&!this.keepAwake){this.singleRafId=requestAnimationFrame(d);return}let x=window.innerHeight,C=this.intervalSeconds>0?this.intervalSeconds:30,z=x*2/(C*1000)*p;if(this.accumulatedMove+=z,this.accumulatedMove>=1){let O=Math.floor(this.accumulatedMove);window.scrollBy(0,O),this.accumulatedMove-=O;let I=document.documentElement.scrollHeight;if(window.innerHeight+window.scrollY>=I-5){let j=Date.now()}}this.singleRafId=requestAnimationFrame(d)};this.singleRafId=requestAnimationFrame(d)}}class G{constructor(){this.init()}init(){}}class R{appName="微信阅读";constructor(){this.init()}async init(){await w();try{this.appName=await E("get_app_name")||"微信阅读"}catch(d){console.error("Failed to get app name:",d)}await b.init(),this.restoreLastPage(),this.monitorRoute(),this.monitorTitle()}restoreLastPage(){let d=b.get();if(!window.location.href.includes("/web/reader/")&&d.rememberLastPage&&d.lastReaderUrl)console.log("Restoring last page:",d.lastReaderUrl),window.location.href=d.lastReaderUrl}monitorRoute(){let d=()=>{let x=window.location.href.includes("/web/reader/");this.updateTitle();let C=b.get();if(C.rememberLastPage){if(x){let _=window.location.href;if(C.lastReaderUrl!==_)b.update({lastReaderUrl:_})}else if(C.lastReaderUrl)b.update({lastReaderUrl:null})}else if(C.lastReaderUrl)b.update({lastReaderUrl:null});window.dispatchEvent(new CustomEvent("wxrd:route-changed",{detail:{isReader:x}}))};window.addEventListener("popstate",d);let h=history.pushState;history.pushState=function(...x){let C=h.apply(this,x);return d(),C};let p=history.replaceState;history.replaceState=function(...x){let C=p.apply(this,x);return d(),C},d()}monitorTitle(){let d=document.querySelector("title");if(d)new MutationObserver(()=>{this.updateTitle()}).observe(d,{childList:!0,characterData:!0,subtree:!0})}updateTitle(){if(window.location.pathname==="/")E("set_title",{title:this.appName});else if(document.title&&document.title.trim()!=="")E("set_title",{title:document.title})}}(function(){if(window.wxrd_injected){console.log("Weixin Reader Inject Script already loaded. Skipping.");return}window.wxrd_injected=!0,console.log("Weixin Reader Inject Script Initializing...");let d=window.location.href.includes("/web/reader/");if(new R,new W,!d)new f;new D,new L,new G,console.log("Weixin Reader Inject Script Loaded (Modular v2)")})();
