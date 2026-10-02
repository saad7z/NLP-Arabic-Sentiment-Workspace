'use strict';
// CSV and OOXML support. Workbooks use the checked-in, plain Excel templates.
const DataFiles = (() => {
  const work = ['ID','Text','Sentiment','Source','SourceURL','Exclude','Notes'];
  const annotation = [...work,'Contributor','Batch','ImportedAt'];
  const shared = [...annotation,'Flags'];
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8',{fatal:true});
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  function parseCSV(input) {
    const source=String(input).replace(/^\uFEFF/,'');
    if(!source.trim())throw new Error('The file is empty.');
    const first=source.split(/\r?\n/)[0];
    const delimiter=[',',';','\t'].sort((a,b)=>first.split(b).length-first.split(a).length)[0];
    const rows=[];let row=[],cell='',quoted=false,closed=false;
    for(let i=0;i<source.length;i++){
      const c=source[i];
      if(quoted){if(c==='"'){if(source[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;}
      else if(c==='"'&&cell===''&&!closed)quoted=true;
      else if(c===delimiter){row.push(cell);cell='';closed=false;}
      else if(c==='\n'||c==='\r'){if(c==='\r'&&source[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x!==''))rows.push(row);row=[];cell='';closed=false;}
      else{if(closed)throw new Error('Invalid CSV: text after a closing quote.');cell+=c;}
    }
    if(quoted)throw new Error('Invalid CSV: an unclosed quote.');
    row.push(cell);if(row.some(x=>x!==''))rows.push(row);
    return fromRows(rows);
  }
  function fromRows(rows){
    if(!rows.length)throw new Error('The file is empty.');
    const headers=rows[0].map(x=>String(x??'').trim());
    if(headers.some(x=>!x)||new Set(headers).size!==headers.length)throw new Error('Column names must be unique and non-empty.');
    if(rows.length>10001)throw new Error('Use at most 10,000 examples per file.');
    const records=rows.slice(1).filter(row=>row.some(v=>String(v??'')!=='')).map((values,i)=>{
      if(values.length!==headers.length)throw new Error('Wrong column count at row '+(i+2)+'.');
      return Object.fromEntries(headers.map((header,j)=>[header,String(values[j]??'')]));
    });
    return{headers,records};
  }
  function csv(headers,rows){
    const quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';
    return '\uFEFF'+[headers.map(quote).join(','),...rows.map(row=>headers.map(h=>quote(row[h])).join(','))].join('\r\n')+'\r\n';
  }
  function base64(bytes){let result='';for(let i=0;i<bytes.length;i+=8192)result+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(result);}
  function bytes64(value){return Uint8Array.from(atob(value.replace(/\s/g,'')),c=>c.charCodeAt(0));}
  function xml(value){return String(value??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');}
  function column(index){let name='';for(index++;index;index=Math.floor((index-1)/26))name=String.fromCharCode(65+(index-1)%26)+name;return name;}
  async function unzip(bytes){
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),files={};
    let end=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50){end=i;break;}
    if(end<0)throw new Error('Invalid Excel file. Use .xlsx or CSV UTF-8.');
    const count=view.getUint16(end+10,true);let offset=view.getUint32(end+16,true),total=0;
    if(count>1000)throw new Error('The workbook has too many parts.');
    for(let i=0;i<count;i++){
      if(view.getUint32(offset,true)!==0x02014b50)throw new Error('Invalid Excel directory.');
      const flags=view.getUint16(offset+8,true),method=view.getUint16(offset+10,true),size=view.getUint32(offset+20,true),uncompressed=view.getUint32(offset+24,true);
      const nameLen=view.getUint16(offset+28,true),extraLen=view.getUint16(offset+30,true),commentLen=view.getUint16(offset+32,true),start=view.getUint32(offset+42,true);
      const name=decoder.decode(bytes.subarray(offset+46,offset+46+nameLen));
      total+=uncompressed;if(total>50*1024*1024||flags&1)throw new Error('The workbook is encrypted or too large.');
      if(view.getUint32(start,true)!==0x04034b50)throw new Error('Invalid Excel part.');
      const dataStart=start+30+view.getUint16(start+26,true)+view.getUint16(start+28,true);
      let content=bytes.slice(dataStart,dataStart+size);
      if(method===8){
        if(typeof DecompressionStream==='undefined')throw new Error('This browser cannot read compressed Excel files. Upload CSV UTF-8 instead.');
        content=new Uint8Array(await new Response(new Blob([content]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      }else if(method!==0)throw new Error('Unsupported Excel compression.');
      if(content.length!==uncompressed)throw new Error('The Excel part is damaged.');
      files[name]=content;offset+=46+nameLen+extraLen+commentLen;
    }
    return files;
  }
  function parseXML(bytes){const doc=new DOMParser().parseFromString(decoder.decode(bytes),'application/xml');if(doc.querySelector('parsererror'))throw new Error('Invalid workbook XML.');return doc;}
  async function parseXlsx(bytes){
    const files=await unzip(bytes),workbook=parseXML(files['xl/workbook.xml']),rels=parseXML(files['xl/_rels/workbook.xml.rels']);
    const sheet=Array.from(workbook.getElementsByTagNameNS(ns,'sheet')).find(x=>x.getAttribute('state')!=='hidden');
    if(!sheet)throw new Error('The workbook has no visible sheet.');
    const id=sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id');
    const relation=Array.from(rels.getElementsByTagName('Relationship')).find(x=>x.getAttribute('Id')===id);
    if(!relation||relation.getAttribute('TargetMode')==='External')throw new Error('Invalid Excel sheet link.');
    const path=new URL(relation.getAttribute('Target'),'https://workbook.test/xl/').pathname.slice(1);
    const doc=parseXML(files[path]);
    if(doc.getElementsByTagNameNS(ns,'f').length)throw new Error('Use plain values in the data sheet. Formulas are not accepted.');
    const strings=files['xl/sharedStrings.xml']?Array.from(parseXML(files['xl/sharedStrings.xml']).getElementsByTagNameNS(ns,'si')).map(si=>Array.from(si.getElementsByTagNameNS(ns,'t')).map(t=>t.textContent).join('')):[];
    const rows=Array.from(doc.getElementsByTagNameNS(ns,'row')).map(row=>{
      const values=[];
      for(const cell of row.getElementsByTagNameNS(ns,'c')){
        const letters=(cell.getAttribute('r')||'').replace(/[0-9]/g,'');let index=0;
        for(const letter of letters)index=index*26+letter.charCodeAt(0)-64;
        if(!index||index>100)throw new Error('Unsupported data sheet layout.');
        const value=cell.getElementsByTagNameNS(ns,'v')[0]?.textContent||'';
        values[index-1]=cell.getAttribute('t')==='s'?(strings[Number(value)]??''):cell.getAttribute('t')==='inlineStr'?Array.from(cell.getElementsByTagNameNS(ns,'t')).map(t=>t.textContent).join(''):value;
      }
      return values;
    });
    const width=rows[0]?.length||0;
    const parsed=fromRows(rows.map(row=>Array.from({length:width},(_,i)=>row[i]??'')));
    for(const row of parsed.records)if(row.ImportedAt&&/^\d+(\.\d+)?$/.test(row.ImportedAt))row.ImportedAt=new Date(Math.round((Number(row.ImportedAt)-25569)*86400000)).toISOString();
    return parsed;
  }
  async function parseFile(file){
    if(!file||file.size>25*1024*1024)throw new Error('Use a CSV or .xlsx file smaller than 25 MB.');
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(/\.csv$/i.test(file.name))return{...parseCSV(decoder.decode(bytes)),bytes};
    if(/\.xlsx$/i.test(file.name))return{...await parseXlsx(bytes),bytes};
    throw new Error('Use CSV UTF-8 or .xlsx.');
  }
  function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
  function concat(parts){const output=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const p of parts){output.set(p,offset);offset+=p.length;}return output;}
  function zip(files){
    const parts=[],directory=[];let offset=0;
    for(const [filename,data] of Object.entries(files)){
      const name=encoder.encode(filename),crc=crc32(data),local=new Uint8Array(30+name.length+data.length),view=new DataView(local.buffer);
      view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x800,true);view.setUint16(12,33,true);
      view.setUint32(14,crc,true);view.setUint32(18,data.length,true);view.setUint32(22,data.length,true);view.setUint16(26,name.length,true);
      local.set(name,30);local.set(data,30+name.length);parts.push(local);
      const central=new Uint8Array(46+name.length),cv=new DataView(central.buffer);
      cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x800,true);cv.setUint16(14,33,true);
      cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);
      central.set(name,46);directory.push(central);offset+=local.length;
    }
    const dir=concat(directory),end=new Uint8Array(22),ev=new DataView(end.buffer);
    ev.setUint32(0,0x06054b50,true);ev.setUint16(8,directory.length,true);ev.setUint16(10,directory.length,true);ev.setUint32(12,dir.length,true);ev.setUint32(16,offset,true);
    return concat([...parts,dir,end]);
  }
  const templates=new Map();
  async function excel(headers,rows,type='annotation'){
    if(!templates.has(type)){
      const response=await fetch('templates/'+type+'.xlsx',{credentials:'omit'});
      if(!response.ok)throw new Error('The Excel template is unavailable.');
      templates.set(type,await unzip(new Uint8Array(await response.arrayBuffer())));
    }
    const files={...templates.get(type)},doc=parseXML(files['xl/worksheets/sheet1.xml']),sheet=doc.documentElement;
    const data=doc.getElementsByTagNameNS(ns,'sheetData')[0];
    const oldCells=Array.from(data.getElementsByTagNameNS(ns,'c'));
    const style=address=>oldCells.find(cell=>cell.getAttribute('r')===address)?.getAttribute('s')||'0';
    const headerStyle=style('A1'),bodyStyle=style('A2'),dateStyle=style('J2');data.replaceChildren();
    [Object.fromEntries(headers.map(h=>[h,h])),...rows].forEach((record,i)=>{
      const row=doc.createElementNS(ns,'row');row.setAttribute('r',String(i+1));
      headers.forEach((header,j)=>{
        const cell=doc.createElementNS(ns,'c');cell.setAttribute('r',column(j)+(i+1));cell.setAttribute('s',i===0?headerStyle:bodyStyle);
        const value=String(record[header]??'');
        if(i>0&&header==='ID'&&/^\d+$/.test(value)){const v=doc.createElementNS(ns,'v');v.textContent=value;cell.append(v);}
        else if(i>0&&header==='ImportedAt'&&value&&!Number.isNaN(Date.parse(value))){cell.setAttribute('s',dateStyle);const v=doc.createElementNS(ns,'v');v.textContent=String(Date.parse(value)/86400000+25569);cell.append(v);}
        else{cell.setAttribute('t','inlineStr');const is=doc.createElementNS(ns,'is'),t=doc.createElementNS(ns,'t');t.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');t.textContent=value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');is.append(t);cell.append(is);}
        row.append(cell);
      });data.append(row);
    });
    const end=column(headers.length-1)+Math.max(2,rows.length+1);doc.getElementsByTagNameNS(ns,'dimension')[0]?.setAttribute('ref','A1:'+end);
    let filter=doc.getElementsByTagNameNS(ns,'autoFilter')[0];
    if(!filter){filter=doc.createElementNS(ns,'autoFilter');sheet.insertBefore(filter,doc.getElementsByTagNameNS(ns,'dataValidations')[0]||doc.getElementsByTagNameNS(ns,'pageMargins')[0]||null);}
    filter.setAttribute('ref','A1:'+end);
    for(const rule of doc.getElementsByTagNameNS(ns,'dataValidation')){rule.setAttribute('showDropDown','0');rule.setAttribute('showErrorMessage','1');rule.setAttribute('errorStyle','stop');}
    files['xl/worksheets/sheet1.xml']=encoder.encode(new XMLSerializer().serializeToString(doc));
    return zip(files);
  }
  return{work,annotation,shared,parseCSV,parseXlsx,parseFile,csv,base64,bytes64,excel,unzip,zip,xml,column,encoder,decoder};
})();
if(typeof module!=='undefined')module.exports=DataFiles;
else globalThis.DataFiles=DataFiles;
