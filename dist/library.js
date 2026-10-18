/* Same gallery/editor code runs in the browser and the macOS shell. */
let activeSavedProject=null,activeSavedBackend=null,savedProjectRevision=null,savedProjectFingerprint='',galleryItems=[],draftWrite=Promise.resolve(),workspaceBootstrapped=false,gallerySaveTask=null;
const isDesktop=!!globalThis.STUDIO_DESKTOP;
if(isDesktop){bridgeToken=globalThis.STUDIO_DESKTOP.token;bridgeURL='ws://127.0.0.1:'+globalThis.STUDIO_DESKTOP.port;}
async function studioNative(action,args={}){return window.webkit.messageHandlers.studio.postMessage({action,...args});}
async function libraryAPI(route,options={}){
 if(!bridgeToken)throw Error('AI設定のローカル接続トークンを設定してください。');
 const response=await fetch(route,{...options,headers:{'Content-Type':'application/json','Authorization':'Bearer '+bridgeToken,...options.headers}}),value=await response.json();if(!response.ok){const e=Error(value.error||'保存に失敗しました');e.status=response.status;throw e;}return value;
}
function usesFileLibrary(){return isDesktop||localConnected&&!!bridgeToken;}
function libraryBackend(){return usesFileLibrary()?'file':'browser';}
async function browserLibrary(method,id,value){
 if(!db)throw Error('ブラウザの保存領域が使えません。.slideに書き出してください。');
 if(method==='list'){const records=await new Promise((resolve,reject)=>{const r=db.transaction('workspace').objectStore('workspace').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});return{items:records.filter(r=>r?._studioSaved===true).map(({deck,...r})=>({...r,slideCount:deck.slides.length,titles:deck.slides.map(s=>[s.title,...(s.elements||[]).filter(e=>e.type==='text').map(e=>e.text)].join(' ').slice(0,2000))})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))};}
 if(method==='get'){const r=await stored('saved:'+id);if(!r)throw Error('保存したスライドが見つかりません。');return r;}
 return new Promise((resolve,reject)=>{const tx=db.transaction('workspace','readwrite'),store=tx.objectStore('workspace'),key='saved:'+(id||uid()),read=store.get(key);let result;read.onsuccess=()=>{const old=read.result;if(id&&(!old||old.revision!==value.expectedRevision)){tx.abort();return;}const now=new Date().toISOString();result={_studioSaved:true,id:key.slice(6),...value,createdAt:old?.createdAt||now,updatedAt:now,revision:(old?.revision||0)+1,name:value.deck.name};delete result.expectedRevision;store.put(result,key);};tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(Error('別の画面で更新されています。別名で保存してください。'));tx.onerror=()=>reject(tx.error);});
}
async function listSaved(){return usesFileLibrary()?libraryAPI('/api/library'):browserLibrary('list');}
async function getSaved(id){return usesFileLibrary()?libraryAPI('/api/library/'+encodeURIComponent(id)):browserLibrary('get',id);}
function takeProjectSnapshot(){finishInlineText();if(dirtySource)throw Error('deck.jsonの変更を適用してから保存してください。');return structuredClone(validate(deck));}
function singleSlideProject(source,slideIndex){const d=structuredClone(source),s=d.slides[slideIndex];if(!s)throw Error('スライドがありません。');const ids=new Set([s.assetId,...(s.elements||[]).map(e=>e.assetId)].filter(Boolean));d.slides=[s];d.assets=d.assets.filter(a=>ids.has(a.id));d.name=(!s.title||s.title==='新しいスライド'?s.elements?.find(e=>e.type==='text'&&e.text.trim())?.text.split('\n')[0]:s.title)||source.name+' / '+(slideIndex+1);return d;}
// Materialize relative and temporary media before saving, so old projects remain portable.
async function makePortableProject(d){for(const a of d.assets){if(a.src.startsWith('media/')||a.src.startsWith('blob:')){const response=await fetch(a.src);if(!response.ok)throw Error('素材を読み込めません: '+a.name);const blob=await response.blob();a.src=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('素材の保存に失敗しました: '+a.name));r.readAsDataURL(blob);});}}return d;}
function saveToGallery(options={}){const job=(gallerySaveTask||Promise.resolve()).catch(()=>{}).then(()=>commitGallerySave(options));gallerySaveTask=job;job.then(()=>{if(gallerySaveTask===job)gallerySaveTask=null;},()=>{if(gallerySaveTask===job)gallerySaveTask=null;});return job;}
async function commitGallerySave({copy=false,single=false,quiet=false}={}){
 const source=takeProjectSnapshot(),originalId=activeSavedProject,originalRevision=savedProjectRevision;
 const d=await makePortableProject(single?singleSlideProject(source,index):structuredClone(source));
 let preview='';try{const svg=await slideSVG();if(svg.length<500000)preview='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);}catch{}
 const body={deck:d,kind:single?'slide':'project',preview,...(!copy&&!single&&originalId&&activeSavedBackend===libraryBackend()?{id:originalId,expectedRevision:originalRevision}:{})};
 let result;
 try{result=usesFileLibrary()?await libraryAPI('/api/library',{method:'POST',body:JSON.stringify(body)}):await browserLibrary('save',body.id,body);}catch(e){if(e.status===409){showModal('<h2>保存先が更新されています</h2><p>現在の編集内容は画面と下書きに残っています。別名で保存すると両方の版を保持できます。</p><div class="modal-actions"><button data-action="close-modal">編集に戻る</button><button class="primary" data-action="save-project-copy">別名で保存</button></div>');}throw e;}
 if(!single){activeSavedProject=result.id;activeSavedBackend=libraryBackend();savedProjectRevision=result.revision;savedProjectFingerprint=JSON.stringify(source);}
 await persistWorkspace();if(!quiet)toast(single?'この1枚を保存一覧へ追加しました':'保存一覧に保存しました');return result;
}
async function persistWorkspace(){
 if(!workspaceBootstrapped||!usesFileLibrary())return;
 const state={deck:structuredClone(deck),index,activeId:activeSavedProject,activeRevision:savedProjectRevision,preferences:{aiProvider,codexModel,aiModel}};
 const run=draftWrite.catch(()=>{}).then(()=>libraryAPI('/api/workspace',{method:'PUT',body:JSON.stringify(state)}));draftWrite=run;await run;
}
const browserAutoSave=saveDeck;
saveDeck=async function(){await browserAutoSave();try{await persistWorkspace();if(usesFileLibrary())$('#save-state').textContent='下書き保存済み';}catch(e){$('#save-state').textContent='下書き保存失敗';log(e.message,'warn');}};
async function preserveBeforeSwitch(){takeProjectSnapshot();if(!savedProjectFingerprint||savedProjectFingerprint!==JSON.stringify(deck))await saveToGallery({quiet:true});}
function resetSavedIdentity(){activeSavedProject=null;activeSavedBackend=null;savedProjectRevision=null;savedProjectFingerprint='';}
async function openSavedProject(id){await preserveBeforeSwitch();const r=await getSaved(id);validate(r.deck);deck=structuredClone(r.deck);activeSavedProject=r.id;activeSavedBackend=libraryBackend();savedProjectRevision=r.revision;savedProjectFingerprint=JSON.stringify(deck);index=0;selection.clear();history=[];future=[];dirtySource=false;closeModal();changed();await persistWorkspace();toast('保存したスライドを開きました');}
function insertSavedSlides(record){
 validate(record.deck);if(deck.slides.length+record.deck.slides.length>500)throw Error('スライドは最大500枚です。');snapshot();
 const assetMap=new Map();for(const a of record.deck.assets){const existing=deck.assets.find(x=>x.src===a.src&&x.type===a.type);const id=existing?.id||uid();assetMap.set(a.id,id);if(!existing)deck.assets.push({...structuredClone(a),id});}
 const source=structuredClone(record.deck),editingDeck=deck;deck=source;try{source.slides.forEach(s=>freeFromTemplate(s));}finally{deck=editingDeck;}const added=source.slides;for(const s of added){s.id=uid();if(s.assetId)s.assetId=assetMap.get(s.assetId)||'';const groups=new Map();for(const e of s.elements||[]){e.id=uid();if(e.assetId)e.assetId=assetMap.get(e.assetId)||'';if(e.groupId){if(!groups.has(e.groupId))groups.set(e.groupId,uid());e.groupId=groups.get(e.groupId);}}if(s.elements&&!s.background)s.background=record.deck.theme.background;}
 deck.slides.splice(index+1,0,...added);index++;selection.clear();changed();closeModal();toast(added.length+'枚を追加しました');
}
async function showGallery(){finishInlineText();showModal('<div class="saved-gallery"><h2>保存したスライド</h2><p>読み込み中…</p></div>');try{const r=await listSaved();galleryItems=r.items;renderGallery();if(r.warnings?.length)toast(r.warnings.length+'件のファイルは読み込めませんでした。元ファイルは保持しています。');}catch(e){$('#modal-body').innerHTML='<h2>保存したスライド</h2><p>'+esc(e.message)+'</p><div class="modal-actions"><button data-action="ai-settings">接続設定</button><button data-action="close-modal">閉じる</button></div>';}}
function renderGallery(){
 const name=usesFileLibrary()?'Mac内にファイル保存':'このブラウザ内に保存';
 $('#modal-body').innerHTML=`<div class="saved-gallery"><div class="gallery-heading"><div><h2>保存したスライド</h2><p>${name} · 発表全体と1枚ずつの保存</p></div><button data-action="close-modal">編集に戻る</button></div><div class="gallery-tools"><button class="primary" data-action="save-project-gallery">現在の発表を保存</button><button data-action="save-single-slide">この1枚を保存</button><button data-action="save-project-copy">別名で保存</button><button data-action="new-project">＋ 新しい発表</button><button data-action="import">.slideを取り込む</button></div><label class="gallery-search">検索 <input id="gallery-search" placeholder="名前・スライドの見出し" type="search"></label><div class="gallery-filters"><button data-gallery-kind="all" class="active">すべて</button><button data-gallery-kind="project">発表</button><button data-gallery-kind="slide">1枚のスライド</button></div><div id="gallery-grid" class="gallery-grid"></div><p class="gallery-note">⌘ Sで一覧へ保存。編集中は下書きも自動保存します。共同作業では.slideを渡せます。同じ保存先の変更競合は検出しますが、リアルタイム共同編集は未対応です。</p></div>`;
 let kind='all';const render=()=>{const q=$('#gallery-search').value.toLocaleLowerCase(),items=galleryItems.filter(r=>(kind==='all'||r.kind===kind)&&(r.name+' '+r.titles.join(' ')).toLocaleLowerCase().includes(q));$('#gallery-grid').innerHTML=items.length?items.map(r=>`<article class="gallery-card">${r.preview?`<img class="gallery-preview" loading="lazy" src="${esc(r.preview)}" alt="${esc(r.name)}のプレビュー">`:`<div class="gallery-preview gallery-placeholder">${esc(r.titles[0]||r.name)}</div>`}<div class="gallery-card-body"><span class="gallery-badge">${r.kind==='slide'?'1枚保存':'発表 · '+r.slideCount+'枚'}</span><h3>${esc(r.name)}</h3><small>${new Date(r.updatedAt).toLocaleString('ja-JP')} · v${r.revision}</small><div><button data-gallery-open="${esc(r.id)}">開く</button><button data-gallery-insert="${esc(r.id)}">今の発表に追加</button></div></div></article>`).join(''):'<div class="gallery-empty">保存したスライドはまだありません。<br>「現在の発表を保存」か「この1枚を保存」から追加できます。</div>';};$('#gallery-search').addEventListener('input',render);$$('[data-gallery-kind]').forEach(b=>b.addEventListener('click',()=>{kind=b.dataset.galleryKind;$$('[data-gallery-kind]').forEach(x=>x.classList.toggle('active',x===b));render();}));render();
}
Object.assign(actions,{
 'saved-gallery':showGallery,
 'save-project-gallery':async()=>{await saveToGallery();if($('.saved-gallery'))await showGallery();},
 'save-single-slide':async()=>{await saveToGallery({single:true});if($('.saved-gallery'))await showGallery();},
 'save-project-copy':async()=>{await saveToGallery({copy:true});closeModal();await showGallery();},
 'new-project':async()=>{await preserveBeforeSwitch();deck=sample();deck.name='新しい発表';deck.slides=[newSlide('free')];deck.slides[0].elements=[];deck.slides[0].body='';deck.assets=[];index=0;selection.clear();history=[];future=[];resetSavedIdentity();closeModal();changed();await persistWorkspace();},
});
const projectImporter=importProject;
importProject=async function(file){await preserveBeforeSwitch();const before=deck;await projectImporter(file);if(deck!==before){resetSavedIdentity();closeModal();await persistWorkspace();}};
document.addEventListener('click',ev=>{const open=ev.target.closest('[data-gallery-open]'),insert=ev.target.closest('[data-gallery-insert]');if(!open&&!insert)return;Promise.resolve().then(async()=>open?openSavedProject(open.dataset.galleryOpen):insertSavedSlides(await getSaved(insert.dataset.galleryInsert))).catch(e=>toast(e.message));});
document.addEventListener('keydown',ev=>{if((ev.metaKey||ev.ctrlKey)&&ev.key.toLowerCase()==='s'){ev.preventDefault();ev.stopImmediatePropagation();saveToGallery({copy:ev.shiftKey}).catch(e=>toast(e.message));}},true);
async function workspaceBootstrap(){
 if(workspaceBootstrapped||isPresenter)return;workspaceBootstrapped=true;
 const button=document.createElement('button');button.dataset.action='saved-gallery';button.textContent='▦ 保存一覧';$('.header-actions').prepend(button);
 const save=document.createElement('button');save.dataset.action='save-project-gallery';save.textContent='保存';$('.header-actions').prepend(save);
 const oldExport=actions['export-menu'];actions['export-menu']=function(){oldExport();const b=document.createElement('button');b.className='export-option';b.dataset.action='save-project-gallery';b.innerHTML='<strong>保存一覧へ保存</strong><small>発表全体を保存して、あとから一覧から開く。</small>';$('#modal-body').prepend(b);};
 if(isDesktop){
  try{const r=await libraryAPI('/api/workspace');if(r.workspace){deck=validate(r.workspace.deck);index=Math.min(r.workspace.index||0,deck.slides.length-1);activeSavedProject=r.workspace.activeId;activeSavedBackend='file';savedProjectRevision=r.workspace.activeRevision;const preferences=r.workspace.preferences||{};aiProvider=preferences.aiProvider||'codex';codexModel=preferences.codexModel||'';aiModel=preferences.aiModel||aiModel;selection.clear();renderAll();}await showGallery();}catch(e){log(e.message,'warn');toast(e.message);}
  download=async function(name,content,type='application/json'){try{const blob=content instanceof Blob?content:new Blob([content],{type}),bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));await studioNative('save',{name,data:btoa(binary)});}catch(e){toast('書き出しに失敗しました: '+e.message);}};
  window.print=()=>studioNative('print');
  actions['export-pdf']=async()=>{finishInlineText();const css=await loadCSS();const pages=deck.slides.map((s,i)=>`<section class="print-page">${slideHTML(s,{number:i})}</section>`).join('');await studioNative('printHTML',{html:`<!doctype html><html><head><meta charset="utf-8"><style>${css} @page{size:320mm 180mm;margin:0}body{overflow:visible;background:white;margin:0}.print-page{width:320mm;height:180mm;break-after:page;page-break-after:always}.print-page:last-child{break-after:auto}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}video,audio{display:none}</style></head><body>${pages}</body></html>`});};
  const nativePresent=startPresent,nativeExit=exitPresent;startPresent=()=>{nativePresent();studioNative('fullscreen',{enabled:true});};exitPresent=()=>{nativeExit();studioNative('fullscreen',{enabled:false});};actions.present=startPresent;actions['exit-present']=exitPresent;
 }
 globalThis.studioOpenFile=async(name,text)=>importProject({name,text:async()=>text});
 globalThis.studioSaveAndClose=async()=>{try{finishInlineText();if(gallerySaveTask)await gallerySaveTask;await persistWorkspace();await studioNative('closeReady');}catch(e){toast(e.message);}};
}
if(globalThis.STUDIO_EDITOR_READY)workspaceBootstrap();
