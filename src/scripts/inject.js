var E=(p,h)=>{if(window.__TAURI__)return window.__TAURI__.core.invoke(p,h);return console.warn(`[Tauri] Invoke '${p}' failed: API not found`),Promise.resolve({})},T=(p,h)=>{if(window.__TAURI__)return window.__TAURI__.event.listen(p,h);return console.warn(`[Tauri] Listen '${p}' failed: API not found`),Promise.resolve(()=>{})};var z=()=>{return new Promise((p)=>{if(window.__TAURI__){p();return}let h=setInterval(()=>{if(window.__TAURI__)clearInterval(h),p()},10);setTimeout(()=>{clearInterval(h),p()},2000)})};class H{static instance;settings={};listeners=new Set;initialized=!1;constructor(){}static getInstance(){if(!H.instance)H.instance=new H;return H.instance}async init(){if(this.initialized)return;try{let p=await E("get_settings")||{};this.settings={readerWide:!1,hideToolbar:!1,zoom:0.8,rememberLastPage:!0,autoUpdate:!0,...p,autoFlip:{active:!1,interval:30,keepAwake:!0,...p.autoFlip||{}}}}catch(p){console.error("SettingsStore: Failed to load settings",p),this.settings={readerWide:!1,hideToolbar:!1,zoom:0.8,rememberLastPage:!0,autoUpdate:!0,autoFlip:{active:!1,interval:30,keepAwake:!0}}}T("settings-updated",async()=>{let p=await E("get_settings")||{};this.updateLocal({readerWide:!1,hideToolbar:!1,zoom:0.8,rememberLastPage:!0,autoUpdate:!0,...p,autoFlip:{active:!1,interval:30,keepAwake:!0,...p.autoFlip||{}}})}),this.initialized=!0,this.notify()}get(){return{...this.settings}}async update(p){this.settings={...this.settings,...p};try{await E("save_settings",{settings:p})}catch(h){console.error("SettingsStore: Failed to save settings",h)}this.notify()}subscribe(p){if(this.listeners.add(p),this.initialized)p(this.get());return()=>this.listeners.delete(p)}updateLocal(p){this.settings=p,this.notify()}notify(){let p=this.get();this.listeners.forEach((h)=>h(p))}}var b=H.getInstance();class f{isReader=!1;constructor(){this.init()}async init(){await z(),await b.init(),T("menu-action",(p)=>{this.handleMenuAction(p.payload)}),window.addEventListener("wxrd:route-changed",(p)=>{this.isReader=p.detail.isReader,this.syncMenuState()}),b.subscribe((p)=>{if(this.syncMenuState(p),p.zoom)E("set_zoom",{value:p.zoom})})}syncMenuState(p=b.get()){let h=!!p.readerWide,d=!!p.hideToolbar,x=!!p.autoFlip?.active,C=(_,W,O)=>{E("set_menu_item_enabled",{id:_,enabled:O}).then(()=>{E("update_menu_state",{id:_,state:W})})};C("reader_wide",h,this.isReader),C("hide_toolbar",d,this.isReader),C("auto_flip",x,this.isReader)}handleMenuAction(p){let h=b.get();switch(p){case"reader_wide":{let d=!h.readerWide,x={readerWide:d};if(!d&&h.hideToolbar)x.hideToolbar=!1;b.update(x)}break;case"hide_toolbar":b.update({hideToolbar:!h.hideToolbar});break;case"auto_flip":{let d=h.autoFlip||{active:!1,interval:30,keepAwake:!0},x=!d.active;b.update({autoFlip:{...d,active:x}})}break;case"zoom_in":{let d=h.zoom||1;d=Math.round((d+0.1)*10)/10,b.update({zoom:d})}break;case"zoom_out":{let d=h.zoom||1;if(d=Math.round((d-0.1)*10)/10,d<0.1)d=0.1;b.update({zoom:d})}break;case"zoom_reset":b.update({zoom:1});break}}}function B(p,h){let d=document.getElementById(p);if(!d)if(d=document.createElement("style"),d.id=p,document.head)document.head.appendChild(d);else if(document.documentElement)document.documentElement.appendChild(d);else{let x=new MutationObserver((C)=>{for(let _ of C)if(_.addedNodes.length>0){if(document.head){document.head.appendChild(d),x.disconnect();return}else if(document.documentElement){document.documentElement.appendChild(d),x.disconnect();return}}});x.observe(document,{childList:!0})}d.innerHTML=h}function Q(p){let h=document.getElementById(p);if(h)h.remove()}function A(p){let d={Right:"ArrowRight",Left:"ArrowLeft"}[p]||p,x=d==="ArrowRight"?39:37,C=new KeyboardEvent("keydown",{key:d,code:d,keyCode:x,which:x,bubbles:!0,cancelable:!0});document.dispatchEvent(C);let _=new KeyboardEvent("keyup",{key:d,code:d,keyCode:x,which:x,bubbles:!0,cancelable:!0});document.dispatchEvent(_)}class w{constructor(){this.init()}initLinks(){window.open=function(p,h,d){if(p)window.location.href=p.toString();return null},document.addEventListener("click",(p)=>{let d=p.target.closest("a");if(d&&d.target==="_blank")d.target="_self"},!0)}shouldEnableDarkMode(){return window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches}applyTheme(p){let h=window.self!==window.top,d=`
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
    `,_="wxrd-dark-mode-filter";if(p)B("wxrd-dark-mode-filter",C);else Q("wxrd-dark-mode-filter")}initDarkMode(){this.applyTheme(this.shouldEnableDarkMode()),window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",(p)=>{this.applyTheme(p.matches)})}init(){this.initLinks(),this.initDarkMode()}}class D{isWide=!1;isHideToolbar=!1;constructor(){this.init()}init(){this.handleTheme(),b.subscribe((p)=>{this.updateStyles(p)})}handleTheme(){let d=(C)=>{if(C.matches)B("wxrd-base-bg",`
          html, body {
              background-color: #222222 !important;
          }
      `);else B("wxrd-base-bg",`
          html, body {
              background-color: #ffffff !important;
          }
      `)},x=window.matchMedia("(prefers-color-scheme: dark)");d(x),x.addEventListener("change",d)}updateStyles(p){let h=!!p.readerWide,d=!!p.hideToolbar;if(h!==this.isWide||d!==this.isHideToolbar)this.isWide=h,this.isHideToolbar=d,this.applyStyles()}applyStyles(){if(this.isWide)B("wxrd-wide-mode",`
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
  `);window.dispatchEvent(new Event("resize"))}}class L{isActive=!1;intervalSeconds=30;keepAwake=!1;doubleTimer=null;singleRafId=null;lastFrameTime=0;accumulatedMove=0;countdown=30;originalTitle=null;appName="微信阅读";constructor(){this.init()}async init(){try{this.appName=await E("get_app_name")||"微信阅读"}catch(p){console.error("TurnerManager: Failed to get app name",p)}b.subscribe((p)=>{this.updateState(p)}),window.addEventListener("wxrd:route-changed",(p)=>{if(!p.detail.isReader)this.stopAll();else if(b.get().autoFlip?.active)this.start()})}updateState(p){let h=p.autoFlip||{active:!1,interval:30,keepAwake:!0},d=!!h.active,x=h.interval>0?h.interval:30,C=!!h.keepAwake;if(!d){if(this.isActive)this.stopAll()}else if(this.isActive){if(this.intervalSeconds!==x||this.keepAwake!==C)this.stopAll(),this.intervalSeconds=x,this.keepAwake=C,this.start()}else this.intervalSeconds=x,this.keepAwake=C,this.start();this.isActive=d}start(){if(this.isDoubleColumn())this.startDoubleColumnLogic();else this.startSingleColumnLogic()}isDoubleColumn(){return!!document.querySelector('.readerControls[is-horizontal="true"]')}stopAll(){if(this.doubleTimer)clearInterval(this.doubleTimer),this.doubleTimer=null;if(this.singleRafId)cancelAnimationFrame(this.singleRafId),this.singleRafId=null;if(this.originalTitle)document.title=this.originalTitle,this.originalTitle=null}startDoubleColumnLogic(){if(this.doubleTimer)return;if(this.singleRafId)cancelAnimationFrame(this.singleRafId),this.singleRafId=null;if(this.countdown=this.intervalSeconds,!this.originalTitle)this.originalTitle=document.title;this.doubleTimer=setInterval(()=>{if(!this.isDoubleColumn()){this.stopAll(),this.startSingleColumnLogic();return}if(document.hidden&&!this.keepAwake)return;if(this.countdown--,document.title=`${this.appName} - 自动翻页 - ${this.countdown} 秒`,this.countdown<=0)A("Right"),this.countdown=this.intervalSeconds},1000)}startSingleColumnLogic(){if(this.singleRafId)return;if(this.doubleTimer)clearInterval(this.doubleTimer),this.doubleTimer=null;if(this.originalTitle)document.title=this.originalTitle,this.originalTitle=null;this.lastFrameTime=performance.now();let p=(h)=>{if(this.isDoubleColumn()){this.stopAll(),this.startDoubleColumnLogic();return}if(!this.isActive)return;let d=h-this.lastFrameTime;if(this.lastFrameTime=h,d>100)d=16;if(document.hidden&&!this.keepAwake){this.singleRafId=requestAnimationFrame(p);return}let x=window.innerHeight,C=this.intervalSeconds>0?this.intervalSeconds:30,W=x*2/(C*1000)*d;if(this.accumulatedMove+=W,this.accumulatedMove>=1){let O=Math.floor(this.accumulatedMove);window.scrollBy(0,O),this.accumulatedMove-=O;let I=document.documentElement.scrollHeight;if(window.innerHeight+window.scrollY>=I-5){let q=Date.now()}}this.singleRafId=requestAnimationFrame(p)};this.singleRafId=requestAnimationFrame(p)}}class G{constructor(){this.init()}init(){}}class R{appName="微信阅读";constructor(){this.init()}async init(){await z();try{this.appName=await E("get_app_name")||"微信阅读"}catch(p){console.error("Failed to get app name:",p)}await b.init(),this.restoreLastPage(),this.monitorRoute(),this.monitorTitle()}restoreLastPage(){let p=b.get();if(!window.location.href.includes("/web/reader/")&&p.rememberLastPage&&p.lastReaderUrl)console.log("Restoring last page:",p.lastReaderUrl),window.location.href=p.lastReaderUrl}monitorRoute(){let p=()=>{let x=window.location.href.includes("/web/reader/");this.updateTitle();let C=b.get();if(C.rememberLastPage){if(x){let _=window.location.href;if(C.lastReaderUrl!==_)b.update({lastReaderUrl:_})}else if(C.lastReaderUrl)b.update({lastReaderUrl:null})}else if(C.lastReaderUrl)b.update({lastReaderUrl:null});window.dispatchEvent(new CustomEvent("wxrd:route-changed",{detail:{isReader:x}}))};window.addEventListener("popstate",p);let h=history.pushState;history.pushState=function(...x){let C=h.apply(this,x);return p(),C};let d=history.replaceState;history.replaceState=function(...x){let C=d.apply(this,x);return p(),C},p()}monitorTitle(){let p=document.querySelector("title");if(p)new MutationObserver(()=>{this.updateTitle()}).observe(p,{childList:!0,characterData:!0,subtree:!0})}updateTitle(){if(window.location.pathname==="/")E("set_title",{title:this.appName});else if(document.title&&document.title.trim()!=="")E("set_title",{title:document.title})}}(function(){if(window.wxrd_injected){console.log("Weixin Reader Inject Script already loaded. Skipping.");return}window.wxrd_injected=!0,console.log("Weixin Reader Inject Script Initializing...");let p=window.location.href.includes("/web/reader/");if(new R,new f,!p)new w;new D,new L,new G,console.log("Weixin Reader Inject Script Loaded (Modular v2)")})();
