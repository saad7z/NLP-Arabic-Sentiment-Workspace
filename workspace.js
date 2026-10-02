'use strict';
const FileTools = typeof module!=='undefined' ? require('./files.js') : globalThis.DataFiles;
const WorkspaceCore = (() => {
  const normalize = text => String(text).normalize('NFC').replace(/\s+/gu,' ').trim();
  function validURL(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&!/\s/u.test(value);}catch{return false;}}
  function rawCheck(parsed,config){
    const names=new Set(parsed.headers.map(h=>h.toLowerCase()));
    const has=choices=>choices.some(h=>names.has(h.toLowerCase()));
    if(!parsed.records.length)throw new Error('The raw file has no examples.');
    if(!has(config.text_columns)||!(has(config.url_columns)||has(config.page_url_columns)))throw new Error('The raw file needs text and source URL columns.');
  }
  function classifiedCheck(parsed,catalog){
    if(FileTools.work.some(h=>!parsed.headers.includes(h)))throw new Error('Use a prepared file from this workspace. Keep its required columns.');
    if(!parsed.records.length)throw new Error('The classified file has no examples.');
    const originals=new Map(catalog.records.map(row=>[String(row.ID),row])),ids=new Set(),batches=new Set(),texts=new Set();
    const rows=parsed.records.map((submitted,index)=>{
      const row={...submitted,ID:String(submitted.ID).trim()},original=originals.get(row.ID),number=index+2;
      if(!original||ids.has(row.ID))throw new Error('Unknown or repeated ID at row '+number+'.');
      ids.add(row.ID);batches.add(original.Batch);
      if(row.Contributor&&row.Contributor!==original.Contributor)throw new Error('Keep the original Contributor at row '+number+'.');
      if(row.Batch&&row.Batch!==original.Batch)throw new Error('Keep the original Batch at row '+number+'.');
      const label=String(row.Sentiment).trim().toLowerCase();
      row.Sentiment=({positive:'Positive',negative:'Negative',neutral:'Neutral',unsure:'Not sure','not sure':'Not sure'})[label]||'';
      row.Exclude=String(row.Exclude).trim().toLowerCase()==='yes'?'Yes':String(row.Exclude).trim().toLowerCase()==='no'||!String(row.Exclude).trim()?'No':'';
      if(!row.Exclude)throw new Error('Choose Yes or No for Exclude at row '+number+'.');
      if(row.Exclude==='Yes'){if(!String(row.Notes).trim())throw new Error('Explain the exclusion in Notes at row '+number+'.');}
      else{
        if(!row.Sentiment)throw new Error('Choose a sentiment at row '+number+'.');
        if(!/[\u0621-\u063a\u0641-\u064a]/u.test(row.Text)||!String(row.Source).trim()||!validURL(row.SourceURL))throw new Error('Keep Arabic text, a source, and a valid source URL at row '+number+'.');
        const key=normalize(row.Text);if(texts.has(key))throw new Error('Repeated text at row '+number+'. Mark the repeated row Exclude=Yes.');texts.add(key);
      }
      return row;
    });
    if(batches.size!==1)throw new Error('Publish one prepared batch at a time.');
    const batch=[...batches][0],expected=catalog.records.filter(row=>row.Batch===batch);
    if(expected.length!==ids.size||expected.some(row=>!ids.has(String(row.ID))))throw new Error('Keep every prepared row and its ID. Use Exclude=Yes instead of deleting rows.');
    return{batch,rows};
  }
  function nextNumber(owner,manifest,uploads){
    return 1+Math.max(0,...manifest.files.filter(f=>(f.uploader||f.contributor)===owner).map(f=>Number(f.number)||0),...Object.values(uploads.raw).filter(f=>f.contributor===owner).map(f=>Number(f.number)||0),...Object.values(uploads.published||{}).filter(f=>f.published_by===owner).map(f=>Number(f.number)||0));
  }
  return{normalize,validURL,rawCheck,classifiedCheck,nextNumber};
})();
if(typeof module!=='undefined')module.exports=WorkspaceCore;
else (() => {
  const REPOSITORY='saad7z/NLP-Arabic-Sentiment-Project-Team-2',ROOT='https://api.github.com/repos/'+REPOSITORY;
  const $=id=>document.getElementById(id);
  const state={token:'',user:null,manifest:{schema:1,files:[]},owner:'all',busy:false,pending:null,shared:[],visible:100};
  function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
  function busy(value){state.busy=value;for(const id of ['upload-raw','publish','refresh','connection','view-shared'])$(id).disabled=value;}
  async function run(job){busy(true);try{await job();}catch(error){status(error.message,true);}finally{busy(false);}}
  async function api(path,method='GET',body){
    const url=path==='/user'?'https://api.github.com/user':ROOT+path;
    const response=await fetch(url,{method,headers:{Authorization:'Bearer '+state.token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
    const data=await response.json();
    if(!response.ok){const error=new Error((response.status===401?'The token has expired or is invalid. ':response.status===403?'Check repository access and token permissions. ':'')+(data.message||'GitHub request failed.'));error.status=response.status;throw error;}
    return data;
  }
  async function read(path,ref){
    const file=await api('/contents/'+path.split('/').map(encodeURIComponent).join('/')+(ref?'?ref='+encodeURIComponent(ref):''));
    if(file.type!=='file')throw new Error('The repository file is unavailable: '+path);
    const content=file.encoding==='base64'?file:await api('/git/blobs/'+encodeURIComponent(file.sha));
    if(content.encoding!=='base64')throw new Error('The repository file is unavailable: '+path);
    return{bytes:FileTools.bytes64(content.content),sha:file.sha};
  }
  async function json(path,ref,fallback){try{return JSON.parse(FileTools.decoder.decode((await read(path,ref)).bytes));}catch(error){if(error.status===404&&fallback!==undefined)return fallback;throw error;}}
  function connectNeeded(job){if(state.user)return run(job);state.pending=job;$('connect-error').textContent='';$('connect-dialog').showModal();$('token').focus();}
  async function connect(){
    const token=$('token').value.trim();if(!token){$('connect-error').textContent='Enter your GitHub token.';return;}
    $('connect-submit').disabled=true;state.token=token;
    try{
      const [repository,user]=await Promise.all([api(''),api('/user')]);
      if(repository.full_name!==REPOSITORY||!repository.permissions?.push)throw new Error('Your account needs write access to this repository.');
      state.user=user;$('token').value='';$('connection').textContent=user.login+' · Disconnect';$('connect-dialog').close();
      await refresh();const pending=state.pending;state.pending=null;if(pending)await run(pending);else status('Connected as '+user.login+'.');
    }catch(error){state.token='';state.user=null;$('connection').textContent='Connect';$('connect-error').textContent=error.message;if(!$('connect-dialog').open)$('connect-dialog').showModal();}
    finally{$('connect-submit').disabled=false;}
  }
  async function refresh(){
    state.manifest=await json('data/state/files.json',undefined,{schema:1,files:[]});
    if(!Array.isArray(state.manifest.files))throw new Error('The file index is invalid.');
    renderFiles();
  }
  function safeAvatar(url){try{const parsed=new URL(url);return ['avatars.githubusercontent.com','github.com'].includes(parsed.hostname)&&parsed.protocol==='https:'?parsed.href:'';}catch{return '';}}
  function renderFiles(){
    const people=new Map();for(const file of state.manifest.files){const owner=file.uploader||file.contributor;people.set(owner,{name:file.name||owner,avatar:file.avatar});}
    if(state.owner!=='all'&&!people.has(state.owner))state.owner='all';
    $('filters').replaceChildren();
    for(const [owner,person] of [['all',{name:'All'}],...Array.from(people).sort((a,b)=>a[0].localeCompare(b[0]))]){
      const button=document.createElement('button');button.type='button';button.dataset.owner=owner;button.setAttribute('aria-pressed',String(state.owner===owner));
      if(person.avatar&&safeAvatar(person.avatar)){const image=document.createElement('img');image.src=safeAvatar(person.avatar);image.alt='';image.addEventListener('error',()=>image.remove(),{once:true});button.append(image);}
      const label=document.createElement('span');label.textContent=person.name;button.append(label);
      button.addEventListener('click',()=>{state.owner=owner;renderFiles();});$('filters').append(button);
    }
    const files=state.manifest.files.filter(file=>state.owner==='all'||(file.uploader||file.contributor)===state.owner).sort((a,b)=>String(b.uploaded_at).localeCompare(String(a.uploaded_at))||b.filename.localeCompare(a.filename));
    $('file-list').replaceChildren();
    for(const file of files){
      const item=document.createElement('li'),info=document.createElement('div'),name=document.createElement('div'),meta=document.createElement('div'),actions=document.createElement('div');
      name.className='file-name';name.textContent=file.filename+'.xlsx';meta.className='file-meta';
      meta.textContent=file.stage+' · '+file.rows+(file.rows===1?' example · ':' examples · ')+new Date(file.uploaded_at).toLocaleString();info.append(name,meta);actions.className='file-actions';
      for(const format of ['xlsx','csv']){const button=document.createElement('button');button.type='button';button.textContent=format==='xlsx'?'Excel':'CSV';button.setAttribute('aria-label','Download '+file.filename+' as '+(format==='xlsx'?'Excel':'CSV'));button.addEventListener('click',()=>run(()=>downloadFile(file,format)));actions.append(button);}
      name.tabIndex=0;name.setAttribute('role','button');name.setAttribute('aria-label','Download '+file.filename+' as Excel');name.addEventListener('click',()=>run(()=>downloadFile(file,'xlsx')));name.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();run(()=>downloadFile(file,'xlsx'));}});
      item.append(info,actions);$('file-list').append(item);
    }
    if(!files.length){const item=document.createElement('li');item.className='empty';item.textContent='No prepared files yet. Upload a raw file to begin.';$('file-list').append(item);}
  }
  function download(bytes,filename,type){const url=URL.createObjectURL(new Blob([bytes],{type})),link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  async function downloadFile(file,format){
    const contents=await read(file.path),parsed=/\.xlsx$/i.test(file.path)?await FileTools.parseXlsx(contents.bytes):FileTools.parseCSV(FileTools.decoder.decode(contents.bytes));
    const rows=parsed.records.map(row=>({...row,Contributor:file.contributor,Batch:file.batch,ImportedAt:file.imported_at}));
    const bytes=format==='xlsx'?await FileTools.excel(FileTools.annotation,rows):FileTools.encoder.encode(FileTools.csv(FileTools.annotation,rows));
    download(bytes,file.filename+'.'+format,format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv;charset=utf-8');status('Downloaded '+file.filename+'.'+format+'.');
  }
  const emptyUploads=()=>({schema:1,raw:{},published:{}});
  async function commitFiles(build,message){
    for(let attempt=0;attempt<4;attempt++){
      const ref=await api('/git/ref/heads/main'),head=ref.object.sha,commit=await api('/git/commits/'+head);
      const uploads=await json('data/state/uploads.json',head,emptyUploads());
      const manifest=await json('data/state/files.json',head,{schema:1,files:[]});
      const result=await build({head,uploads,manifest});if(result.done)return result;
      const treeEntries=[];
      for(const file of result.files){
        if(file.remove){treeEntries.push({path:file.path,mode:'100644',type:'blob',sha:null});continue;}
        if(file.bytes){const blob=await api('/git/blobs','POST',{content:FileTools.base64(file.bytes),encoding:'base64'});treeEntries.push({path:file.path,mode:'100644',type:'blob',sha:blob.sha});}
        else treeEntries.push({path:file.path,mode:'100644',type:'blob',content:file.text});
      }
      treeEntries.push({path:'data/state/uploads.json',mode:'100644',type:'blob',content:JSON.stringify(uploads,null,2)+'\n'});
      const tree=await api('/git/trees','POST',{base_tree:commit.tree.sha,tree:treeEntries});
      const author={name:state.user.name||state.user.login,email:state.user.id+'+'+state.user.login+'@users.noreply.github.com'};
      const created=await api('/git/commits','POST',{message,tree:tree.sha,parents:[head],author,committer:author});
      try{await api('/git/refs/heads/main','PATCH',{sha:created.sha,force:false});return result;}
      catch(error){if(![409,422].includes(error.status))throw error;}
    }
    throw new Error('The repository kept changing. Your file was not published. Try again.');
  }
  async function uploadRaw(file,parsed){
    const config=await json('config/columns.json');WorkspaceCore.rawCheck(parsed,config);
    const id=crypto.randomUUID(),user=state.user,uploadedAt=new Date().toISOString();
    status('Uploading '+file.name+'…');
    const result=await commitFiles(async({head,uploads,manifest})=>{
      const existing=Object.entries(uploads.raw).find(([,meta])=>meta.upload_id===id);if(existing)return{done:true,raw:existing[0]};
      const number=WorkspaceCore.nextNumber(user.login,manifest,uploads),extension=/\.xlsx$/i.test(file.name)?'xlsx':'csv';
      const raw=user.login+'_raw_'+number+'.'+extension;
      // Check the filename against this exact commit before reserving its number.
      try{await read('data/raw/'+raw,head);throw new Error('The next raw filename already exists. Refresh the workspace before uploading.');}catch(error){if(error.status!==404)throw error;}
      uploads.raw[raw]={contributor:user.login,name:user.name||user.login,avatar:user.avatar_url,number,uploaded_at:uploadedAt,original_name:file.name,upload_id:id};
      return{raw,files:[{path:'data/raw/'+raw,bytes:parsed.bytes}]};
    },'Upload raw data: '+user.login);
    status('Uploaded. Preparing the file…');await waitForFile(file=>file.batch===result.raw.replace(/\.(csv|xlsx)$/i,''),'Your raw file is uploaded. Preparation is still running; use Refresh shortly.');
  }
  async function publishClassified(file,parsed){
    const catalog=await json('data/state/catalog.json'),checked=WorkspaceCore.classifiedCheck(parsed,catalog),batch=checked.batch;
    const paths=(await api('/contents/data/work')).filter(entry=>entry.type==='file'&&entry.name.replace(/\.(csv|xlsx)$/i,'')===batch);
    const baseline=new Map(paths.map(entry=>[entry.path,entry.sha]));
    const user=state.user,publishedAt=new Date().toISOString(),id=crypto.randomUUID();
    status('Publishing '+file.name+'…');
    await commitFiles(async({head,uploads,manifest})=>{
      if(uploads.published[batch]?.upload_id===id)return{done:true};
      const current=(await api('/contents/data/work?ref='+head)).filter(entry=>entry.type==='file'&&entry.name.replace(/\.(csv|xlsx)$/i,'')===batch);
      if(current.length!==baseline.size||current.some(entry=>baseline.get(entry.path)!==entry.sha))throw new Error('Another member updated this batch. Download its latest classified file and try again.');
      const previous=uploads.published[batch];
      const number=previous?.published_by===user.login&&previous.number?previous.number:WorkspaceCore.nextNumber(user.login,manifest,uploads);
      uploads.published[batch]={published_at:publishedAt,published_by:user.login,name:user.name||user.login,avatar:user.avatar_url,number,upload_id:id};
      const path='data/work/'+batch+'.csv';
      return{files:[...current.filter(entry=>entry.path!==path).map(entry=>({path:entry.path,remove:true})),{path,text:FileTools.csv(FileTools.work,checked.rows)}]};
    },'Publish classified batch: '+batch);
    status('Published. Updating the shared table…');await waitForFile(file=>file.batch===batch&&file.stage==='Classified'&&file.uploaded_at===publishedAt,'Your classified file is saved. The shared table is still updating; use Refresh shortly.');
    if(!$('shared-panel').hidden)await viewShared();
  }
  async function waitForFile(matches,pendingMessage){
    for(let i=0;i<24;i++){await refresh();if(state.manifest.files.some(matches)){status('Ready. The file is listed below.');return;}await new Promise(resolve=>setTimeout(resolve,4000));}
    status(pendingMessage);
  }
  async function viewShared(){
    const parsed=FileTools.parseCSV(FileTools.decoder.decode((await read('data/shared/dataset.csv')).bytes));state.shared=parsed.records;state.visible=100;
    $('shared-panel').hidden=false;$('shared-count').textContent=state.shared.length+(state.shared.length===1?' example':' examples');
    const header=document.createElement('tr');for(const name of parsed.headers){const th=document.createElement('th');th.scope='col';th.textContent=name;header.append(th);}$('shared-head').replaceChildren(header);renderShared(parsed.headers);
    status(state.shared.length?'Shared table loaded.':'No classified files have been published yet.');
  }
  function renderShared(headers=FileTools.shared){
    $('shared-body').replaceChildren();for(const row of state.shared.slice(0,state.visible)){const tr=document.createElement('tr');for(const name of headers){const td=document.createElement('td');td.textContent=row[name]||'';if(name==='Text')td.dir='auto';tr.append(td);}$('shared-body').append(tr);}
    $('more-rows').hidden=state.visible>=state.shared.length;
  }
  async function sharedDownload(format){
    const file=await read('data/shared/dataset.'+format);download(file.bytes,'team_shared.'+format,format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv;charset=utf-8');status('Downloaded team_shared.'+format+'.');
  }
  function choose(input,handler){
    $(input).addEventListener('change',async()=>{const file=$(input).files[0];$(input).value='';if(!file)return;await run(async()=>{const parsed=await FileTools.parseFile(file);await connectNeeded(()=>handler(file,parsed));});});
  }
  $('upload-raw').addEventListener('click',()=>$('raw-file').click());
  $('publish').addEventListener('click',()=>$('classified-file').click());
  choose('raw-file',uploadRaw);choose('classified-file',publishClassified);
  $('connection').addEventListener('click',()=>{
    if(!state.user){connectNeeded(()=>refresh());return;}
    state.token='';state.user=null;state.pending=null;state.owner='all';state.manifest={schema:1,files:[]};$('token').value='';$('connection').textContent='Connect';$('shared-panel').hidden=true;state.shared=[];renderFiles();$('file-list').firstChild.textContent='Connect to view the team\'s files.';status('Disconnected.');
  });
  $('connect-submit').addEventListener('click',connect);$('token').addEventListener('keydown',event=>{if(event.key==='Enter')connect();});
  $('connect-cancel').addEventListener('click',()=>{state.pending=null;$('token').value='';$('connect-dialog').close();});
  $('connect-dialog').addEventListener('cancel',()=>{state.pending=null;$('token').value='';});
  $('refresh').addEventListener('click',()=>connectNeeded(()=>refresh()));$('view-shared').addEventListener('click',()=>connectNeeded(viewShared));
  $('close-shared').addEventListener('click',()=>$('shared-panel').hidden=true);$('more-rows').addEventListener('click',()=>{state.visible+=100;renderShared();});
  for(const format of ['xlsx','csv'])$('shared-'+(format==='xlsx'?'excel':'csv')).addEventListener('click',()=>run(()=>sharedDownload(format)));
})();
